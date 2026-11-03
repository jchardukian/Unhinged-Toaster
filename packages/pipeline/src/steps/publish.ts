import { BufferClient, buildWeekPlan, toBufferDueAt, ulid, type BufferService, type Production, type ScheduledPost } from '@toaster/shared';
import { log, type Config } from '../config.js';
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
  // TikTok caption limit 2200, YouTube description 5000
  return text.slice(0, service === 'tiktok' ? 2100 : 4900);
}

/**
 * Fill the next week's open slots with finished productions as Buffer DRAFTS (or needs_approval on Team plan).
 * One production feeds both the YouTube and the TikTok slot at the same instant.
 */
export async function publishWeek(cfg: Config, store: Store, opts: { dryRun?: boolean; week?: 'next' | string } = {}): Promise<{ created: number; openSlots: number; week: string }> {
  const plan = buildWeekPlan(new Date(), cfg.tz, cfg.publishSlots);
  const existing = await store.listPosts({ week: plan.week });
  const taken = new Set(existing.filter((p) => p.state !== 'deleted').map((p) => `${p.slot_at}|${p.service}`));
  const open = plan.slots.filter((s) => !taken.has(`${s.slot_at}|${s.service}`));
  if (open.length === 0) return { created: 0, openSlots: 0, week: plan.week };

  // group open slots by instant so one production covers both services
  const byInstant = new Map<string, BufferService[]>();
  for (const s of open) byInstant.set(s.slot_at, [...(byInstant.get(s.slot_at) ?? []), s.service]);

  const pool = await unpostedProductions(store);
  const client = opts.dryRun ? null : bufferClient(cfg);
  let created = 0;
  for (const [slotAt, services] of [...byInstant.entries()].sort()) {
    const prod = pool.shift();
    if (!prod) { log.warn(`no finished production left for slot ${slotAt}`); break; }
    const cand = await store.getCandidate(prod.candidate_id);
    for (const service of services) {
      const post: ScheduledPost = {
        id: ulid(), production_id: prod.id, candidate_id: prod.candidate_id, service, buffer_channel_id: channelFor(cfg, service),
        buffer_post_id: null, slot_at: slotAt, batch_week: plan.week, state: cfg.approvalMode === 'needs_approval' ? 'needs_approval' : 'draft',
        last_synced_at: null, buffer_error: null, views: null, likes: null, comments: null, shares: null, metrics_updated_at: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      if (client) {
        try {
          const bp = await client.createVideoPost({
            channelId: post.buffer_channel_id,
            text: postText(prod, service, true),
            videoUrl: prod.public_url!,
            dueAt: toBufferDueAt(slotAt, cfg.tz),
            mode: 'customScheduled',
            saveToDraft: cfg.approvalMode !== 'needs_approval',
            needsApproval: cfg.approvalMode === 'needs_approval',
            videoTitle: prod.headline,
            youtube: service === 'youtube' ? { title: prod.headline.slice(0, 100), categoryId: YOUTUBE_CATEGORY_COMEDY, privacy: 'public', madeForKids: false, notifySubscribers: true, isAiGenerated: true, license: 'youtube' } : undefined,
            tiktok: service === 'tiktok' ? { title: prod.headline.slice(0, 90), isAiGenerated: true } : undefined,
          });
          post.buffer_post_id = bp.id;
          post.state = (bp.status as ScheduledPost['state']) || post.state;
          post.last_synced_at = new Date().toISOString();
          log.info(`Buffer ${service} ${post.state} ${bp.id} for ${slotAt} ("${prod.headline}")`);
        } catch (e) {
          post.buffer_error = (e as Error).message.slice(0, 500);
          post.state = 'error';
          log.error(`Buffer create failed (${service}, ${slotAt}): ${post.buffer_error}`);
        }
      } else {
        log.info(`[dry-run] would create ${service} draft for ${slotAt}: "${prod.headline}" <- ${prod.public_url}`);
      }
      await store.upsertPost(post);
      created++;
    }
    if (cand && cand.status !== 'drafted') await store.patchCandidate(cand.id, { status: 'drafted' });
  }
  return { created, openSlots: open.length - created, week: plan.week };
}
