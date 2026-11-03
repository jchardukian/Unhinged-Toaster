import { ulid, initialRights, type Candidate, type ContentCategory, type SourcePlatform } from '@toaster/shared';
import { log, type Config } from '../config.js';

/**
 * Discovery adapters. Each returns Candidate rows in status 'discovered' with the rights status that
 * the source legitimately supports (see shared/rights.ts). Nothing here downloads media.
 */

export interface DiscoverOptions { sources: SourcePlatform[]; limitPerSource: number }

export async function discoverAll(cfg: Config, opts: DiscoverOptions): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const s of opts.sources) {
    try {
      const found =
        s === 'reddit' ? await discoverReddit(cfg, opts.limitPerSource)
        : s === 'youtube' ? await discoverYouTube(cfg, opts.limitPerSource)
        : s === 'pexels' ? await discoverPexels(cfg, opts.limitPerSource)
        : [];
      log.info(`discover:${s} -> ${found.length} candidates`);
      out.push(...found);
    } catch (e) {
      log.error(`discover:${s} failed:`, (e as Error).message);
    }
  }
  return out;
}

function base(platform: SourcePlatform, now: string): Pick<Candidate, 'id' | 'discovered_at' | 'updated_at' | 'status' | 'status_reason' | 'heuristic_score' | 'llm_score' | 'final_score' | 'llm_rationale' | 'safety_flags' | 'phash' | 'duplicate_of' | 'attribution_text' | 'category' | 'source_platform'> {
  return {
    id: ulid(), discovered_at: now, updated_at: now, status: 'discovered', status_reason: null,
    heuristic_score: null, llm_score: null, final_score: null, llm_rationale: null, safety_flags: null,
    phash: null, duplicate_of: null, attribution_text: null, category: null, source_platform: platform,
  };
}

// ---------------------------------------------------------------- Reddit
/** Subreddits mapped to our content categories. Only video posts 4-50s, SFW. */
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
    await new Promise((r) => setTimeout(r, 700)); // stay well under 100 QPM
  }
  return out;
}

export function parseRedditCandidate(post: RedditChild['data'], d: RedditChild['data'], rv: NonNullable<NonNullable<RedditChild['data']['media']>['reddit_video']>, category: ContentCategory, now: string): Candidate {
  return {
    ...base('reddit', now),
    source_id: d.id,
    source_url: `https://www.reddit.com${d.permalink}`,
    media_url: rv.fallback_url,
    author: d.author,
    author_url: `https://www.reddit.com/user/${d.author}`,
    title: d.title,
    description: d.selftext?.slice(0, 500) || `r/${post.subreddit}`,
    category,
    duration_sec: rv.duration,
    width: rv.width,
    height: rv.height,
    published_at: new Date(d.created_utc * 1000).toISOString(),
    views: null,
    likes: d.score,
    comments: d.num_comments,
    shares: d.num_crossposts ?? 0,
    engagement_velocity: null,
    ...initialRights('reddit', {}),
  };
}

// ---------------------------------------------------------------- YouTube (Creative Commons only)
const YT_QUERIES: { q: string; category: ContentCategory }[] = [
  { q: 'funny fail', category: 'people_fails' },
  { q: 'funny animals', category: 'funny_animals' },
  { q: 'funny dog cat', category: 'funny_animals' },
  { q: 'unbelievable moment caught on camera', category: 'unbelievable' },
  { q: 'wholesome reaction surprise', category: 'wholesome_reactions' },
];

export async function discoverYouTube(cfg: Config, limit: number): Promise<Candidate[]> {
  if (!cfg.youtubeKey) throw new Error('YOUTUBE_API_KEY not set');
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
    for (const item of v.items) {
      if (item.status.license !== 'creativeCommon') continue; // re-verify; search filter is not authoritative
      if (item.contentDetails.contentRating?.ytRating === 'ytAgeRestricted') continue;
      const dur = isoDurationSec(item.contentDetails.duration);
      if (dur < 4 || dur > 60) continue;
      out.push({
        ...base('youtube', now),
        source_id: item.id,
        source_url: `https://www.youtube.com/watch?v=${item.id}`,
        media_url: null, // resolved at download time (yt-dlp)
        author: item.snippet.channelTitle,
        author_url: `https://www.youtube.com/channel/${item.snippet.channelId}`,
        title: item.snippet.title,
        description: item.snippet.description?.slice(0, 500) ?? null,
        category,
        duration_sec: dur,
        width: null, height: null,
        published_at: item.snippet.publishedAt,
        views: num(item.statistics.viewCount),
        likes: num(item.statistics.likeCount),
        comments: num(item.statistics.commentCount),
        shares: null,
        engagement_velocity: null,
        ...initialRights('youtube', { license: item.status.license }),
      });
    }
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

// ---------------------------------------------------------------- Pexels (free license, stock-style; low viral value, useful filler)
export async function discoverPexels(cfg: Config, limit: number): Promise<Candidate[]> {
  if (!cfg.pexelsKey) throw new Error('PEXELS_API_KEY not set');
  const now = new Date().toISOString();
  const out: Candidate[] = [];
  for (const { q, category } of [{ q: 'funny dog', category: 'funny_animals' as ContentCategory }, { q: 'funny cat', category: 'funny_animals' as ContentCategory }]) {
    const res = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=${Math.min(80, limit)}`, { headers: { authorization: cfg.pexelsKey } });
    if (!res.ok) continue;
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
  }
  return out;
}
