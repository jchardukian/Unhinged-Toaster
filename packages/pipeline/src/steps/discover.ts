import { ccProvenanceRisk, qualityTier, ulid, initialRights, type Candidate, type ContentCategory, type SourceAdapter, type SourcePlatform } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { withRetry } from '../retry.js';

/**
 * Discovery adapters. Each returns Candidate rows in status 'discovered' with the rights status that
 * the source legitimately supports (see shared/rights.ts and docs/SOURCES.md). Nothing here downloads media.
 *
 * Automated, commercially reusable, no extra permission:  pixabay, pexels, internet_archive
 * Automated, uploader-asserted CC BY (provenance-checked, ToS caveat, opt-in):  youtube
 * Discovery only, needs creator permission:  reddit
 */

export interface DiscoverOptions { sources: SourceAdapter[]; limitPerSource: number }

export async function discoverAll(cfg: Config, opts: DiscoverOptions): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const s of opts.sources) {
    try {
      const found =
        s === 'reddit' ? await discoverReddit(cfg, opts.limitPerSource)
        : s === 'youtube' ? await discoverYouTube(cfg, opts.limitPerSource)
        : s === 'pexels' ? await discoverPexels(cfg, opts.limitPerSource)
        : s === 'pixabay' ? await discoverPixabay(cfg, opts.limitPerSource)
        : s === 'internet_archive' ? await discoverInternetArchive(cfg, opts.limitPerSource)
        : s === 'youtube_trending' ? await discoverYouTubeTrending(cfg, opts.limitPerSource)
        : [];
      log.info(`discover:${s} -> ${found.length} candidates`);
      out.push(...found);
    } catch (e) {
      log.error(`discover:${s} failed:`, (e as Error).message);
    }
  }
  return out;
}

function base(platform: SourcePlatform, now: string): Pick<Candidate, 'id' | 'discovered_at' | 'updated_at' | 'status' | 'status_reason' | 'heuristic_score' | 'llm_score' | 'final_score' | 'llm_rationale' | 'safety_flags' | 'phash' | 'duplicate_of' | 'attribution_text' | 'category' | 'source_platform' | 'copyright_risk' | 'copyright_risk_reasons'> {
  return {
    id: ulid(), discovered_at: now, updated_at: now, status: 'discovered', status_reason: null,
    heuristic_score: null, llm_score: null, final_score: null, llm_rationale: null, safety_flags: null,
    phash: null, duplicate_of: null, attribution_text: null, category: null, source_platform: platform,
    copyright_risk: null, copyright_risk_reasons: null,
  } as ReturnType<typeof base>;
}

/** Search terms per content category, shared by the stock-style sources. */
export const CATEGORY_QUERIES: { q: string; category: ContentCategory }[] = [
  { q: 'funny dog', category: 'funny_animals' },
  { q: 'funny cat', category: 'funny_animals' },
  { q: 'cute puppy playing', category: 'funny_animals' },
  { q: 'goat jumping', category: 'funny_animals' },
  { q: 'parrot talking', category: 'funny_animals' },
  { q: 'slip fall funny', category: 'people_fails' },
  { q: 'skateboard fail', category: 'people_fails' },
  { q: 'water balloon slow motion', category: 'unbelievable' },
  { q: 'trick shot', category: 'unbelievable' },
  { q: 'surprise reaction', category: 'wholesome_reactions' },
  { q: 'baby laughing', category: 'wholesome_reactions' },
  { q: 'dog reunion', category: 'wholesome_reactions' },
];

// ---------------------------------------------------------------- Pixabay (Content License: commercial OK, no attribution, must be transformed)
interface PixabayHit {
  id: number; pageURL: string; tags: string; duration: number; views: number; downloads: number; likes: number; comments: number; user: string; user_id: number;
  videos: Record<'large' | 'medium' | 'small' | 'tiny', { url: string; width: number; height: number; size: number }>;
}

