import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { broadcastRisk, ccProvenanceRisk, clamp, HARD_BLOCK_FLAGS, hamming, initialRights, phashFrame, round1, SOFT_FLAGS, titleSimilarity, type Candidate, type CopyrightRisk } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { budget, isFatal, spentUsd } from '../guard.js';
import { chatJson } from '../llm.js';
import { costOf, currentUsage } from '../usage.js';
import { discoverRedditRss, discoverTikTok, fmtCount, isDogText, latinRatio, REDDIT_DOG_SOURCES, viewsPerHour, YT_DOG_TAGS } from './discover.js';
import { isCreatorHandle } from './frames.js';
import { fetchToFile, run, ytdlpJson } from './media.js';

const execFileP = promisify(execFile);

/**
 * Viral funny-dog discovery shortlist (discovery only: nothing is stored, rendered, drafted or published).
 *
 * YouTube: hashtag Shorts shelves (no key, no cookies) -> exact metadata through the embedded-player client (view
 * count, duration, upload date; the default clients are bot-walled from datacenter IPs) -> three real frames of the
 * video from the thumbnail CDN (oar1/2/3 at 25/50/75 %, 1080x1920) -> vision scoring for a genuine comedic payoff.
 * TikTok: creator pages via yt-dlp (exact views) for handles the owner lists plus handles read from TikTok watermarks
 * in the YouTube re-uploads; TikTok has no tag / search discovery that works from a server (re-checked 2026-11-07).
 * Reddit: dog communities via RSS (no view counts exist there; listed separately, never counted as "1M+ verified").
 *
 * Rights are untouched: a view count is popularity, not permission. Every standard-licence clip stays
 * transformation_review (owner decides per draft), CC BY with low provenance risk is cleared, high copyright risk blocks.
 */
export const MIN_VERIFIED_VIEWS = 1_000_000;
export const SHELF_PREFILTER_VIEWS = 900_000;       // shelf counts are rounded ("1M views"): verify everything near the bar
export const COMEDY_THRESHOLD = 50;                 // 0-100, from the dog rubric below (gpt-4o-mini scores proven 20M-view virals 45-56)
export const PAYOFF_BAR = 4;                        // rubric payoff below this = no clear comedic payoff
export const DOG_MIN_SEC = 4, DOG_MAX_SEC = 58;
export const FRAME_DUP_HAMMING = 8;                 // single-frame perceptual hash distance treated as the same footage
const MAX_TIKTOK_HANDLES = 12;

export interface DogRubric {
  is_dog_comedy: boolean; single_clip: boolean; funny: number; payoff: number; clarity: number; originality: number; quality: number;
  ai_generated_suspected?: boolean; funniest_moment?: string | null; visual_summary?: string | null; safety_flags: string[];
  copyright_risk?: string; copyright_risk_reasons?: string[]; detected_handle?: string | null; detected_platform?: string | null; rationale?: string;
}
/**
 * hard reasons exclude a clip from the shortlist entirely (safety, not a dog, compilation, low quality, AI fake);
 * soft reasons (weak payoff, comedy below the bar) keep it ranked but flagged, so the owner always sees the strongest N.
 */
export interface DogJudgement { comedy: number; accepted: boolean; reasons: string[]; hard: string[]; soft: string[] }

/** Pure decision rule: comedy score 0-100 plus accept / reject reasons. Rejects compilations, no payoff, low quality, AI fakes, safety blocks. */
export function judgeDog(r: DogRubric): DogJudgement {
  const hardReasons: string[] = [];
  const soft: string[] = [];
  const hardFlag = r.safety_flags.find((f) => HARD_BLOCK_FLAGS.has(f));
  if (hardFlag) hardReasons.push(`safety:${hardFlag}`);
  if (!r.is_dog_comedy) hardReasons.push('not_dog_comedy');
  if (!r.single_clip) hardReasons.push('compilation_or_multi_clip');
  if (r.quality < 4) hardReasons.push('low_quality_footage');
  if (r.ai_generated_suspected) hardReasons.push('ai_generated_suspected');
  if (r.payoff < PAYOFF_BAR) soft.push('no_clear_payoff');
  const softFlags = r.safety_flags.filter((f) => SOFT_FLAGS.has(f)).length;
  const comedy = hardFlag ? 0 : round1(clamp((r.funny * 0.4 + r.payoff * 0.3 + r.clarity * 0.15 + r.originality * 0.15) * 10 - softFlags * 6, 0, 100));
  if (!hardFlag && comedy < COMEDY_THRESHOLD) soft.push(`comedy ${comedy} < ${COMEDY_THRESHOLD}`);
  const reasons = [...hardReasons, ...soft];
  return { comedy, accepted: reasons.length === 0, reasons, hard: hardReasons, soft };
}

