import { BufferApiError, BufferClient, buildWeekPlan, reviewBlock, toBufferDueAt, ulid, type BufferService, type Candidate, type Production, type ScheduledPost, type SlotPlan } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { isTransient, withRetry } from '../retry.js';
import type { Store } from '../store.js';
import { unpostedProductions } from './produce.js';

export const YOUTUBE_CATEGORY_COMEDY = '23';

export function bufferClient(cfg: Config): BufferClient {
  if (!cfg.bufferKey) throw new Error('BUFFER_API_KEY not set (Buffer > Settings > API)');
  return new BufferClient({ apiKey: cfg.bufferKey });
}

export function channelFor(cfg: Config, service: BufferService): string {
  return service === 'youtube' ? cfg.bufferYoutubeChannelId : cfg.bufferTiktokChannelId;
}

export function postText(p: Production, service: BufferService, discloseAi: boolean): string {
  const tags = (JSON.parse(p.hashtags) as string[]).map((t) => `#${t}`).join(' ');
  const parts = [p.caption_text, tags];
  if (discloseAi) parts.push('Commentary voice is AI-generated.');
  const text = parts.filter(Boolean).join('\n\n');
  return text.slice(0, service === 'tiktok' ? 2100 : 4900);
}

/** Draft text: the review note (for footage without an explicit license) + the public caption. */
export function draftText(p: Production, c: Candidate | null, service: BufferService): { text: string; publicText: string; uncertain: boolean } {
  const publicText = postText(p, service, true);
  const uncertain = p.reuse_basis === 'review' || (c != null && c.rights_status !== 'cleared');
  if (!uncertain || !c) return { text: publicText, publicText, uncertain: false };
  const text = `${reviewBlock(c)}\n\n${publicText}`.slice(0, service === 'tiktok' ? 2150 : 4950);
  return { text, publicText, uncertain: true };
}

export interface PublishOptions {
  dryRun?: boolean;
  client?: BufferClient;            // injected in tests
  now?: () => Date;
  /** Weeks to fill: current week (future slots only) and next week by default. */
  weeks?: ('current' | 'next')[];
  /** Minimum lead time before a slot for a draft to still be worth creating (owner needs time to approve). */
  minLeadHours?: number;
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
  const lead = (opts.minLeadHours ?? 20) * 3600_000;
  const result: PublishResult = { created: 0, adopted: 0, skipped: 0, failed: 0, openSlots: 0, weeks: [] };
  const client = opts.dryRun ? null : opts.client ?? bufferClient(cfg);
  const pool = await unpostedProductions(store);

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
          id: ulid(), production_id: prod.id, candidate_id: prod.candidate_id, service, buffer_channel_id: channelFor(cfg, service),
          buffer_post_id: null, slot_at: slotAt, batch_week: plan.week, state: cfg.approvalMode === 'needs_approval' ? 'needs_approval' : 'draft',
          last_synced_at: null, buffer_error: null, views: null, likes: null, comments: null, shares: null, metrics_updated_at: null,
          created_at: now().toISOString(), updated_at: now().toISOString(), idempotency_key: key, create_attempts: 0, missing_count: 0, missing_since: null, sync_error: null,
        };
        row.production_id = prod.id;
        row.candidate_id = prod.candidate_id;
        const cand = await store.getCandidate(prod.candidate_id);
        const dt = draftText(prod, cand, service);
        row.reuse_uncertain = dt.uncertain;
        row.public_text = dt.publicText;
        row.review_block_stripped = !dt.uncertain;
        if (!client) { log.info(`[dry-run] would create ${service} draft for ${slotAt}: "${prod.headline}" <- ${prod.public_url}`); result.created++; continue; }
        try {
          const outcome = await createDraftIdempotent(cfg, client, row, prod, dt.text, now);
          row.buffer_post_id = outcome.post.id;
          row.state = (outcome.post.status as ScheduledPost['state']) || row.state;
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

async function createDraftIdempotent(cfg: Config, client: BufferClient, row: ScheduledPost, prod: Production, text: string, now: () => Date): Promise<{ post: { id: string; status: string }; adopted: boolean }> {
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
      saveToDraft: cfg.approvalMode !== 'needs_approval',
      needsApproval: cfg.approvalMode === 'needs_approval',
      videoTitle: prod.headline,
      youtube: row.service === 'youtube' ? { title: prod.headline.slice(0, 100), categoryId: YOUTUBE_CATEGORY_COMEDY, privacy: 'public', madeForKids: false, notifySubscribers: true, isAiGenerated: true, license: 'youtube' } : undefined,
      tiktok: row.service === 'tiktok' ? { title: prod.headline.slice(0, 90), isAiGenerated: true } : undefined,
    });
    if (post.dueAt && Math.abs(Date.parse(post.dueAt) - Date.parse(row.slot_at)) > 60_000) {
      log.warn(`Buffer stored dueAt ${post.dueAt} for slot ${row.slot_at}; sync will re-pin on approval`);
    }
    return { post, adopted: false };
  }, { attempts: 3, shouldRetry: (e) => !(e instanceof BufferApiError && e.status === 0) && isTransient(e) });
  void now;
}
