import type { Candidate, CategoryWeight, ContentCategory, LlmScoreResult } from './types.js';

/**
 * Heuristic "already proven viral" score, 0-100.
 * Combines engagement velocity, like ratio, comment density and short-form fit.
 * Inputs are platform-normalised by the discovery adapters.
 */
export function heuristicScore(c: Pick<Candidate,
  'views' | 'likes' | 'comments' | 'shares' | 'published_at' | 'duration_sec' | 'discovered_at' | 'width' | 'height'>): number {
  const likes = c.likes ?? 0;
  const views = c.views ?? 0;
  const comments = c.comments ?? 0;
  const shares = c.shares ?? 0;

  const ageHours = Math.max(1, hoursBetween(c.published_at, c.discovered_at));
  const velocity = likes / ageHours; // likes per hour

  // log-scaled velocity: 10 likes/h ≈ 25, 100 ≈ 50, 1000 ≈ 75, 10000 ≈ 100
  const velocityScore = clamp((Math.log10(Math.max(velocity, 1)) / 4) * 100, 0, 100);

  // engagement depth: comments + shares relative to likes
  const depth = likes > 0 ? (comments * 2 + shares * 3) / likes : 0;
  const depthScore = clamp(depth * 400, 0, 100); // 0.25 ratio -> 100

  // view-to-like ratio when views are known (YouTube/TikTok), 5% likes -> 100
  const ratioScore = views > 0 ? clamp((likes / views) * 2000, 0, 100) : 50;

  // short-form fit: 6-30s ideal, penalise >45s or <4s; vertical preferred
  const d = c.duration_sec ?? 20;
  let fit = 100;
  if (d < 4) fit -= 60;
  else if (d < 6) fit -= 20;
  else if (d > 45) fit -= 40;
  else if (d > 30) fit -= 15;
  if (c.width && c.height && c.width > c.height) fit -= 10; // landscape still OK in our frame
  fit = clamp(fit, 0, 100);

  return round1(velocityScore * 0.45 + depthScore * 0.15 + ratioScore * 0.15 + fit * 0.25);
}

/** Convert the LLM rubric into 0-100. Safety flags that are hard-blocks return 0. */
export const HARD_BLOCK_FLAGS = new Set([
  'nsfw', 'hate', 'graphic_injury', 'minor_humiliation', 'death', 'animal_cruelty', 'self_harm', 'private_person_mocking',
]);
export const SOFT_FLAGS = new Set(['copyrighted_music', 'mild_injury', 'profanity', 'brand_logos', 'minor_visible']);

export function llmScore(r: LlmScoreResult): { score: number; blocked: boolean; reason?: string } {
  const hard = r.safety_flags.find((f) => HARD_BLOCK_FLAGS.has(f));
  if (hard) return { score: 0, blocked: true, reason: `safety:${hard}` };
  const weighted =
    r.entertainment * 0.30 +
    r.surprise * 0.20 +
    r.clarity * 0.20 +
    r.brand_fit * 0.15 +
    r.rewatchability * 0.15;
  let score = weighted * 10;
  const soft = r.safety_flags.filter((f) => SOFT_FLAGS.has(f)).length;
  score -= soft * 6;
  return { score: round1(clamp(score, 0, 100)), blocked: false };
}

/** Blend heuristic + LLM, then apply learned category weight. */
export function finalScore(
  heuristic: number,
  llm: number,
  category: ContentCategory | null,
  weights: Pick<CategoryWeight, 'category' | 'weight'>[],
): number {
  const base = heuristic * 0.4 + llm * 0.6;
  const w = category ? weights.find((x) => x.category === category)?.weight ?? 1 : 1;
  return round1(clamp(base * w, 0, 100));
}

/** Minimum final score for a candidate to be eligible for production. */
export const MIN_FINAL_SCORE = 62;

/**
 * Performance learning: update category weights from observed views.
 * weight = clamp(1 + 0.5 * (categoryAvg / globalAvg - 1), 0.6, 1.6), smoothed with EMA.
 */
export function updateCategoryWeights(
  current: CategoryWeight[],
  observations: { category: ContentCategory; views: number }[],
  now: string,
  alpha = 0.3,
): CategoryWeight[] {
  if (observations.length === 0) return current;
  const globalAvg = observations.reduce((a, o) => a + o.views, 0) / observations.length;
  if (globalAvg <= 0) return current;
  const byCat = new Map<ContentCategory, number[]>();
  for (const o of observations) byCat.set(o.category, [...(byCat.get(o.category) ?? []), o.views]);
  return current.map((cw) => {
    const vs = byCat.get(cw.category);
    if (!vs || vs.length === 0) return cw;
    const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
    const target = clamp(1 + 0.5 * (avg / globalAvg - 1), 0.6, 1.6);
    const weight = round3(cw.weight * (1 - alpha) + target * alpha);
    return { ...cw, weight, samples: cw.samples + vs.length, avg_views: round1(avg), updated_at: now };
  });
}

export function defaultCategoryWeights(now: string): CategoryWeight[] {
  return (['people_fails', 'funny_animals', 'unbelievable', 'wholesome_reactions'] as ContentCategory[]).map((c) => ({
    category: c, weight: 1, samples: 0, avg_views: null, updated_at: now,
  }));
}

export function hoursBetween(fromIso: string | null, toIso: string): number {
  if (!fromIso) return 24;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 24;
  return (b - a) / 3_600_000;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round1 = (v: number) => Math.round(v * 10) / 10;
export const round3 = (v: number) => Math.round(v * 1000) / 1000;