/** Pure: 0-100 from views per hour on a log scale (100/h -> 40, 1k/h -> 60, 10k/h -> 80, 100k/h -> 100); null when unknown. */
export function velocityScore(viewsPerHourValue: number | null): number {
  if (viewsPerHourValue == null) return 0;
  return round1(clamp((Math.log10(Math.max(viewsPerHourValue, 1)) / 5) * 100, 0, 100));
}
/** Pure: shortlist rank = comedy first (80 %), recent momentum second (20 %). */
export function rankScore(comedy: number, viewsPerHourValue: number | null): number {
  return round1(comedy * 0.8 + velocityScore(viewsPerHourValue) * 0.2);
}

export interface ShortlistRow {
  rank?: number; title: string; platform: 'youtube' | 'tiktok' | 'reddit'; url: string; channel: string | null;
  views: number | null; views_verified: string; views_per_hour: number | null; published_at: string | null;
  duration_sec: number | null; comedy: number; rank_score: number; rights_status: string; rights_label: string; copyright_risk: CopyrightRisk | null;
  funniest_moment: string | null; visual_summary: string | null; rationale: string | null; detected_handle: string | null; detected_platform: string | null;
  frames: string[]; phash: string[]; accepted: boolean; reasons: string[]; via: string;
  /** rubric scores 0-10 (funny, payoff, clarity, originality, quality) for calibration */
  rubric?: { funny: number; payoff: number; clarity: number; originality: number; quality: number } | null;
  /** 'pass' when every gate passed, else the soft reasons (weak payoff / comedy below bar); hard-rejected rows never reach the shortlist */
  gate?: string;
}

/** Pure: same footage already kept? (same URL, near-identical frames, or same title with the same length). */
export function isDuplicateRow(row: Pick<ShortlistRow, 'url' | 'title' | 'duration_sec' | 'phash'>, kept: Pick<ShortlistRow, 'url' | 'title' | 'duration_sec' | 'phash'>[]): string | null {
  for (const k of kept) {
    if (k.url === row.url) return 'same_url';
    for (const a of row.phash) for (const b of k.phash) if (hamming(a, b) <= FRAME_DUP_HAMMING) return `frame_phash_${hamming(a, b)}`;
    const sim = titleSimilarity(row.title, k.title);
    const durClose = row.duration_sec != null && k.duration_sec != null && Math.abs(row.duration_sec - k.duration_sec) <= 1.5;
    if (sim >= 0.8 && durClose) return `title_sim_${sim.toFixed(2)}`;
  }
  return null;
}

/** Pure: human label for the rights column. Never upgrades anything: popularity is not permission. */
export function rightsLabel(c: Pick<Candidate, 'rights_status' | 'rights_basis' | 'copyright_risk'>, maxRisk: Config['maxCopyrightRisk']): string {
  if (c.rights_status === 'cleared') return `cleared (${c.rights_basis ?? 'license'})`;
  if (c.rights_status === 'transformation_review') {
    if (c.copyright_risk === 'high') return 'blocked: copyright risk high';
    const order = { low: 0, medium: 1, high: 2 } as const;
    const risk = c.copyright_risk ?? 'medium';
    return order[risk] <= order[maxRisk] ? `review-eligible (no licence; risk ${risk}; owner decides per draft)` : `blocked: risk ${risk} > MAX_COPYRIGHT_RISK`;
  }
  return c.rights_status;
}

// ---------------------------------------------------------------- YouTube: hashtag Shorts shelves -> embedded-player metadata (verified views)
export interface YtDogStats { shelfRows: number; unique: number; prefiltered: number; enriched: number; verified1M: number; dropped: Record<string, number> }
const numOr = (v: unknown) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

