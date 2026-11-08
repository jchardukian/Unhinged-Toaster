import { AUTOPILOT_AUTHORIZATION_PHRASE, BufferApiError, BufferClient, buildWeekPlan, creditText, hasReviewBlock, toBufferDueAt, ulid, unattendedEligible, type BufferService, type Candidate, type Production, type ScheduledPost, type SlotPlan } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { isTransient, withRetry } from '../retry.js';
import type { Store } from '../store.js';
import { unpostedProductions } from './produce.js';

export const YOUTUBE_CATEGORY_COMEDY = '23';
/** Minimum lead before a slot for an autopilot-scheduled post (no owner approval step; Buffer fetches the video). */
export const UNATTENDED_MIN_LEAD_HOURS = 2;

export function bufferClient(cfg: Config): BufferClient {
  if (!cfg.bufferKey) throw new Error('BUFFER_API_KEY not set (Buffer > Settings > API)');
  return new BufferClient({ apiKey: cfg.bufferKey });
}

export function channelFor(cfg: Config, service: BufferService): string {
  return service === 'youtube' ? cfg.bufferYoutubeChannelId : cfg.bufferTiktokChannelId;
}

/**
 * PUBLIC caption/description: caption, creator credit + source + edit summary + contact e-mail, hashtags, AI-voice
 * disclosure when a synthetic voice was used. Internal review information is never part of it (guarded).
 */
export function postText(p: Production, c: Candidate | null, service: BufferService, opts: { contactEmail?: string } = {}): string {
  const tags = (JSON.parse(p.hashtags) as string[]).map((t) => `#${t}`).join(' ');
  const credit = c ? creditText(c, { contactEmail: opts.contactEmail }) : (p.caption_text.includes('🎬') ? '' : `📩 Copyright inquiries, credit corrections or removal requests: ${opts.contactEmail ?? 'theunhingedtoaster@gmail.com'}`);
  const usedVoice = !!p.voice_id || /"vo":true/.test(p.render_log ?? '');
  const parts = [p.caption_text, credit, tags, usedVoice ? 'Commentary voice is AI-generated.' : ''];
  const text = parts.filter(Boolean).join('\n\n').slice(0, service === 'tiktok' ? 2100 : 4900);
  if (hasReviewBlock(text) || /REVIEW BEFORE APPROVING|transformation review/i.test(text)) throw new Error('internal review text must never reach a public caption');
  return text;
}

/** Draft text is the public text; review status is carried by Buffer tags + the readiness report, not the caption. */
export function draftText(p: Production, c: Candidate | null, service: BufferService, contactEmail?: string): { text: string; publicText: string; uncertain: boolean } {
  const publicText = postText(p, c, service, { contactEmail });
  const uncertain = p.reuse_basis === 'review' || (c != null && c.rights_status !== 'cleared');
  return { text: publicText, publicText, uncertain };
}

export interface PublishOptions {
  dryRun?: boolean;
  client?: BufferClient;            // injected in tests
  now?: () => Date;
  /** Weeks to fill: current week (future slots only) and next week by default. */
  weeks?: ('current' | 'next')[];
  /** Minimum lead time before a slot for a draft to still be worth creating (owner needs time to approve). */
  minLeadHours?: number;
  /** pilot: draft at most this many productions (each becomes 2 posts) */
  limit?: number;
  /**
   * Unattended publishing: schedule (not draft) productions that pass the rights + QC gate. The caller must have checked
   * autopilotStatus().active; every decision is logged through `decide`. Productions that fail the gate are drafted
   * only when `reviewDrafts` is true, otherwise skipped (logged as 'skip').
   */
  unattended?: { active: true; minQc: number; reviewDrafts: boolean; fairUse: boolean; decide: (d: Omit<import('@toaster/shared').Decision, 'id' | 'at'>) => Promise<import('@toaster/shared').Decision> };
}

export interface PublishResult { created: number; adopted: number; skipped: number; failed: number; openSlots: number; weeks: string[] }