export async function discoverPixabay(cfg: Config, limit: number): Promise<Candidate[]> {
  if (!cfg.pixabayKey) throw new Error('PIXABAY_API_KEY not set');
  const now = new Date().toISOString();
  const out: Candidate[] = [];
  for (const { q, category } of CATEGORY_QUERIES) {
    const sp = new URLSearchParams({ key: cfg.pixabayKey, q, video_type: 'film', order: 'popular', safesearch: 'true', per_page: String(Math.min(200, Math.max(3, limit))) });
    const res = await withRetry(`pixabay ${q}`, () => fetch(`https://pixabay.com/api/videos/?${sp}`), { attempts: 3 });
    if (!res.ok) { log.warn(`pixabay ${q} -> ${res.status}`); continue; }
    const j = (await res.json()) as { hits: PixabayHit[] };
    for (const h of j.hits) {
      if (h.duration < 4 || h.duration > 45) continue;
      const file = h.videos.large?.url ? h.videos.large : h.videos.medium;
      if (!file?.url) continue;
      out.push({
        ...base('pixabay', now),
        source_id: String(h.id), source_url: h.pageURL, media_url: file.url, author: h.user, author_url: `https://pixabay.com/users/${h.user}-${h.user_id}/`,
        title: `${q}: ${h.tags}`, description: `Pixabay tags: ${h.tags}`, category, duration_sec: h.duration, width: file.width, height: file.height,
        published_at: null, views: h.views, likes: h.likes, comments: h.comments, shares: h.downloads, engagement_velocity: null,
        ...initialRights('pixabay', { evidenceSuffix: ` item ${h.pageURL}` }),
      });
    }
    await sleep(600); // free tier: 100 req/min
  }
  return dedupeById(out);
}