/** Pure: embedded-player metadata row -> candidate (null with a reason when it fails the bar). */
export function dogCandidateFromMeta(m: Record<string, unknown>, via: string, now: Date): { candidate: Candidate | null; reason: string | null } {
  const id = String(m.id ?? '');
  const views = numOr(m.view_count);
  if (!id || views == null) return { candidate: null, reason: 'no_metadata' };
  if (views < MIN_VERIFIED_VIEWS) return { candidate: null, reason: 'below_1m_verified' };
  const dur = numOr(m.duration);
  if (dur != null && dur < DOG_MIN_SEC) return { candidate: null, reason: 'too_short' };
  if (dur != null && dur > DOG_MAX_SEC) return { candidate: null, reason: 'too_long_for_short' };
  if (m.age_limit && Number(m.age_limit) >= 18) return { candidate: null, reason: 'age_limit' };
  const title = String(m.title ?? '').trim();
  if (latinRatio(title) < 0.6) return { candidate: null, reason: 'non_latin_title' };
  const uploadedAt = m.timestamp ? new Date(Number(m.timestamp) * 1000) : /^\d{8}$/.test(String(m.upload_date ?? '')) ? new Date(`${String(m.upload_date).slice(0, 4)}-${String(m.upload_date).slice(4, 6)}-${String(m.upload_date).slice(6, 8)}T12:00:00Z`) : null;
  const channel = String(m.channel ?? m.uploader ?? '');
  const description = String(m.description ?? '');
  const license = String(m.license ?? '');
  const prov = ccProvenanceRisk({ title, description, channelTitle: channel, durationSec: dur });
  const bc = broadcastRisk(`${title}\n${description}`);
  const rights = /creative commons/i.test(license)
    ? initialRights('youtube', { license: 'creativeCommon', provenanceRisk: prov.risk, provenanceReasons: prov.reasons, evidenceSuffix: `; yt-dlp license field "${license}"` })
    : initialRights('youtube', { license: 'youtube' });
  const high = prov.risk === 'high' || bc.high;
  const velocity = viewsPerHour(views, uploadedAt, now);
  const candidate: Candidate = {
    id: `yt_${id}`, discovered_at: now.toISOString(), updated_at: now.toISOString(), status: 'discovered', status_reason: null,
    heuristic_score: null, llm_score: null, final_score: null, llm_rationale: null, safety_flags: null, phash: null, duplicate_of: null, attribution_text: null,
    source_platform: 'youtube', source_id: id, source_url: `https://www.youtube.com/shorts/${id}`, media_url: null,
    author: channel || null, author_url: m.channel_url ? String(m.channel_url) : m.uploader_url ? String(m.uploader_url) : null,
    title: title.slice(0, 200), description: `${via} | ${fmtCount(views)} views verified (embedded player metadata)${velocity != null ? `, ${fmtCount(velocity)}/h` : ''}${description ? `\n${description.slice(0, 300)}` : ''}`,
    category: 'funny_animals', duration_sec: dur, width: numOr(m.width), height: numOr(m.height), published_at: uploadedAt ? uploadedAt.toISOString() : null,
    views, likes: numOr(m.like_count), comments: numOr(m.comment_count), shares: null, engagement_velocity: velocity,
    ...rights, copyright_risk: high ? 'high' : null, copyright_risk_reasons: high ? JSON.stringify([...prov.reasons, ...bc.reasons]) : null,
  };
  return { candidate, reason: null };
}