/**
 * Fill open slots with finished productions as Buffer DRAFTS. Idempotent and retryable:
 *  - a slot that already has a live post row with a Buffer id is skipped
 *  - before creating, Buffer is queried for a post already sitting at (channel, slot); if found it is adopted
 *  - creation is retried on transient errors, re-checking Buffer between attempts so a timed-out create never duplicates
 *  - one production feeds both the YouTube and the TikTok slot at the same instant
 */
export async function publishWeek(cfg: Config, store: Store, opts: PublishOptions = {}): Promise<PublishResult> {
  const now = opts.now ?? (() => new Date());
  const weeks = opts.weeks ?? ['current', 'next'];
  // drafts need owner time to approve (20 h); scheduled autopilot posts only need Buffer time to fetch the video
  const lead = (opts.minLeadHours ?? (opts.unattended ? UNATTENDED_MIN_LEAD_HOURS : 20)) * 3600_000;
  const result: PublishResult = { created: 0, adopted: 0, skipped: 0, failed: 0, openSlots: 0, weeks: [] };
  const client = opts.dryRun ? null : opts.client ?? bufferClient(cfg);
  let pool = (await unpostedProductions(store)).slice(0, opts.limit ?? Infinity);
  if (opts.unattended && !opts.unattended.reviewDrafts) {
    // An ineligible production would take a slot, be skipped, and leave that slot empty on every run. Skip it once,
    // logged, before slot assignment so eligible productions fill the slots.
    const kept: Production[] = [];
    for (const p of pool) {
      const cand = await store.getCandidate(p.candidate_id);
      const elig = cand ? unattendedEligible(cand, p, opts.unattended.minQc, { fairUse: opts.unattended.fairUse }) : { eligible: false, reasons: ['candidate record missing'] };
      if (elig.eligible) { kept.push(p); continue; }
      await opts.unattended.decide({ kind: 'skip', production_id: p.id, candidate_id: p.candidate_id, service: null, slot_at: null, buffer_post_id: null, reasons: JSON.stringify(elig.reasons), detail: JSON.stringify({ headline: p.headline }) });
      result.skipped++;
    }
    pool = kept;
  }

  for (const which of weeks) {
    const plan: SlotPlan = buildWeekPlan(now(), cfg.tz, cfg.publishSlots, ['youtube', 'tiktok'], which === 'current' ? 0 : 1);
    result.weeks.push(plan.week);
    const existing = await store.listPosts({ week: plan.week });
    const liveByKey = new Map(existing.filter((p) => p.state !== 'deleted' && p.buffer_post_id).map((p) => [`${p.slot_at}|${p.service}`, p]));
    const retryRows = new Map(existing.filter((p) => p.state !== 'deleted' && !p.buffer_post_id).map((p) => [`${p.slot_at}|${p.service}`, p]));
    const open = plan.slots.filter((s) => !liveByKey.has(`${s.slot_at}|${s.service}`) && Date.parse(s.slot_at) - now().getTime() >= lead);
    const byInstant = new Map<string, BufferService[]>();
    for (const s of open) byInstant.set(s.slot_at, [...(byInstant.get(s.slot_at) ?? []), s.service]);

    for (const [slotAt, services] of [...byInstant.entries()].sort()) {
      // Productions the owner already rejected for one of these services at this instant must not be re-drafted there.
      const rejectedHere = new Set(existing.filter((p) => p.state === 'deleted' && p.slot_at === slotAt && services.includes(p.service)).map((p) => p.production_id));
      // Reuse the sibling service's production only for a *retry* (e.g. TikTok create failed after YouTube succeeded), never after a rejection.
      const sibling = ['youtube', 'tiktok'].map((s) => liveByKey.get(`${slotAt}|${s}`)).find((p) => p && !rejectedHere.has(p.production_id));
      const retryRow = services.map((s) => retryRows.get(`${slotAt}|${s}`)).find((p) => p && !rejectedHere.has(p.production_id));
      let prod: Production | undefined;
      if (sibling) prod = (await store.listProductions()).find((p) => p.id === sibling.production_id);
      else if (retryRow) prod = (await store.listProductions()).find((p) => p.id === retryRow.production_id && !!p.public_url);
      while (!prod && pool.length) { const next = pool.shift()!; if (!rejectedHere.has(next.id)) prod = next; }
      if (!prod) { result.openSlots += services.length; continue; }

      for (const service of services) {
        const key = `${plan.week}|${slotAt}|${service}`;
        const row: ScheduledPost = retryRows.get(`${slotAt}|${service}`) ?? {
          id: ulid(), production_id: prod.id, candidate_id: prod.candidate_id, content_format: prod.content_format ?? 'general_viral', service, buffer_channel_id: channelFor(cfg, service),
          buffer_post_id: null, slot_at: slotAt, batch_week: plan.week, state: cfg.approvalMode === 'needs_approval' ? 'needs_approval' : 'draft',
          last_synced_at: null, buffer_error: null, views: null, likes: null, comments: null, shares: null, metrics_updated_at: null,
          created_at: now().toISOString(), updated_at: now().toISOString(), idempotency_key: key, create_attempts: 0, missing_count: 0, missing_since: null, sync_error: null,
        };
        row.production_id = prod.id;
        row.candidate_id = prod.candidate_id;
        const cand = await store.getCandidate(prod.candidate_id);
        const dt = draftText(prod, cand, service, cfg.contactEmail);
        row.reuse_uncertain = dt.uncertain;
        row.public_text = dt.publicText;
        row.review_block_stripped = true; // captions never carry review text anymore
        // unattended mode: rights + QC gate decides between SCHEDULE, draft-for-optional-review, or skip
        let schedule: { decisionId: string } | null = null;
        if (opts.unattended) {
          const elig = cand ? unattendedEligible(cand, prod, opts.unattended.minQc, { fairUse: opts.unattended.fairUse }) : { eligible: false, reasons: ['candidate record missing'], basis: null, qcScore: prod.qc_score ?? null };
          if (elig.eligible) {
            const viaFairUse = String(elig.basis) === 'fair_use_assessment';
            const d = await opts.unattended.decide({ kind: 'schedule', production_id: prod.id, candidate_id: prod.candidate_id, service, slot_at: slotAt, buffer_post_id: null,
              reasons: JSON.stringify([viaFairUse ? 'basis: case-specific fair-use assessment "supportable" under the owner policy (NOT a licence; uncertainty: market effect assumed, not verified)' : `rights ${elig.basis} documented`, `QC ${elig.qcScore}`]),
              detail: JSON.stringify({ rights_status: cand?.rights_status, rights_basis: cand?.rights_basis, rights_evidence: cand?.rights_evidence, fair_use: viaFairUse ? JSON.parse(prod.fair_use_json ?? 'null') : null, qc_score: elig.qcScore, headline: prod.headline, source_url: cand?.source_url, creator: cand?.detected_handle ?? cand?.author }) });
            schedule = { decisionId: d.id };
          } else if (opts.unattended.reviewDrafts) {
            await opts.unattended.decide({ kind: 'hold', production_id: prod.id, candidate_id: prod.candidate_id, service, slot_at: slotAt, buffer_post_id: null, reasons: JSON.stringify(elig.reasons), detail: JSON.stringify({ drafted_for_review: true }) });
          } else {
            await opts.unattended.decide({ kind: 'skip', production_id: prod.id, candidate_id: prod.candidate_id, service, slot_at: slotAt, buffer_post_id: null, reasons: JSON.stringify(elig.reasons), detail: null });
            result.skipped++;
            continue;
          }
        }
        if (!client) { log.info(`[dry-run] would create ${service} ${schedule ? 'SCHEDULED post' : 'draft'} for ${slotAt}: "${prod.headline}" <- ${prod.public_url}`); result.created++; continue; }
        try {
          const outcome = await createDraftIdempotent(cfg, client, row, prod, dt.text, now, schedule);
          row.buffer_post_id = outcome.post.id;
          row.state = (outcome.post.status as ScheduledPost['state']) || (schedule ? 'scheduled' : row.state);
          if (schedule) await opts.unattended!.decide({ kind: 'schedule', production_id: prod.id, candidate_id: prod.candidate_id, service, slot_at: slotAt, buffer_post_id: outcome.post.id, reasons: JSON.stringify([outcome.adopted ? 'adopted existing Buffer post' : 'created in Buffer', `status ${row.state}`]), detail: JSON.stringify({ decision_id: schedule.decisionId }) });
          row.buffer_error = null;
          row.last_synced_at = now().toISOString();
          if (outcome.adopted) result.adopted++; else result.created++;
          liveByKey.set(`${slotAt}|${service}`, row);
          log.info(`Buffer ${service} ${row.state} ${row.buffer_post_id} for ${slotAt} ("${prod.headline}")${outcome.adopted ? ' [adopted existing]' : ''}`);
        } catch (e) {
          row.buffer_error = (e as Error).message.slice(0, 500);
          row.state = 'error';
          result.failed++;
          log.error(`Buffer create failed (${service}, ${slotAt}): ${row.buffer_error}`);
        }
        row.updated_at = now().toISOString();
        await store.upsertPost(row);
      }
      const cand = await store.getCandidate(prod.candidate_id);
      if (cand && cand.status !== 'drafted' && services.some((s) => liveByKey.has(`${slotAt}|${s}`))) await store.patchCandidate(cand.id, { status: 'drafted' });
    }
  }
  return result;
}

