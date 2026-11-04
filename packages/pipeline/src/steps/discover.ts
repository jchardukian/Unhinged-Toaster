import { ccProvenanceRisk, qualityTier, ulid, initialRights, type Candidate, type ContentCategory, type SourceAdapter, type SourcePlatform } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { withRetry } from '../retry.js';
import { ytdlpJson } from './media.js';

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
        : s === 'reddit_rss' ? await discoverRedditRss(cfg, opts.limitPerSource)
        : s === 'tiktok' ? await discoverTikTok(cfg, opts.limitPerSource)
        : s === 'youtube_search' ? await discoverYouTubeSearch(cfg, opts.limitPerSource)
        : s === 'youtube_viral' ? await discoverYouTubeViral(cfg, opts.limitPerSource)
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
export const REDDIT_SOURCES: { sub: string; category: ContentCategory; guess?: boolean }[] = [
  // TikTok re-posts: the sub is a mirror of what already went viral on TikTok (watermarks are usually stripped, so the
  // original creator is credited only when the two-frame watermark reader can still see a handle)
  { sub: 'TikTokCringe', category: 'unbelievable', guess: true },
  { sub: 'funnyvideos', category: 'people_fails', guess: true },
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

/**
 * Credential-free Reddit discovery via the public Atom feeds (`/r/<sub>/top/.rss?t=day`), which stay reachable where
 * the JSON API refuses unauthenticated datacenter traffic. The feed carries title, poster, permalink and the v.redd.it
 * media id; score/comment counts are not included, so a rank-based proxy is stored and the LLM rubric carries the
 * weight. Used automatically when no Reddit app credentials are configured.
 */
export async function discoverRedditRss(cfg: Config, limit: number, windows: ('day' | 'week' | 'month')[] = cfg.redditWindows): Promise<Candidate[]> {
  const now = new Date().toISOString();
  const out: Candidate[] = [];
  const ua = cfg.reddit.userAgent.includes('Mozilla') ? cfg.reddit.userAgent : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  // two timeframes: top of the day (gaining traction right now) and top of the week/month (proven over a longer window)
  for (const window of windows.length ? windows : ['day' as const]) {
    for (const { sub, category, guess } of REDDIT_SOURCES) {
      let xml: string;
      try {
        const res = await withRetry(`reddit rss r/${sub}`, async () => {
          const r = await fetch(`https://www.reddit.com/r/${sub}/top/.rss?t=${window}&limit=${Math.min(100, limit)}`, { headers: { 'user-agent': ua, accept: 'application/atom+xml,application/xml' } });
          if (r.status === 429 || r.status >= 500) throw new Error(`reddit rss ${r.status}`);
          return r;
        }, { attempts: 3, baseMs: 2500 });
        if (!res.ok) { log.warn(`reddit rss r/${sub} -> ${res.status}`); continue; }
        xml = await res.text();
      } catch (e) { log.warn(`reddit rss r/${sub} failed: ${(e as Error).message}`); continue; }
      const entries = parseRedditAtom(xml);
      entries.forEach((e, rank) => {
        if (!e.mediaId) return;
        out.push({
          ...base('reddit', now),
          source_id: e.postId, source_url: e.link, media_url: `https://v.redd.it/${e.mediaId}/DASH_1080.mp4`,
          author: e.author, author_url: e.author ? `https://www.reddit.com/user/${e.author}` : null,
          title: e.title, description: `r/${sub} (top of ${window}, rank ${rank + 1}; stats unavailable via RSS)`, category: guess ? guessCategory(e.title) : category,
          duration_sec: null, width: null, height: null, published_at: e.published,
          views: null, likes: Math.max(50, Math.round(3000 / (rank + 1))), comments: null, shares: null, engagement_velocity: null, // rank proxy only
          ...initialRights('reddit', {}),
        });
      });
      await sleep(2000); // the feeds answer 429 when hit faster than this
    }
  }
  return dedupeById(out);
}

// ---------------------------------------------------------------- TikTok (creator accounts via yt-dlp; real view/like/comment/repost counts)
/**
 * TikTok has no public API for third-party discovery and its hashtag pages block scrapers, but creator profile pages
 * work through yt-dlp and expose per-video engagement. The owner curates `TIKTOK_ACCOUNTS` (original creators, not
 * compilation/licensing accounts); recent videos are ranked by views. Footage goes to transformation review.
 */
export async function discoverTikTok(cfg: Config, limit: number, maxAgeDays = 14): Promise<Candidate[]> {
  if (cfg.tiktokAccounts.length === 0) throw new Error('TIKTOK_ACCOUNTS not set (comma-separated creator handles)');
  const now = new Date().toISOString();
  const out: Candidate[] = [];
  const minTs = Date.now() / 1000 - maxAgeDays * 86400;
  for (const handle of cfg.tiktokAccounts) {
    const rows = await ytdlpJson(`https://www.tiktok.com/@${handle}`, { flat: true, limit: Math.min(60, limit) }).catch(() => []);
    log.info(`tiktok @${handle}: ${rows.length} recent videos`);
    for (const r of rows) {
      const id = String(r.id ?? '');
      const dur = Number(r.duration ?? 0);
      const ts = Number(r.timestamp ?? 0);
      if (!id || dur < 4 || dur > 55) continue;
      if (ts && ts < minTs) continue;
      const title = String(r.title ?? r.description ?? '').trim() || `TikTok by @${handle}`;
      const prov = ccProvenanceRisk({ title, description: String(r.description ?? ''), channelTitle: handle, durationSec: dur });
      out.push({
        ...base('tiktok', now),
        source_id: id, source_url: String(r.webpage_url ?? r.url ?? `https://www.tiktok.com/@${handle}/video/${id}`), media_url: null,
        author: handle, author_url: `https://www.tiktok.com/@${handle}`, title: title.slice(0, 200), description: String(r.description ?? '').slice(0, 500) || null,
        category: guessCategory(title), duration_sec: dur, width: numOr(r.width), height: numOr(r.height),
        published_at: ts ? new Date(ts * 1000).toISOString() : null,
        views: numOr(r.view_count), likes: numOr(r.like_count), comments: numOr(r.comment_count), shares: numOr(r.repost_count), engagement_velocity: null,
        ...initialRights('tiktok', {}),
        copyright_risk: prov.risk === 'high' ? 'high' : null, copyright_risk_reasons: prov.reasons.length ? JSON.stringify(prov.reasons) : null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- YouTube search via yt-dlp (no API key; real view/like counts)
const YT_SEARCH_QUERIES: { q: string; category: ContentCategory }[] = [
  { q: 'funny dog fail #shorts', category: 'funny_animals' },
  { q: 'cat fail #shorts', category: 'funny_animals' },
  { q: 'instant regret fail #shorts', category: 'people_fails' },
  { q: 'unexpected ending #shorts', category: 'unbelievable' },
  { q: 'wholesome surprise reaction #shorts', category: 'wholesome_reactions' },
];

export async function discoverYouTubeSearch(cfg: Config, limit: number): Promise<Candidate[]> {
  if (!cfg.enableYoutubeTransform) throw new Error('YouTube search source disabled: set ENABLE_YOUTUBE_TRANSFORM=true (see docs/SOURCES.md)');
  const now = new Date().toISOString();
  const out: Candidate[] = [];
  for (const { q, category } of YT_SEARCH_QUERIES) {
    const rows = await ytdlpJson(`ytsearch${Math.min(30, limit)}:${q}`, { youtube: true }).catch(() => []);
    for (const r of rows) {
      const id = String(r.id ?? ''); const dur = Number(r.duration ?? 0);
      if (!id || dur < 4 || dur > 60) continue;
      const title = String(r.title ?? '');
      const channel = String(r.channel ?? r.uploader ?? '');
      const license = String(r.license ?? '');
      const prov = ccProvenanceRisk({ title, description: String(r.description ?? ''), channelTitle: channel, durationSec: dur });
      const rights = /creative commons/i.test(license)
        ? initialRights('youtube', { license: 'creativeCommon', provenanceRisk: prov.risk, provenanceReasons: prov.reasons, evidenceSuffix: `; yt-dlp license field "${license}"` })
        : initialRights('youtube', { license: 'youtube' });
      out.push({
        ...base('youtube', now), source_id: id, source_url: `https://www.youtube.com/watch?v=${id}`, media_url: null,
        author: channel, author_url: r.channel_url ? String(r.channel_url) : null, title, description: String(r.description ?? '').slice(0, 500) || null,
        category, duration_sec: dur, width: numOr(r.width), height: numOr(r.height), published_at: r.timestamp ? new Date(Number(r.timestamp) * 1000).toISOString() : null,
        views: numOr(r.view_count), likes: numOr(r.like_count), comments: numOr(r.comment_count), shares: null, engagement_velocity: null,
        ...rights, copyright_risk: prov.risk === 'high' ? 'high' : null, copyright_risk_reasons: prov.reasons.length ? JSON.stringify(prov.reasons) : null,
      });
    }
  }
  return dedupeById(out);
}

const numOr = (v: unknown) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

// ---------------------------------------------------------------- YouTube virals without an API key or creator handles (yt-dlp; transformation review)
/**
 * Finds Shorts that have ALREADY gone viral on YouTube. The hashtag Shorts shelves (youtube.com/hashtag/<tag>/shorts)
 * list the most-viewed Shorts per tag – from clips uploaded days ago that are racking up 100k+ views an hour to
 * evergreen giants with hundreds of millions of views. Shelf rows carry only id / title / views, so the best rows are
 * enriched with batched metadata calls (duration, upload date, size, likes, channel) and then bucketed by timeframe:
 *  - today / week / month ("just went viral", "gaining traction"): uploaded within the window, ranked by views per hour;
 *  - alltime ("proven"): the shelf's most-viewed, any age.
 * (YouTube search with upload-date filters was tried and dropped: sorted by views or relevance it returns 2–4 minute
 * compilations, zero Shorts-length rows with 10k+ views across 6 queries.) Everything lands in transformation review
 * with the real view / like counts (standard YouTube licence = no licence on file; CC BY with low provenance risk is
 * cleared). No credentials. TikTok has no equivalent that works from a server (yt-dlp's tag / search / sound
 * extractors are broken and the tag pages ship no items), see docs/SOURCES.md.
 */
export const YT_VIRAL_TAGS: { tag: string; category: ContentCategory }[] = [
  { tag: 'funny', category: 'people_fails' }, { tag: 'fails', category: 'people_fails' }, { tag: 'fail', category: 'people_fails' },
  { tag: 'instantkarma', category: 'people_fails' }, { tag: 'funnyvideos', category: 'people_fails' }, { tag: 'comedy', category: 'people_fails' },
  { tag: 'funnyanimals', category: 'funny_animals' }, { tag: 'funnycats', category: 'funny_animals' }, { tag: 'funnydogs', category: 'funny_animals' },
  { tag: 'cats', category: 'funny_animals' }, { tag: 'dogs', category: 'funny_animals' }, { tag: 'animals', category: 'funny_animals' },
  { tag: 'unexpected', category: 'unbelievable' }, { tag: 'waitforit', category: 'unbelievable' }, { tag: 'caughtoncamera', category: 'unbelievable' },
  { tag: 'wholesome', category: 'wholesome_reactions' }, { tag: 'heartwarming', category: 'wholesome_reactions' }, { tag: 'reaction', category: 'wholesome_reactions' },
];
export type YtViralWindow = 'today' | 'week' | 'month' | 'alltime';
const YT_VIRAL_MIN_SEC = 5, YT_VIRAL_MAX_SEC = 58;
const YT_WINDOW_MAX_AGE_H: Record<Exclude<YtViralWindow, 'alltime'>, number> = { today: 24, week: 7 * 24, month: 31 * 24 };
const YT_WINDOW_MIN_VIEWS: Record<YtViralWindow, number> = { today: 20_000, week: 100_000, month: 500_000, alltime: 1_000_000 };

/** Share of letters that are Latin script; the channel is English-language, so clips captioned in other scripts are skipped. */
export function latinRatio(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 1;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length;
}

export function viewsPerHour(views: number | null, uploadedAt: Date | null, now = new Date()): number | null {
  if (views == null || !uploadedAt) return null;
  const hours = Math.max(1, (now.getTime() - uploadedAt.getTime()) / 3600000);
  return Math.round(views / hours);
}

/** Freshest window a clip qualifies for (today > week > month > alltime), or null. Pure, for tests. */
export function ytViralBucket(windows: YtViralWindow[], ageHours: number | null, views: number): YtViralWindow | null {
  for (const w of ['today', 'week', 'month'] as const) if (windows.includes(w) && ageHours != null && ageHours <= YT_WINDOW_MAX_AGE_H[w] && views >= YT_WINDOW_MIN_VIEWS[w]) return w;
  return windows.includes('alltime') && views >= YT_WINDOW_MIN_VIEWS.alltime ? 'alltime' : null;
}

function ytDate(r: Record<string, unknown>): Date | null {
  if (r.timestamp) return new Date(Number(r.timestamp) * 1000);
  const d = String(r.upload_date ?? '');
  return /^\d{8}$/.test(d) ? new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00Z`) : null;
}

interface YtViralRow { id: string; title: string; views: number | null; category: ContentCategory; window: YtViralWindow; via: string; row: Record<string, unknown> }

export async function discoverYouTubeViral(cfg: Config, limit: number, windows: YtViralWindow[] = cfg.youtubeViralWindows): Promise<Candidate[]> {
  if (!cfg.enableYoutubeTransform) throw new Error('YouTube viral source disabled: set ENABLE_YOUTUBE_TRANSFORM=true (see docs/SOURCES.md)');
  if (windows.length === 0) windows = ['alltime'];
  const now = new Date();
  const rows: YtViralRow[] = [];
  const perList = Math.min(40, Math.max(15, limit));
  for (const { tag, category } of YT_VIRAL_TAGS) {
    const found = await ytdlpJson(`https://www.youtube.com/hashtag/${tag}/shorts`, { flat: true, limit: perList, youtube: true }).catch(() => []);
    log.info(`youtube_viral #${tag} shelf: ${found.length} rows`);
    for (const r of found) rows.push({ id: String(r.id ?? ''), title: String(r.title ?? ''), views: numOr(r.view_count), category, window: 'alltime', via: `#${tag} Shorts shelf`, row: r });
  }
  // pre-filter on what the flat rows tell us, rank by views, dedupe, then enrich the top rows in batches of 20.
  // The enrichment call is retried because YouTube's bot wall is intermittent from datacenter IPs (the same batch
  // failed and succeeded seconds apart in the probe).
  const pool = [...new Map(rows.filter((r) => r.id).map((r) => [r.id, r])).values()].filter((r) => {
    const dur = numOr(r.row.duration);
    if (dur != null && (dur < YT_VIRAL_MIN_SEC || dur > YT_VIRAL_MAX_SEC)) return false;
    if (r.row.live_status && r.row.live_status !== 'not_live' && r.row.live_status !== 'was_live') return false;
    if (latinRatio(r.title) < 0.6) return false;
    return (r.views ?? 0) >= YT_WINDOW_MIN_VIEWS.today;
  }).sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const picked = pool.slice(0, Math.min(80, Math.max(40, limit * 2)));
  log.info(`youtube_viral shelf rows: ${rows.length} -> unique after filters ${pool.length} -> enriching ${picked.length}`);
  if (picked.length === 0) return [];
  const meta = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < picked.length; i += 20) {
    const batch = picked.slice(i, i + 20);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const missing = batch.filter((r) => !meta.has(r.id));
      if (missing.length === 0) break;
      const full = await ytdlpJson(missing.map((r) => `https://www.youtube.com/watch?v=${r.id}`), { youtube: true }).catch(() => []);
      for (const m of full) if (m.id) meta.set(String(m.id), m);
      if (full.length < missing.length && attempt < 4) { log.warn(`youtube_viral metadata: ${missing.length - full.length}/${missing.length} missing (bot wall?), retry ${attempt}`); await sleep(5000 * attempt); }
    }
  }
  log.info(`youtube_viral enriched ${meta.size}/${picked.length}`);
  const out: Candidate[] = [];
  const dropped: Record<string, number> = {};
  const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1; };
  for (const r of picked) {
    const m = meta.get(r.id);
    if (!m) { drop('no_metadata'); continue; }
    const dur = numOr(m.duration);
    if (dur == null || dur < YT_VIRAL_MIN_SEC || dur > YT_VIRAL_MAX_SEC) { drop('duration'); continue; }
    if (m.age_limit && Number(m.age_limit) >= 18) { drop('age_limit'); continue; }
    const uploadedAt = ytDate(m);
    const ageH = uploadedAt ? (now.getTime() - uploadedAt.getTime()) / 3600000 : null;
    const viewsNow = numOr(m.view_count) ?? r.views ?? 0;
    const bucket = ytViralBucket(windows, ageH, viewsNow);
    if (!bucket) { drop(ageH == null ? 'no_date' : 'below_window_threshold'); continue; }
    r.window = bucket;
    r.via = bucket === 'alltime' ? `${r.via} (all-time most viewed)` : `${r.via}, uploaded ${Math.round(ageH!)}h ago`;
    const title = String(m.title ?? r.title).trim();
    const channel = String(m.channel ?? m.uploader ?? '');
    const description = String(m.description ?? '');
    const license = String(m.license ?? '');
    const views = numOr(m.view_count) ?? r.views;
    const uploaded = uploadedAt;
    const velocity = viewsPerHour(views, uploaded, now);
    const prov = ccProvenanceRisk({ title, description, channelTitle: channel, durationSec: dur });
    const rights = /creative commons/i.test(license)
      ? initialRights('youtube', { license: 'creativeCommon', provenanceRisk: prov.risk, provenanceReasons: prov.reasons, evidenceSuffix: `; yt-dlp license field "${license}"` })
      : initialRights('youtube', { license: 'youtube' });
    const w = numOr(m.width), h = numOr(m.height);
    out.push({
      ...base('youtube', now.toISOString()), source_id: r.id, source_url: `https://www.youtube.com/watch?v=${r.id}`, media_url: null,
      author: channel || null, author_url: m.channel_url ? String(m.channel_url) : m.uploader_url ? String(m.uploader_url) : null,
      title: title.slice(0, 200), description: `YouTube viral (${r.window}): ${r.via} | ${fmtCount(views)} views${velocity != null ? `, ${fmtCount(velocity)}/h` : ''}${description ? `\n${description.slice(0, 300)}` : ''}`,
      category: r.category, duration_sec: dur, width: w, height: h, published_at: uploaded ? uploaded.toISOString() : null,
      views, likes: numOr(m.like_count), comments: numOr(m.comment_count), shares: null, engagement_velocity: velocity,
      ...rights, quality_tier: w && h ? qualityTier(w, h) : undefined,
      copyright_risk: prov.risk === 'high' ? 'high' : null, copyright_risk_reasons: prov.reasons.length ? JSON.stringify(prov.reasons) : null,
    });
  }
  const byWindow: Record<string, number> = {};
  for (const c of out) { const w = c.description?.match(/^YouTube viral \((\w+)\)/)?.[1] ?? '?'; byWindow[w] = (byWindow[w] ?? 0) + 1; }
  log.info(`youtube_viral candidates by window: ${JSON.stringify(byWindow)}; dropped ${JSON.stringify(dropped)}`);
  return dedupeById(out);
}

export function fmtCount(n: number | null): string {
  if (n == null) return '?';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

export interface RedditAtomEntry { postId: string; title: string; link: string; author: string | null; published: string | null; mediaId: string | null }

export function parseRedditAtom(xml: string): RedditAtomEntry[] {
  const out: RedditAtomEntry[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml))) {
    const e = m[1];
    const title = decodeXml(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const link = e.match(/<link href="([^"]+)"/)?.[1] ?? '';
    const author = e.match(/<name>\/u\/([^<]+)<\/name>/)?.[1] ?? null;
    const published = e.match(/<published>([^<]+)<\/published>/)?.[1] ?? null;
    const content = decodeXml(e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? '');
    const mediaId = content.match(/https:\/\/v\.redd\.it\/([a-z0-9]+)/)?.[1] ?? null;
    const postId = link.match(/\/comments\/([a-z0-9]+)/)?.[1] ?? '';
    if (postId && title) out.push({ postId, title, link, author, published, mediaId });
  }
  return out;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

export async function discoverReddit(cfg: Config, limit: number): Promise<Candidate[]> {
  const token = await redditToken(cfg);
  const now = new Date().toISOString();
  const out: Candidate[] = [];
  for (const window of cfg.redditWindows.length ? cfg.redditWindows : ['day' as const]) {
    for (const { sub, category, guess } of REDDIT_SOURCES) {
      const res = await fetch(`https://oauth.reddit.com/r/${sub}/top?t=${window}&limit=${Math.min(100, limit)}&raw_json=1`, {
        headers: { authorization: `Bearer ${token}`, 'user-agent': cfg.reddit.userAgent },
      });
      if (!res.ok) { log.warn(`reddit r/${sub} -> ${res.status}`); continue; }
      const j = (await res.json()) as { data: { children: RedditChild[] } };
      for (const ch of j.data.children) {
        const d = ch.data.crosspost_parent_list?.[0] ?? ch.data;
        const rv = d.media?.reddit_video ?? d.secure_media?.reddit_video;
        if (!d.is_video || !rv || d.over_18 || d.is_gallery) continue;
        if (rv.duration < 4 || rv.duration > 50) continue;
        out.push(parseRedditCandidate(ch.data, d, rv, guess ? guessCategory(d.title) : category, now));
      }
      await sleep(700);
    }
  }
  return dedupeById(out);
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