export async function discoverYouTubeDogShorts(cfg: Config, limit: number, tags: string[] = YT_DOG_TAGS): Promise<{ candidates: Candidate[]; stats: YtDogStats }> {
  if (!cfg.enableYoutubeTransform) throw new Error('YouTube sources disabled: set ENABLE_YOUTUBE_TRANSFORM=true');
  const now = new Date();
  const rows = new Map<string, { id: string; title: string; views: number | null; via: string }>();
  let shelfRows = 0;
  for (const tag of tags) {
    const found = await ytdlpJson(`https://www.youtube.com/hashtag/${tag}/shorts`, { flat: true, limit: 40, youtube: true }).catch(() => []);
    shelfRows += found.length;
    log.info(`dog shelf #${tag}: ${found.length} rows`);
    for (const r of found) {
      const id = String(r.id ?? '');
      if (id && !rows.has(id)) rows.set(id, { id, title: String(r.title ?? ''), views: numOr(r.view_count), via: `#${tag} Shorts shelf` });
    }
  }
  const pool = [...rows.values()].filter((r) => (r.views ?? 0) >= SHELF_PREFILTER_VIEWS && latinRatio(r.title) >= 0.6).sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const picked = pool.slice(0, Math.min(160, Math.max(20, limit * 2)));
  log.info(`dog shelves: ${shelfRows} rows -> ${rows.size} unique -> ${pool.length} at/near 1M -> verifying ${picked.length}`);
  const meta = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < picked.length; i += 20) {
    const batch = picked.slice(i, i + 20);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const missing = batch.filter((r) => !meta.has(r.id));
      if (missing.length === 0) break;
      const full = await ytdlpJson(missing.map((r) => `https://www.youtube.com/watch?v=${r.id}`), { youtube: true, embeddedMeta: true }).catch(() => []);
      for (const m of full) if (m.id) meta.set(String(m.id), m);
      if (full.length < missing.length && attempt < 2) await new Promise((r) => setTimeout(r, 4000));
    }
  }
  const dropped: Record<string, number> = {};
  const candidates: Candidate[] = [];
  for (const r of picked) {
    const m = meta.get(r.id);
    const { candidate, reason } = m ? dogCandidateFromMeta(m, r.via, now) : { candidate: null, reason: 'no_metadata' };
    if (!candidate) { dropped[reason!] = (dropped[reason!] ?? 0) + 1; continue; }
    candidates.push(candidate);
  }
  const stats: YtDogStats = { shelfRows, unique: rows.size, prefiltered: pool.length, enriched: meta.size, verified1M: candidates.length, dropped };
  log.info(`dog YouTube: ${JSON.stringify(stats)}`);
  return { candidates, stats };
}

// ---------------------------------------------------------------- frames without downloading the video
/** Three real frames (25 / 50 / 75 %) from YouTube's thumbnail CDN, tiled into one sheet. Returns null when fewer than two frames exist. */
export async function youtubeFrameSheet(id: string, dir: string): Promise<{ sheet: string; frames: string[] } | null> {
  fs.mkdirSync(dir, { recursive: true });
  const frames: string[] = [];
  for (const set of [['oar1', 'oar2', 'oar3'], ['hq1', 'hq2', 'hq3']]) {
    for (const name of set) {
      const f = path.join(dir, `${id}_${name}.jpg`);
      try { await fetchToFile(`https://i.ytimg.com/vi/${id}/${name}.jpg`, f); if (fs.statSync(f).size > 2000) frames.push(f); else fs.rmSync(f, { force: true }); } catch { /* next */ }
    }
    if (frames.length >= 2) break;
  }
  if (frames.length < 2) return null;
  const sheet = path.join(dir, `${id}_sheet.jpg`);
  const inputs = frames.flatMap((f) => ['-i', f]);
  const chains = frames.map((_, i) => `[${i}:v]scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`).join(';');
  const stack = frames.map((_, i) => `[v${i}]`).join('') + `hstack=inputs=${frames.length}[out]`;
  await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', `${chains};${stack}`, '-map', '[out]', '-frames:v', '1', '-q:v', '5', sheet]);
  return { sheet, frames };
}

/** 32x32 grayscale perceptual hash of a still image (same hash family as the video phash, so distances are comparable). */
export async function imagePhash(file: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=32:32:flags=area,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 20 });
    return stdout.length >= 1024 ? phashFrame(new Uint8Array(stdout.subarray(0, 1024))) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- LLM dog-comedy rubric