/** Internal Buffer tags (never published) so review-path drafts are visually distinct in the Buffer UI. */
export function bufferTagsFor(cfg: Config, uncertain: boolean): string[] | undefined {
  const id = uncertain ? cfg.bufferTagReviewId : cfg.bufferTagClearedId;
  return id ? [id] : undefined;
}

async function createDraftIdempotent(cfg: Config, client: BufferClient, row: ScheduledPost, prod: Production, text: string, now: () => Date, schedule: { decisionId: string } | null = null): Promise<{ post: { id: string; status: string }; adopted: boolean }> {
  if (!prod.public_url || !/^https?:\/\//.test(prod.public_url)) throw new Error(`production ${prod.id} has no public URL (R2 not configured?)`);
  const existing = await client.findPostAt(cfg.bufferOrgId, row.buffer_channel_id, row.slot_at).catch(() => null);
  if (existing) return { post: existing, adopted: true };
  return withRetry(`buffer createPost ${row.service} ${row.slot_at}`, async (attempt) => {
    row.create_attempts = (row.create_attempts ?? 0) + 1;
    if (attempt > 1) {
      const again = await client.findPostAt(cfg.bufferOrgId, row.buffer_channel_id, row.slot_at).catch(() => null);
      if (again) return { post: again, adopted: true };
    }
    const post = await client.createVideoPost({
      channelId: row.buffer_channel_id,
      text,
      videoUrl: prod.public_url!,
      dueAt: toBufferDueAt(row.slot_at, cfg.tz),
      mode: 'customScheduled',
      saveToDraft: schedule ? false : cfg.approvalMode !== 'needs_approval',
      needsApproval: schedule ? false : cfg.approvalMode === 'needs_approval',
      autopilot: schedule ? { authorization: cfg.unattendedAuthorization ?? '', decisionId: schedule.decisionId } : undefined,
      videoTitle: prod.headline,
      youtube: row.service === 'youtube' ? { title: prod.headline.slice(0, 100), categoryId: YOUTUBE_CATEGORY_COMEDY, privacy: 'public', madeForKids: false, notifySubscribers: true, isAiGenerated: true, license: 'youtube' } : undefined,
      tiktok: row.service === 'tiktok' ? { title: prod.headline.slice(0, 90), isAiGenerated: true } : undefined,
      tagIds: bufferTagsFor(cfg, row.reuse_uncertain ?? false),
    });
    if (post.dueAt && Math.abs(Date.parse(post.dueAt) - Date.parse(row.slot_at)) > 60_000) {
      log.warn(`Buffer stored dueAt ${post.dueAt} for slot ${row.slot_at}; sync will re-pin on approval`);
    }
    return { post, adopted: false };
  }, { attempts: 3, shouldRetry: (e) => !(e instanceof BufferApiError && e.status === 0) && isTransient(e) });
  void now;
}