// ---------------------------------------------------------------- Pexels (Pexels License: commercial OK)
export async function discoverPexels(cfg: Config, limit: number): Promise<Candidate[]> {
  if (!cfg.pexelsKey) throw new Error('PEXELS_API_KEY not set');
  const now = new Date().toISOString();
  const out: Candidate[] = [];
  for (const { q, category } of CATEGORY_QUERIES) {
    const res = await withRetry(`pexels ${q}`, () => fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=${Math.min(80, limit)}`, { headers: { authorization: cfg.pexelsKey! } }), { attempts: 3 });
    if (!res.ok) { log.warn(`pexels ${q} -> ${res.status}`); continue; }
    const j = (await res.json()) as { videos: { id: number; url: string; duration: number; width: number; height: number; user: { name: string; url: string }; video_files: { link: string; width: number; height: number; quality: string }[] }[] };
    for (const v of j.videos) {
      if (v.duration < 4 || v.duration > 45) continue;
      const file = [...v.video_files].sort((a, b) => b.height - a.height).find((f) => f.height <= 1920) ?? v.video_files[0];
      out.push({
        ...base('pexels', now), source_id: String(v.id), source_url: v.url, media_url: file.link, author: v.user.name, author_url: v.user.url,
        title: q, description: null, category, duration_sec: v.duration, width: v.width, height: v.height, published_at: null,
        views: null, likes: null, comments: null, shares: null, engagement_velocity: null, ...initialRights('pexels', {}),
      });
    }
    await sleep(400);
  }
  return dedupeById(out);
}

// ---------------------------------------------------------------- Internet Archive (public domain / CC0 / CC BY items; short items only)
interface IaDoc { identifier: string; title?: string; licenseurl?: string | string[]; downloads?: number; runtime?: string; creator?: string | string[]; description?: string | string[]; date?: string }

export async function discoverInternetArchive(_cfg: Config, limit: number): Promise<Candidate[]> {
  const now = new Date().toISOString();
  const out: Candidate[] = [];
  const subjects = ['funny', 'comedy', 'cats', 'dogs', 'animals', 'fail', 'blooper', 'slapstick'];
  const q = `mediatype:movies AND (licenseurl:(*publicdomain*) OR licenseurl:(*zero*) OR licenseurl:(*licenses\\/by\\/*)) AND (subject:(${subjects.join(' OR ')}) OR title:(${subjects.join(' OR ')}))`;
  const sp = new URLSearchParams({ q, rows: String(Math.min(200, limit * 3)), output: 'json', sort: 'downloads desc' });
  for (const f of ['identifier', 'title', 'licenseurl', 'downloads', 'runtime', 'creator', 'description', 'date']) sp.append('fl[]', f);
  const res = await withRetry('archive.org search', async () => {
    const r = await fetch(`https://archive.org/advancedsearch.php?${sp}`, { headers: { 'user-agent': 'unhinged-toaster/0.1' } });
    if (r.status === 429 || r.status >= 500) throw new Error(`archive.org ${r.status}`);
    return r;
  }, { attempts: 4, baseMs: 3000 });
  if (!res.ok) throw new Error(`archive.org ${res.status}`);
  const j = (await res.json()) as { response?: { docs: IaDoc[] }; error?: string };
  if (!j.response) throw new Error(`archive.org: ${j.error ?? 'no response'}`);
  for (const d of j.response.docs) {
    const runtime = parseRuntime(d.runtime);
    if (runtime == null || runtime < 4 || runtime > 90) continue; // we only use short items; no automatic sub-clipping of long films
    const license = Array.isArray(d.licenseurl) ? d.licenseurl[0] : d.licenseurl;
    const rights = initialRights('internet_archive', { license, evidenceSuffix: `https://archive.org/details/${d.identifier}` });
    if (rights.rights_status !== 'cleared') continue;
    const file = await iaBestFile(d.identifier).catch(() => null);
    if (!file) continue;
    out.push({
      ...base('internet_archive', now), source_id: d.identifier, source_url: `https://archive.org/details/${d.identifier}`, media_url: file,
      author: Array.isArray(d.creator) ? d.creator[0] : d.creator ?? null, author_url: null, title: d.title ?? d.identifier,
      description: (Array.isArray(d.description) ? d.description[0] : d.description)?.slice(0, 500) ?? null, category: guessCategory(`${d.title} ${d.description}`),
      duration_sec: runtime, width: null, height: null, published_at: d.date ?? null, views: d.downloads ?? null, likes: null, comments: null, shares: null, engagement_velocity: null,
      ...rights,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function iaBestFile(identifier: string): Promise<string | null> {
  const res = await fetch(`https://archive.org/metadata/${identifier}/files`, { headers: { 'user-agent': 'unhinged-toaster/0.1' } });
  if (!res.ok) return null;
  const j = (await res.json()) as { result?: { name: string; format?: string; size?: string }[] };
  const files = (j.result ?? []).filter((f) => /\.(mp4|m4v|webm|ogv|mov)$/i.test(f.name) && Number(f.size ?? 0) < 300_000_000);
  const pick = files.find((f) => /h\.?264|mpeg4|mp4/i.test(f.format ?? '') && /\.mp4$/i.test(f.name)) ?? files[0];
  return pick ? `https://archive.org/download/${identifier}/${encodeURIComponent(pick.name)}` : null;
}

export function parseRuntime(rt?: string): number | null {
  if (!rt) return null;
  const parts = rt.trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function guessCategory(text: string): ContentCategory {
  const t = text.toLowerCase();
  if (/\b(cat|dog|puppy|kitten|animal|goat|bird|parrot|horse)s?\b/.test(t)) return 'funny_animals';
  if (/\b(fail|blooper|slip|fall|crash|oops)s?\b/.test(t)) return 'people_fails';
  if (/\b(amazing|incredible|unbelievable|trick|stunt|record)\b/.test(t)) return 'unbelievable';
  return 'wholesome_reactions';
}

// ---------------------------------------------------------------- Reddit (discovery only; rights unknown until creator permission)
export const REDDIT_SOURCES: { sub: string; category: ContentCategory }[] = [
  { sub: 'Unexpected', category: 'unbelievable' },
  { sub: 'WhatCouldGoWrong', category: 'people_fails' },
  { sub: 'holdmybeer', category: 'people_fails' },
  { sub: 'instant_regret', category: 'people_fails' },
  { sub: 'AnimalsBeingDerps', category: 'funny_animals' },
  { sub: 'AnimalsBeingJerks', category: 'funny_animals' },
  { sub: 'WhatsWrongWithYourDog', category: 'funny_animals' },
  { sub: 'nextfuckinglevel', category: 'unbelievable' },
  { sub: 'ContagiousLaughter', category: 'wholesome_reactions' },
  { sub: 'MadeMeSmile', category: 'wholesome_reactions' },
  { sub: 'HumansBeingBros', category: 'wholesome_reactions' },
  { sub: 'funny', category: 'people_fails' },
];

interface RedditChild {
  data: {
    id: string; title: string; author: string; permalink: string; url: string; created_utc: number; score: number; upvote_ratio: number;
    num_comments: number; num_crossposts?: number; over_18: boolean; is_video: boolean; is_gallery?: boolean; subreddit: string; selftext?: string;
    media?: { reddit_video?: { fallback_url: string; duration: number; width: number; height: number; has_audio?: boolean } } | null;
    secure_media?: { reddit_video?: { fallback_url: string; duration: number; width: number; height: number } } | null;
    crosspost_parent_list?: RedditChild['data'][];
  };
}

async function redditToken(cfg: Config): Promise<string> {
  const { clientId, clientSecret, username, password, userAgent } = cfg.reddit;
  if (!clientId || !clientSecret) throw new Error('REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not set');
  const body = username && password
    ? new URLSearchParams({ grant_type: 'password', username, password })
    : new URLSearchParams({ grant_type: 'client_credentials' });
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'), 'user-agent': userAgent, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`reddit token ${res.status}`);
  const j = (await res.json()) as { access_token: string };
  return j.access_token;
}

export async function discoverReddit(cfg: Config, limit: number): Promise<Candidate[]> {
  const token = await redditToken(cfg);
  const now = new Date().toISOString();
  const out: Candidate[] = [];
  for (const { sub, category } of REDDIT_SOURCES) {
    const res = await fetch(`https://oauth.reddit.com/r/${sub}/top?t=day&limit=${Math.min(100, limit)}&raw_json=1`, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': cfg.reddit.userAgent },
    });
    if (!res.ok) { log.warn(`reddit r/${sub} -> ${res.status}`); continue; }
    const j = (await res.json()) as { data: { children: RedditChild[] } };
    for (const ch of j.data.children) {
      const d = ch.data.crosspost_parent_list?.[0] ?? ch.data;
      const rv = d.media?.reddit_video ?? d.secure_media?.reddit_video;
      if (!d.is_video || !rv || d.over_18 || d.is_gallery) continue;
      if (rv.duration < 4 || rv.duration > 50) continue;
      out.push(parseRedditCandidate(ch.data, d, rv, category, now));
    }
    await sleep(700);
  }
  return out;
}

export function parseRedditCandidate(post: RedditChild['data'], d: RedditChild['data'], rv: NonNullable<NonNullable<RedditChild['data']['media']>['reddit_video']>, category: ContentCategory, now: string): Candidate {
  return {
    ...base('reddit', now),
    source_id: d.id, source_url: `https://www.reddit.com${d.permalink}`, media_url: rv.fallback_url, author: d.author, author_url: `https://www.reddit.com/user/${d.author}`,
    title: d.title, description: d.selftext?.slice(0, 500) || `r/${post.subreddit}`, category, duration_sec: rv.duration, width: rv.width, height: rv.height,
    published_at: new Date(d.created_utc * 1000).toISOString(), views: null, likes: d.score, comments: d.num_comments, shares: d.num_crossposts ?? 0, engagement_velocity: null,
    ...initialRights('reddit', {}),
    quality_tier: qualityTier(rv.width, rv.height),
  };
}

// ---------------------------------------------------------------- YouTube (Creative Commons only, provenance-checked, opt-in)
const YT_QUERIES: { q: string; category: ContentCategory }[] = [
  { q: 'my dog funny', category: 'funny_animals' },
  { q: 'my cat funny', category: 'funny_animals' },
  { q: 'funny fail', category: 'people_fails' },
  { q: 'unexpected moment', category: 'unbelievable' },
  { q: 'surprise reaction', category: 'wholesome_reactions' },
];

export async function discoverYouTube(cfg: Config, limit: number): Promise<Candidate[]> {
  if (!cfg.youtubeKey) throw new Error('YOUTUBE_API_KEY not set');
  if (!cfg.enableYoutubeCc) throw new Error('YouTube CC source disabled: set ENABLE_YOUTUBE_CC=true after reading docs/SOURCES.md (ToS caveat)');
  const now = new Date().toISOString();
  const publishedAfter = new Date(Date.now() - 10 * 86400000).toISOString();
  const out: Candidate[] = [];
  for (const { q, category } of YT_QUERIES) {
    const sp = new URLSearchParams({
      part: 'snippet', q, type: 'video', videoLicense: 'creativeCommon', videoDuration: 'short', order: 'viewCount',
      publishedAfter, maxResults: String(Math.min(50, limit)), safeSearch: 'strict', key: cfg.youtubeKey,
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${sp}`);
    if (!res.ok) { log.warn(`youtube search ${q} -> ${res.status}`); continue; }
    const s = (await res.json()) as { items: { id: { videoId: string } }[] };
    const ids = s.items.map((i) => i.id.videoId);
    if (ids.length === 0) continue;
    const vp = new URLSearchParams({ part: 'snippet,statistics,contentDetails,status', id: ids.join(','), key: cfg.youtubeKey });
    const vres = await fetch(`https://www.googleapis.com/youtube/v3/videos?${vp}`);
    if (!vres.ok) continue;
    const v = (await vres.json()) as { items: YtVideo[] };
    const channelIds = [...new Set(v.items.map((i) => i.snippet.channelId))];
    const channelStats = await youtubeChannelStats(cfg, channelIds);
    for (const item of v.items) {
      if (item.status.license !== 'creativeCommon') continue; // re-verify; search filter is not authoritative
      if (item.contentDetails.contentRating?.ytRating === 'ytAgeRestricted') continue;
      const dur = isoDurationSec(item.contentDetails.duration);
      if (dur < 4 || dur > 60) continue;
      const prov = ccProvenanceRisk({ title: item.snippet.title, description: item.snippet.description, channelTitle: item.snippet.channelTitle, channelVideoCount: channelStats.get(item.snippet.channelId) ?? null, durationSec: dur });
      out.push({
        ...base('youtube', now),
        source_id: item.id, source_url: `https://www.youtube.com/watch?v=${item.id}`, media_url: null,
        author: item.snippet.channelTitle, author_url: `https://www.youtube.com/channel/${item.snippet.channelId}`,
        title: item.snippet.title, description: item.snippet.description?.slice(0, 500) ?? null, category, duration_sec: dur, width: null, height: null,
        published_at: item.snippet.publishedAt, views: num(item.statistics.viewCount), likes: num(item.statistics.likeCount), comments: num(item.statistics.commentCount), shares: null, engagement_velocity: null,
        ...initialRights('youtube', { license: item.status.license, provenanceRisk: prov.risk, provenanceReasons: prov.reasons, evidenceSuffix: `; channel ${item.snippet.channelId}` }),
      });
    }
  }
  return out;
}

/**
 * YouTube most-popular chart (Comedy 23, Pets & Animals 15, Entertainment 24): standard-license uploads that go
 * straight to transformation review. Opt-in (ENABLE_YOUTUBE_TRANSFORM) because fetching the file uses yt-dlp.
 */
export async function discoverYouTubeTrending(cfg: Config, limit: number): Promise<Candidate[]> {
  if (!cfg.youtubeKey) throw new Error('YOUTUBE_API_KEY not set');
  if (!cfg.enableYoutubeTransform) throw new Error('YouTube trending source disabled: set ENABLE_YOUTUBE_TRANSFORM=true (see docs/SOURCES.md)');
  const now = new Date().toISOString();
  const out: Candidate[] = [];
  for (const [categoryId, category] of [['23', 'people_fails'], ['15', 'funny_animals'], ['24', 'unbelievable']] as [string, ContentCategory][]) {
    const sp = new URLSearchParams({ part: 'snippet,statistics,contentDetails,status', chart: 'mostPopular', videoCategoryId: categoryId, regionCode: 'US', maxResults: String(Math.min(50, limit)), key: cfg.youtubeKey });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${sp}`);
    if (!res.ok) { log.warn(`youtube mostPopular ${categoryId} -> ${res.status}`); continue; }
    const v = (await res.json()) as { items: YtVideo[] };
    for (const item of v.items) {
      const dur = isoDurationSec(item.contentDetails.duration);
      if (dur < 4 || dur > 60) continue; // shorts only; no automatic sub-clipping of long videos
      if (item.contentDetails.contentRating?.ytRating === 'ytAgeRestricted') continue;
      const prov = ccProvenanceRisk({ title: item.snippet.title, description: item.snippet.description, channelTitle: item.snippet.channelTitle, durationSec: dur });
      const rights = item.status.license === 'creativeCommon'
        ? initialRights('youtube', { license: 'creativeCommon', provenanceRisk: prov.risk, provenanceReasons: prov.reasons, evidenceSuffix: `; channel ${item.snippet.channelId}` })
        : initialRights('youtube', { license: 'youtube' });
      out.push({
        ...base('youtube', now),
        source_id: item.id, source_url: `https://www.youtube.com/watch?v=${item.id}`, media_url: null,
        author: item.snippet.channelTitle, author_url: `https://www.youtube.com/channel/${item.snippet.channelId}`,
        title: item.snippet.title, description: item.snippet.description?.slice(0, 500) ?? null, category, duration_sec: dur, width: null, height: null,
        published_at: item.snippet.publishedAt, views: num(item.statistics.viewCount), likes: num(item.statistics.likeCount), comments: num(item.statistics.commentCount), shares: null, engagement_velocity: null,
        ...rights,
        // provenance signals double as copyright-risk hints for the reviewer; the LLM scorer refines them
        copyright_risk: prov.risk === 'high' ? 'high' : null,
        copyright_risk_reasons: prov.reasons.length ? JSON.stringify(prov.reasons) : null,
      });
    }
  }
  return out;
}

async function youtubeChannelStats(cfg: Config, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 50) {
    const sp = new URLSearchParams({ part: 'statistics', id: ids.slice(i, i + 50).join(','), key: cfg.youtubeKey! });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?${sp}`);
    if (!res.ok) continue;
    const j = (await res.json()) as { items: { id: string; statistics: { videoCount?: string } }[] };
    for (const c of j.items) out.set(c.id, Number(c.statistics.videoCount ?? 0));
  }
  return out;
}

interface YtVideo {
  id: string;
  snippet: { title: string; description?: string; channelTitle: string; channelId: string; publishedAt: string };
  statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails: { duration: string; contentRating?: { ytRating?: string } };
  status: { license: string; embeddable?: boolean };
}

export function isoDurationSec(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
const num = (s?: string) => (s == null ? null : Number(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function dedupeById(cs: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return cs.filter((c) => { const k = `${c.source_platform}:${c.source_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
