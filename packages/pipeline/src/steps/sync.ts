import { normaliseMetrics, runSync, updateCategoryWeights, type BufferClient, type ContentCategory, type SyncResult, type SyncStore } from '@toaster/shared';
import { log, type Config } from '../config.js';
import type { Store } from '../store.js';
import { produceUntil } from './produce.js';
import { bufferClient, publishWeek } from './publish.js';

/** Adapt the pipeline Store to the shared SyncStore interface. */
export function syncStoreOf(store: Store): SyncStore {
  return {
    listPendingPosts: () => store.listPosts({ state: ['draft', 'needs_approval', 'scheduled', 'sending'] }),
    savePost: (p) => store.upsertPost(p),
    listPostsForCandidate: async (cid) => (await store.listPosts()).filter((p) => p.candidate_id === cid),
    patchCandidate: async (id, patch) => { await store.patchCandidate(id, patch); },
    logEvent: async (kind, ref, detail) => { log.info(`event ${kind} ${ref ?? ''} ${JSON.stringify(detail)}`); },
  };
}

/**
 * Poll Buffer, reconcile per-service states (see shared/sync.ts), then produce + draft replacements for
 * confirmed rejections. Transient Buffer failures never change state and never trigger replacements.
 */
export async function syncBuffer(cfg: Config, store: Store, opts: { replace?: boolean; client?: BufferClient; now?: () => Date } = {}): Promise<SyncResult> {
  const client = opts.client ?? bufferClient(cfg);
  const result = await runSync(client, syncStoreOf(store), { tz: cfg.tz, now: opts.now });
  if (result.replacements_needed > 0 && opts.replace !== false) {
    log.info(`producing ${result.replacements_needed} replacement(s) and re-drafting`);
    await produceUntil(cfg, store, result.replacements_needed);
    const pub = await publishWeek(cfg, store, { client, now: opts.now });
    log.info(`replacement drafts: created ${pub.created}, adopted ${pub.adopted}, failed ${pub.failed}, still open ${pub.openSlots}`);
  }
  return result;
}

/** Pull metrics for sent posts and update category weights (performance learning). */
export async function learn(cfg: Config, store: Store, opts: { client?: BufferClient } = {}): Promise<{ updated: number; weights: { category: string; weight: number }[] }> {
  const client = opts.client ?? bufferClient(cfg);
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
