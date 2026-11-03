import { CONTENT_CATEGORIES, finalScore, heuristicScore, llmScore, MIN_FINAL_SCORE, type Candidate, type CategoryWeight, type LlmScoreResult } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { chatJson } from '../llm.js';

const SYSTEM = `You are the content editor for "The Unhinged Toaster", a comedy Shorts channel (YouTube Shorts + TikTok).
Brand: loud, comic-book, red/black/yellow, an angry toaster mascot that yells one-liners. Family-friendly, never cruel.
Content pillars: funny people & unexpected fails, funny animals, unbelievable moments, wholesome & hilarious reactions.
You rate candidate clips from their metadata (title, source community, stats, duration, optional transcript).
Score each dimension 0-10 as integers:
- entertainment: how funny/delightful is this likely to be
- surprise: unexpected twist or payoff
- clarity: works with no context within the first 3 seconds, in a vertical crop, muted or with sound
- brand_fit: fits a loud comedic mascot commenting on it; not political, not mean-spirited
- rewatchability: loop/replay value
Pick category from: ${CONTENT_CATEGORIES.join(', ')}.
safety_flags (array, possibly empty) from: nsfw, hate, graphic_injury, mild_injury, death, animal_cruelty, self_harm,
minor_humiliation (a child being mocked), minor_visible, private_person_mocking (laughing AT a non-public person in a humiliating way),
copyrighted_music, profanity, brand_logos, political, dangerous_stunt_imitable.
Be strict with safety. rationale: one sentence.`;

export async function scoreCandidate(cfg: Config, c: Candidate, weights: CategoryWeight[], transcript?: string | null): Promise<Candidate> {
  const h = heuristicScore(c);
  let llm: LlmScoreResult | null = null;
  try {
    llm = await chatJson<LlmScoreResult>(cfg, SYSTEM, JSON.stringify({
      title: c.title,
      description: c.description,
      source: `${c.source_platform}${c.description?.startsWith('r/') ? ' ' + c.description : ''}`,
      suggested_category: c.category,
      stats: { views: c.views, likes: c.likes, comments: c.comments, shares: c.shares, published_at: c.published_at },
      duration_sec: c.duration_sec,
      transcript: transcript?.slice(0, 600) ?? null,
    }), { temperature: 0.2, maxTokens: 400 });
    llm = sanitise(llm);
  } catch (e) {
    log.warn(`llm scoring failed for ${c.id}: ${(e as Error).message}`);
  }
  const now = new Date().toISOString();
  if (!llm) {
    // Without an LLM we only trust the heuristic, discounted, and we never auto-pass safety.
    const f = finalScore(h, h * 0.8, c.category, weights);
    return { ...c, heuristic_score: h, llm_score: null, final_score: f, status: f >= MIN_FINAL_SCORE ? 'scored' : 'rejected_score', status_reason: 'heuristic_only', updated_at: now };
  }
  const { score, blocked, reason } = llmScore(llm);
  const category = CONTENT_CATEGORIES.includes(llm.category) ? llm.category : c.category;
  const f = finalScore(h, score, category, weights);
  let status: Candidate['status'] = 'scored';
  let status_reason: string | null = null;
  if (blocked) { status = 'rejected_safety'; status_reason = reason ?? 'safety'; }
  else if (f < MIN_FINAL_SCORE) { status = 'rejected_score'; status_reason = `final ${f} < ${MIN_FINAL_SCORE}`; }
  return {
    ...c, heuristic_score: h, llm_score: score, final_score: f, category, llm_rationale: llm.rationale,
    safety_flags: JSON.stringify(llm.safety_flags), status, status_reason, updated_at: now,
  };
}

function sanitise(r: LlmScoreResult): LlmScoreResult {
  const n = (v: unknown) => Math.max(0, Math.min(10, Math.round(Number(v) || 0)));
  return {
    entertainment: n(r.entertainment), surprise: n(r.surprise), clarity: n(r.clarity), brand_fit: n(r.brand_fit), rewatchability: n(r.rewatchability),
    category: r.category, safety_flags: Array.isArray(r.safety_flags) ? r.safety_flags.map(String) : [], rationale: String(r.rationale ?? '').slice(0, 300),
  };
}
