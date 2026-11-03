import type { BufferClient, BufferPost, PostLookup } from './buffer.js';
import { hasReviewBlock, ownerReviewedRights } from './rights.js';
import { toBufferDueAt } from './schedule.js';
import type { Candidate, ScheduledPost } from './types.js';
import type { SyncResult } from './api-contract.js';

/**
 * Buffer approval synchronisation, shared by the Worker (D1) and the pipeline CLI (JSON/API store).
 *
 * Guarantees:
 *  - YouTube and TikTok posts are reconciled independently; a candidate's status is derived from ALL its posts,
 *    so a rejected TikTok draft never invalidates an approved YouTube draft.
 *  - "Not found" from Buffer must be observed on >= `confirmMisses` separate polls spread over >= `minMissIntervalMs`
 *    before a draft is considered deleted by the user. Transport / 5xx / 429 / GraphQL errors never change state;
 *    they are recorded in `sync_error` and reported.
 *  - Approved posts are pinned to their planned slot and the returned dueAt is verified.
 */
export interface SyncStore {
  listPendingPosts(): Promise<ScheduledPost[]>;
  savePost(p: ScheduledPost): Promise<void>;
  listPostsForCandidate(candidateId: string): Promise<ScheduledPost[]>;
  patchCandidate(id: string, patch: Partial<Candidate>): Promise<void>;
  getCandidate?(id: string): Promise<Pick<Candidate, 'rights_status'> | null>;
  logEvent?(kind: string, refId: string | null, detail: unknown): Promise<void>;
}

export interface SyncOptions {
  tz: string;
  now?: () => Date;
  confirmMisses?: number;      // default 2
  minMissIntervalMs?: number;  // default 10 minutes
  replacementLeadMs?: number;  // only slots further out than this get a replacement (default 3 h)
}

export type BufferClientLike = Pick<BufferClient, 'lookupPosts' | 'reschedulePost'> & Partial<Pick<BufferClient, 'editPost'>>;

export const PENDING_STATES: ScheduledPost['state'][] = ['draft', 'needs_approval', 'scheduled', 'sending'];