const DOG_SYSTEM = `You are the content editor of a funny-DOG Shorts channel (family-friendly, loud comic-book brand, never cruel).
You judge whether a candidate clip is a genuinely funny single dog moment with a clear comedic payoff, from its metadata
(title, description, channel, stats, duration) and, when attached, real frames of the video in time order left-to-right
(about 25 %, 50 %, 75 % of the clip). Describe what actually happens in visual_summary (one sentence) and name the
funniest_moment (what the payoff is). Score 0-10 integers:
- funny: how funny the moment is for a general audience (not just cute)
- payoff: is there ONE clear comedic payoff (a slip, a steal, a reaction, a reveal) rather than ambient cuteness; 0-4 = no payoff
- clarity: works in 3 seconds, vertical, muted; English-speaking audience (a visual gag in any language is fine; a spoken/written joke in another language scores 0-2)
- originality: fresh versus a premise seen a thousand times
- quality: sharp, well lit, original phone footage; screen recordings, heavy meme text, TV/broadcast look, blur = low
Booleans: is_dog_comedy (a real dog is the comedic subject), single_clip (false for compilations, multi-clip edits, "top 10", TV shows),
ai_generated_suspected (CGI-looking fur/physics, impossible scenes, AI watermarks).
Watermarks: report detected_handle (EXACT characters as printed, no @; null if any character is uncertain) and detected_platform (instagram|tiktok|youtube|snapchat|facebook|twitter|other|null).
safety_flags (array, possibly empty) from: nsfw, hate, graphic_injury, mild_injury, death, animal_cruelty, self_harm, minor_humiliation, minor_visible,
private_person_mocking, copyrighted_music, profanity, brand_logos, political, dangerous_stunt_imitable. Be strict with animal_cruelty (a dog in distress is not comedy).
copyright_risk for reusing the footage in a transformed commentary short WITHOUT a licence: "high" = professional/broadcast/compilation channel, music video, stock watermark,
poster clearly not the filmer; "medium" = ordinary user clip but poster may not be the filmer, or background commercial music; "low" = clearly self-filmed by the poster. copyright_risk_reasons: short strings.
rationale: one sentence. Respond with a single JSON object containing every field.`;

export async function scoreDogCandidate(cfg: Config, c: Candidate, sheetBase64?: string): Promise<DogRubric> {
  const r = await chatJson<Partial<DogRubric>>(cfg, DOG_SYSTEM, JSON.stringify({
    platform: c.source_platform, title: c.title, description: c.description?.slice(0, 500) ?? null, channel: c.author,
    stats: { views: c.views, likes: c.likes, comments: c.comments, shares: c.shares, views_per_hour: c.engagement_velocity, published_at: c.published_at },
    duration_sec: c.duration_sec, frames: sheetBase64 ? 'attached: 3 frames at 25/50/75 %, left to right' : 'not available (judge from metadata only; be conservative on payoff and quality)',
  }), { temperature: 0.2, maxTokens: 500, imageJpegBase64: sheetBase64 });
  const n = (v: unknown) => Math.max(0, Math.min(10, Math.round(Number(v) || 0)));
  return {
    is_dog_comedy: !!r.is_dog_comedy, single_clip: r.single_clip !== false, funny: n(r.funny), payoff: n(r.payoff), clarity: n(r.clarity), originality: n(r.originality), quality: n(r.quality),
    ai_generated_suspected: !!r.ai_generated_suspected, funniest_moment: typeof r.funniest_moment === 'string' ? r.funniest_moment.slice(0, 200) : null,
    visual_summary: typeof r.visual_summary === 'string' ? r.visual_summary.slice(0, 300) : null, safety_flags: Array.isArray(r.safety_flags) ? r.safety_flags.map(String) : [],
    copyright_risk: typeof r.copyright_risk === 'string' ? r.copyright_risk.toLowerCase() : undefined, copyright_risk_reasons: Array.isArray(r.copyright_risk_reasons) ? r.copyright_risk_reasons.map(String).slice(0, 6) : [],
    detected_handle: typeof r.detected_handle === 'string' && /^[A-Za-z0-9._]{2,40}$/.test(r.detected_handle.replace(/^@/, '')) ? r.detected_handle.replace(/^@/, '').toLowerCase() : null,
    detected_platform: typeof r.detected_platform === 'string' ? r.detected_platform.toLowerCase().slice(0, 20) : null, rationale: String(r.rationale ?? '').slice(0, 300),
  };
}

// ---------------------------------------------------------------- orchestrator
export interface ShortlistOptions { top: number; limit: number; tiktokHandles: string[]; reddit: boolean; tiktok: boolean }
export interface ShortlistResult { rows: ShortlistRow[]; rejected: ShortlistRow[]; markdown: string; counts: Record<string, number>; elapsedSec: number }

