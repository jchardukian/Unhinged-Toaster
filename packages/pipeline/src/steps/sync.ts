import { normaliseMetrics, reconcilePost, toBufferDueAt, updateCategoryWeights, type ContentCategory, type SyncResult } from '@toaster/shared';
import { log, type Config } from '../config.js';
import type { Store } from '../store.js';
import { produceUntil } from './produce.js';
import { bufferClient, publishWeek } from './publish.js';

/**
 * Poll Buffer for every post we created that is not yet final, reconcile states, pin approved posts to their
 * slot, and queue replacements for anything the user rejected (deleted) in Buffer.
 */
export async function syncBuffer(cfg: Config, store: Store, opts: { replace?: boolean } = {}): Promise<SyncResult> {
  const client = bufferClient(cfg);
  const pending = (await store.listPosts({ state: ['draft', 'needs_approval', 'scheduled', 'sending'] })).filter((p) => p.buffer_post_id);
  const result: SyncResult = { checked: pending.length, approved: 0, rejected: 0, published: 0, errors: [], replacements_needed: 0 };
  if (pending.length === 0) return result;
  const theirs = await client.getPosts(pending.map((p) => p.buffer_post_id!));
  const now = new Date().toISOString();
  for (const p of pending) {
    const bp = theirs.get(p.buffer_post_id!) ?? null;
    const r = reconcilePost(p, bp);
    p.state = r.state;
    p.last_synced_at = now;
    p.buffer_error = r.error;
    p.updated_at = now;
    if (r.approved) {
      result.approved++;
      await store.patchCandidate(p.candidate_id, { status: 'approved' });
      if (r.needsReschedule) {
        try {
          const moved = await client.reschedulePost(p.buffer_post_id!, toBufferDueAt(p.slot_at, cfg.tz));
          log.info(`pinned approved ${p.service} post ${p.buffer_post_id} to ${p.slot_at} (Buffer now ${moved.dueAt})`);
        } catch (e) {
          result.errors.push({ post_id: p.buffer_post_id!, error: `reschedule: ${(e as Error).message}` });
        }
      }
    }
    if (r.rejected) {
      result.rejected++;
      const future = Date.parse(p.slot_at) > Date.now() + 3 * 3600_000;
      if (future) result.replacements_needed++;
      await store.patchCandidate(p.candidate_id, { status: 'rejected_user', status_reason: `rejected in Buffer (${p.service})` });
      log.info(`user rejected ${p.service} post for ${p.slot_at} (production ${p.production_id})`);
    }
    if (r.published) {
      result.published++;
      await store.patchCandidate(p.candidate_id, { status: 'published' });
    }
    if (r.error) result.errors.push({ post_id: p.buffer_post_id!, error: r.error });
    await store.upsertPost(p);
  }

  if (result.replacements_needed > 0 && opts.replace !== false) {
    log.info(`producing ${result.replacements_needed} replacement(s) and re-drafting`);
    await produceUntil(cfg, store, result.replacements_needed);
    const pub = await publishWeek(cfg, store);
    log.info(`replacement drafts created: ${pub.created}, still open: ${pub.openSlots}`);
  }
  return result;
}

/** Pull metrics for sent posts and update category weights (performance learning). */
export async function learn(cfg: Config, store: Store): Promise<{ updated: number; weights: { category: string; weight: number }[] }> {
  const client = bufferClient(cfg);
  const sent = (await store.listPosts({ state: ['sent'] })).filter((p) => p.buffer_post_id);
  if (sent.length === 0) return { updated: 0, weights: (await store.weights()).map((w) => ({ category: w.category, weight: w.weight })) };
  const metrics = await client.postMetrics(sent.map((p) => p.buffer_post_id!));
  const obs: { category: ContentCategory; views: number }[] = [];
  let updated = 0;
  for (const p of sent) {
    const m = metrics.get(p.buffer_post_id!);
    if (!m) continue;
    const n = normaliseMetrics(m.metrics);
    Object.assign(p, n, { metrics_updated_at: m.updatedAt ?? new Date().toISOString(), updated_at: new Date().toISOString() });
    await store.upsertPost(p);
    updated++;
    const c = await store.getCandidate(p.candidate_id);
    if (c?.category && n.views != null && Date.parse(p.slot_at) < Date.now() - 48 * 3600_000) obs.push({ category: c.category, views: n.views });
  }
  const weights = updateCategoryWeights(await store.weights(), obs, new Date().toISOString());
  await store.saveWeights(weights);
  log.info(`metrics updated for ${updated} posts; weights: ${weights.map((w) => `${w.category}=${w.weight}`).join(', ')}`);
  return { updated, weights: weights.map((w) => ({ category: w.category, weight: w.weight })) };
}