export async function runSync(client: BufferClientLike, store: SyncStore, opts: SyncOptions): Promise<SyncResult> {
  const now = opts.now ?? (() => new Date());
  const confirmMisses = opts.confirmMisses ?? 2;
  const minMissInterval = opts.minMissIntervalMs ?? 10 * 60_000;
  const lead = opts.replacementLeadMs ?? 3 * 3600_000;

  const pending = (await store.listPendingPosts()).filter((p) => p.buffer_post_id && PENDING_STATES.includes(p.state));
  const result: SyncResult = { checked: pending.length, approved: 0, rejected: 0, published: 0, errors: [], replacements_needed: 0 };
  if (pending.length === 0) return result;

  let lookups: Map<string, PostLookup>;
  try {
    lookups = await client.lookupPosts(pending.map((p) => p.buffer_post_id!));
  } catch (e) {
    // whole request failed (network, 5xx, 429 after retries): nothing changes
    const msg = `buffer unreachable: ${(e as Error).message}`;
    const ts = now().toISOString();
    for (const p of pending) { p.sync_error = msg; p.last_synced_at = ts; await store.savePost(p); }
    result.errors.push({ post_id: '*', error: msg });
    await store.logEvent?.('sync_error', null, { error: msg, posts: pending.length });
    return result;
  }

  const touchedCandidates = new Set<string>();
  for (const p of pending) {
    const ts = now().toISOString();
    const lk = lookups.get(p.buffer_post_id!) ?? { status: 'error', message: 'no lookup result' } as PostLookup;
    p.last_synced_at = ts;

    if (lk.status === 'error') {
      p.sync_error = lk.message;
      result.errors.push({ post_id: p.buffer_post_id!, error: lk.message });
      await store.savePost(p);
      continue;
    }

    if (lk.status === 'not_found') {
      p.missing_count = (p.missing_count ?? 0) + 1;
      p.missing_since = p.missing_since ?? ts;
      const elapsed = Date.parse(ts) - Date.parse(p.missing_since);
      const confirmed = p.missing_count >= confirmMisses && elapsed >= minMissInterval;
      if (!confirmed) {
        p.sync_error = `not found in Buffer (${p.missing_count}/${confirmMisses}, awaiting confirmation)`;
        await store.savePost(p);
        continue;
      }
      const wasPending = p.state === 'draft' || p.state === 'needs_approval';
      p.state = 'deleted';
      p.sync_error = null;
      if (wasPending) {
        result.rejected++;
        if (Date.parse(p.slot_at) > now().getTime() + lead) result.replacements_needed++;
        await store.logEvent?.('rejected', p.id, { service: p.service, slot_at: p.slot_at });
      } else {
        p.buffer_error = 'post vanished after approval';
        result.errors.push({ post_id: p.buffer_post_id!, error: p.buffer_error });
        await store.logEvent?.('vanished', p.id, { service: p.service, slot_at: p.slot_at, previous: p.state });
      }
      await store.savePost(p);
      touchedCandidates.add(p.candidate_id);
      continue;
    }

    // found
    const bp = lk.post;
    p.missing_count = 0;
    p.missing_since = null;
    p.sync_error = null;
    const r = reconcileFound(p, bp);
    const prevState = p.state;
    p.state = r.state;
    p.buffer_error = r.error;
    if (r.approved) {
      result.approved++;
      await store.logEvent?.('approved', p.id, { service: p.service, slot_at: p.slot_at, buffer_dueAt: bp.dueAt });
    }
    if (r.needsReschedule) {
      try {
        const moved = await client.reschedulePost(p.buffer_post_id!, toBufferDueAt(p.slot_at, opts.tz));
        const ok = !!moved.dueAt && Math.abs(Date.parse(moved.dueAt) - Date.parse(p.slot_at)) <= 60_000;
        if (!ok) {
          const err = `reschedule verification failed: Buffer dueAt ${moved.dueAt} != slot ${p.slot_at}`;
          p.sync_error = err;
          result.errors.push({ post_id: p.buffer_post_id!, error: err });
        } else {
          await store.logEvent?.('rescheduled', p.id, { from: bp.dueAt, to: moved.dueAt });
        }
      } catch (e) {
        const err = `reschedule failed: ${(e as Error).message}`;
        p.sync_error = err;
        result.errors.push({ post_id: p.buffer_post_id!, error: err });
      }
    }
    // Transformation-review drafts: once approved, record the owner's decision (approval metadata). Review information
    // lives in the readiness report and Buffer tags, never in captions; the strip below is a safety net for any
    // caption that still carries internal review text (legacy drafts) and is retried every poll until clean.
    const approvedNow = r.approved || (p.state === 'scheduled' && p.reuse_uncertain && !p.review_block_stripped);
    if (approvedNow && p.reuse_uncertain) {
      if (r.approved) {
        const evidence = `Owner approved Buffer ${p.service} post ${p.buffer_post_id} at ${ts} (transformation review)`;
        const cand = (await store.getCandidate?.(p.candidate_id)) ?? { rights_status: 'transformation_review' as const };
        const rights = ownerReviewedRights(cand, evidence);
        if (rights) await store.patchCandidate(p.candidate_id, rights);
        await store.logEvent?.('owner_reviewed', p.id, { candidate: p.candidate_id, evidence });
      }
      if (!p.review_block_stripped && hasReviewBlock(bp.text) && p.public_text && client.editPost) {
        try {
          const edited = await client.editPost(p.buffer_post_id!, { text: p.public_text });
          if (hasReviewBlock(edited.text)) throw new Error('review note still present after edit');
          p.review_block_stripped = true;
          await store.logEvent?.('review_block_stripped', p.id, {});
        } catch (e) {
          const err = `strip review note failed: ${(e as Error).message}`;
          p.sync_error = err;
          result.errors.push({ post_id: p.buffer_post_id!, error: err });
        }
      } else if (!hasReviewBlock(bp.text)) {
        p.review_block_stripped = true;
      }
    }
    if (r.published) result.published++;
    if (r.error) result.errors.push({ post_id: p.buffer_post_id!, error: r.error });
    await store.savePost(p);
    if (prevState !== p.state) touchedCandidates.add(p.candidate_id);
  }

  for (const cid of touchedCandidates) {
    const posts = await store.listPostsForCandidate(cid);
    const status = deriveCandidateStatus(posts);
    if (status) await store.patchCandidate(cid, { status, status_reason: describePosts(posts) });
  }
  // a scheduled review post that still carries the note: keep it visible as an error until stripped
  for (const p of pending) if (p.state === 'scheduled' && p.reuse_uncertain && !p.review_block_stripped && !result.errors.some((e) => e.post_id === p.buffer_post_id)) {
    result.errors.push({ post_id: p.buffer_post_id!, error: 'approved review post still carries the review note' });
  }
  return result;
}

function reconcileFound(ours: Pick<ScheduledPost, 'state' | 'slot_at'>, theirs: BufferPost) {
  const s = (theirs.status ?? '').toLowerCase() as ScheduledPost['state'];
  const wasPending = ours.state === 'draft' || ours.state === 'needs_approval';
  const approved = wasPending && (s === 'scheduled' || s === 'sending' || s === 'sent');
  const published = s === 'sent';
  const needsReschedule = approved && s === 'scheduled' && !!theirs.dueAt && Math.abs(Date.parse(theirs.dueAt) - Date.parse(ours.slot_at)) > 60_000;
  const error = s === 'error' ? theirs.error?.message ?? 'Buffer reported an error' : null;
  return { state: s, approved, published, needsReschedule, error };
}

/** Candidate status from the union of its posts (per-service independence). Returns null when nothing can be said. */
export function deriveCandidateStatus(posts: ScheduledPost[]): Candidate['status'] | null {
  const live = posts.filter((p) => p.state !== 'deleted');
  if (posts.length === 0) return null;
  if (posts.some((p) => p.state === 'sent')) return 'published';
  if (posts.some((p) => p.state === 'scheduled' || p.state === 'sending')) return 'approved';
  if (live.length === 0) return 'rejected_user';
  return 'drafted';
}

function describePosts(posts: ScheduledPost[]): string {
  return posts.map((p) => `${p.service}:${p.state}`).join(', ');
}