export async function runDogShortlist(cfg: Config, o: ShortlistOptions): Promise<ShortlistResult> {
  const start = Date.now();
  const now = new Date();
  const dir = path.join(cfg.workDir, 'dog-shortlist');
  fs.mkdirSync(dir, { recursive: true });
  const kept: ShortlistRow[] = [];
  const rejected: ShortlistRow[] = [];
  const counts: Record<string, number> = { youtube_1m_verified: 0, tiktok_1m_verified: 0, reddit_candidates: 0, scored: 0, passed_comedy: 0, duplicates: 0, rights_cleared: 0, rights_review_eligible: 0, rights_blocked: 0 };
  const methods: string[] = [];
  const learnedHandles = new Set<string>();

  const toRow = (c: Candidate, rubric: DogRubric | null, j: DogJudgement | null, extra: Partial<ShortlistRow>, verified: string, via: string): ShortlistRow => {
    const risk: CopyrightRisk | null = c.copyright_risk === 'high' ? 'high' : (rubric?.copyright_risk === 'low' || rubric?.copyright_risk === 'medium' || rubric?.copyright_risk === 'high') ? rubric.copyright_risk : c.copyright_risk;
    const withRisk = { ...c, copyright_risk: risk };
    const comedy = j?.comedy ?? 0;
    return {
      title: c.title, platform: c.source_platform as ShortlistRow['platform'], url: c.source_url, channel: c.author, views: c.views, views_verified: verified,
      views_per_hour: c.engagement_velocity, published_at: c.published_at, duration_sec: c.duration_sec, comedy, rank_score: rankScore(comedy, c.engagement_velocity),
      rights_status: c.rights_status, rights_label: rightsLabel(withRisk, cfg.maxCopyrightRisk), copyright_risk: risk,
      funniest_moment: rubric?.funniest_moment ?? null, visual_summary: rubric?.visual_summary ?? null, rationale: rubric?.rationale ?? null,
      detected_handle: rubric?.detected_handle ?? null, detected_platform: rubric?.detected_platform ?? null, frames: [], phash: [], accepted: j?.accepted ?? false, reasons: j?.reasons ?? [], via,
      rubric: rubric ? { funny: rubric.funny, payoff: rubric.payoff, clarity: rubric.clarity, originality: rubric.originality, quality: rubric.quality } : null,
      gate: j ? (j.accepted ? 'pass' : j.hard.length ? `rejected: ${j.hard.join(', ')}` : `flagged: ${j.soft.join(', ')}`) : 'not scored', ...extra,
    };
  };
  const judgeAndKeep = async (c: Candidate, verified: string, via: string, sheet: { sheet: string; frames: string[] } | null) => {
    const phashes: string[] = [];
    for (const f of sheet?.frames ?? []) { const h = await imagePhash(f); if (h) phashes.push(h); }
    const dupKey = { url: c.source_url, title: c.title, duration_sec: c.duration_sec, phash: phashes };
    const dup = isDuplicateRow(dupKey, [...kept, ...rejected]);
    if (dup) { counts.duplicates++; rejected.push(toRow(c, null, { comedy: 0, accepted: false, reasons: [`duplicate:${dup}`], hard: [`duplicate:${dup}`], soft: [] }, { frames: sheet?.frames ?? [], phash: phashes }, verified, via)); return; }
    let rubric: DogRubric;
    try { rubric = await scoreDogCandidate(cfg, c, sheet ? fs.readFileSync(sheet.sheet).toString('base64') : undefined); }
    catch (e) { if (isFatal(e)) throw e; log.warn(`dog scoring failed for ${c.source_url}: ${(e as Error).message.slice(0, 160)}`); rejected.push(toRow(c, null, { comedy: 0, accepted: false, reasons: ["llm_error"], hard: ["llm_error"], soft: [] }, { frames: sheet?.frames ?? [], phash: phashes }, verified, via)); return; }
    counts.scored++;
    const j = judgeDog(rubric);
    if (rubric.detected_handle && rubric.detected_platform === 'tiktok' && isCreatorHandle(rubric.detected_handle, 'tiktok')) learnedHandles.add(rubric.detected_handle);
    const row = toRow(c, rubric, j, { frames: sheet?.frames ?? [], phash: phashes }, verified, via);
    if (row.rights_label.startsWith('blocked')) { row.accepted = false; row.reasons = [...row.reasons, 'rights_blocked']; row.gate = `rejected: rights_blocked`; }
    if (j.accepted) counts.passed_comedy++;
    // ranked candidates: everything not hard-rejected (safety / not a dog / compilation / low quality / AI fake / rights); soft gate failures stay, flagged
    const rankable = j.hard.length === 0 && !row.rights_label.startsWith('blocked');
    if (rankable) kept.push(row); else rejected.push(row);
  };

  // ---------------- YouTube
  let ytStats: YtDogStats | null = null;
  try {
    const { candidates, stats } = await discoverYouTubeDogShorts(cfg, o.limit);
    ytStats = stats;
    counts.youtube_1m_verified = candidates.length;
    methods.push(`YouTube hashtag Shorts shelves (${YT_DOG_TAGS.length} dog tags) + embedded-player metadata: ${stats.shelfRows} shelf rows -> ${stats.unique} unique -> ${stats.prefiltered} at/near 1M -> ${stats.enriched}/${Math.min(stats.prefiltered, Math.max(20, o.limit * 2))} metadata verified -> ${stats.verified1M} with >= 1,000,000 verified views (dropped: ${JSON.stringify(stats.dropped)})`);
    const ordered = [...candidates].sort((a, b) => (b.engagement_velocity ?? 0) - (a.engagement_velocity ?? 0) || (b.views ?? 0) - (a.views ?? 0)).slice(0, o.limit);
    let sheets = 0;
    for (const c of ordered) {
      const sheet = await youtubeFrameSheet(c.source_id, dir).catch(() => null);
      if (sheet) sheets++;
      await judgeAndKeep(c, 'yt-dlp embedded-player metadata (exact view_count)', c.description?.split(' | ')[0] ?? 'YouTube shelf', sheet);
    }
    methods.push(`YouTube frames without download: ${sheets}/${ordered.length} clips had 3 CDN frames for vision scoring`);
  } catch (e) { if (isFatal(e)) throw e; methods.push(`YouTube: FAILED ${(e as Error).message.slice(0, 160)}`); }

  // ---------------- TikTok (creator pages; handles from config, flags, and watermarks read in the YouTube frames)
  if (o.tiktok) {
    const handles = [...new Set([...cfg.tiktokAccounts, ...o.tiktokHandles, ...learnedHandles].map((h) => h.toLowerCase()))].slice(0, MAX_TIKTOK_HANDLES);
    if (handles.length === 0) methods.push('TikTok: no creator handles available (TIKTOK_ACCOUNTS empty, none read from watermarks); tag / search / discover pages return no items from a server (re-checked today), so TikTok found 0');
    else {
      try {
        const rows = await discoverTikTok(cfg, 60, 365, handles, MIN_VERIFIED_VIEWS);
        const dogRows = rows.filter((c) => isDogText(`${c.title} ${c.description ?? ''}`) || learnedHandles.has((c.author ?? '').toLowerCase()));
        counts.tiktok_1m_verified = dogRows.length;
        methods.push(`TikTok creator pages via yt-dlp (${handles.length} handles: ${handles.map((h) => '@' + h).join(', ')}): ${rows.length} videos >= 1M verified views, ${dogRows.length} dog-related`);
        for (const c of dogRows.sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, o.limit)) {
          const withVelocity = { ...c, engagement_velocity: viewsPerHour(c.views, c.published_at ? new Date(c.published_at) : null, now) };
          await judgeAndKeep(withVelocity, 'yt-dlp TikTok creator page (exact view_count)', `TikTok @${c.author}`, null);
        }
      } catch (e) { if (isFatal(e)) throw e; methods.push(`TikTok: FAILED ${(e as Error).message.slice(0, 160)}`); }
    }
  }

  // ---------------- Reddit (no view counts exist; listed, never counted as verified)
  if (o.reddit) {
    try {
      const rows = await discoverRedditRss(cfg, 25, ['week'], REDDIT_DOG_SOURCES);
      const filterSubs = new Set(REDDIT_DOG_SOURCES.filter((s) => s.filter).map((s) => s.sub.toLowerCase()));
      const dogRows = rows.filter((c) => { const sub = c.description?.match(/^r\/(\w+)/)?.[1]?.toLowerCase() ?? ''; return !filterSubs.has(sub) || isDogText(c.title); });
      counts.reddit_candidates = dogRows.length;
      methods.push(`Reddit RSS (${REDDIT_DOG_SOURCES.length} dog communities, top of week): ${rows.length} native videos, ${dogRows.length} dog-related; Reddit exposes no view counts, so these never count toward the 1M+ figure`);
      for (const c of dogRows.slice(0, Math.min(o.limit, 30))) await judgeAndKeep(c, 'n/a (Reddit RSS: upvotes/views not exposed)', c.description?.split(' (')[0] ?? 'Reddit', null);
    } catch (e) { if (isFatal(e)) throw e; methods.push(`Reddit: FAILED ${(e as Error).message.slice(0, 160)}`); }
  }

  // ---------------- rank + report
  kept.sort((a, b) => b.rank_score - a.rank_score);
  const rows = kept.slice(0, o.top).map((r, i) => ({ ...r, rank: i + 1 }));
  for (const r of rows) { if (r.rights_label.startsWith('cleared')) counts.rights_cleared++; else if (r.rights_label.startsWith('review-eligible')) counts.rights_review_eligible++; else counts.rights_blocked++; }
  const cost = costOf(currentUsage());
  const md: string[] = [`## Viral funny-dog shortlist (discovery only; nothing stored, rendered, drafted or published)`, ''];
  md.push(`- videos with >= 1,000,000 VERIFIED views: YouTube ${counts.youtube_1m_verified}, TikTok ${counts.tiktok_1m_verified} (Reddit: ${counts.reddit_candidates} dog clips, views not exposed)`);
  md.push(`- scored by the dog-comedy rubric: ${counts.scored}; passed every gate (clear payoff, single clip, quality, safety, comedy >= ${COMEDY_THRESHOLD}): ${counts.passed_comedy}; duplicates removed: ${counts.duplicates}`);
  md.push(`- shortlist (top ${rows.length} of ${kept.length} rankable = single real-dog clips that are not compilations, low quality, AI fakes, unsafe or rights-blocked; "gate" shows the ones below the comedy bar): rights cleared ${counts.rights_cleared}, review-eligible (no licence on file; owner decides per draft) ${counts.rights_review_eligible}, blocked ${counts.rights_blocked}`);
  md.push(`- API spend: $${cost.total_usd.toFixed(3)} of the $${budget().toFixed(2)} budget (metered $${spentUsd().toFixed(3)}); elapsed ${Math.round((Date.now() - start) / 1000)} s`, '');
  md.push('### Discovery methods (no paid APIs)', ...methods.map((m) => `- ${m}`), '');
  md.push(`### Top ${rows.length}`, '', '| # | title | platform | views | url | comedy | gate | dur | rights | views/h | channel | payoff |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) md.push(`| ${r.rank} | ${esc(r.title).slice(0, 70)} | ${r.platform} | ${r.views == null ? 'n/a' : r.views.toLocaleString('en-US')} | ${r.url} | ${r.comedy} | ${esc(r.gate ?? '')} | ${r.duration_sec ?? '?'} s | ${esc(r.rights_label)} | ${r.views_per_hour == null ? '-' : fmtCount(r.views_per_hour)} | ${esc(r.channel ?? '')} | ${esc(r.funniest_moment ?? '')} |`);
  const why: Record<string, number> = {};
  for (const r of rejected) for (const reason of r.reasons) { const k = reason.split(':')[0].split(' ')[0]; why[k] = (why[k] ?? 0) + 1; }
  md.push('', `### Rejected (${rejected.length}) by reason`, ...Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`));
  if (ytStats) md.push('', `YouTube funnel: ${ytStats.shelfRows} shelf rows -> ${ytStats.unique} unique -> ${ytStats.prefiltered} at/near 1M -> ${ytStats.enriched} metadata -> ${ytStats.verified1M} verified >= 1M (dropped ${JSON.stringify(ytStats.dropped)})`);
  md.push('', 'Rights note: view counts measure popularity, not permission. Standard-licence YouTube / TikTok / Reddit clips are transformation-review only (owner decides per draft, creator credited); nothing here is cleared unless a CC BY licence with low provenance risk was found.');
  const markdown = md.join('\n');
  fs.writeFileSync(path.join(cfg.workDir, 'dog-shortlist.md'), markdown);
  fs.writeFileSync(path.join(cfg.workDir, 'dog-shortlist.json'), JSON.stringify({ generated_at: now.toISOString(), counts, methods, rows, rejected: rejected.map((r) => ({ ...r, frames: undefined, phash: undefined })) }, null, 2));
  return { rows, rejected, markdown, counts, elapsedSec: Math.round((Date.now() - start) / 1000) };
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
