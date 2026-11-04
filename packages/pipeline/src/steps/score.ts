import { CONTENT_CATEGORIES, finalScore, heuristicScore, llmScore, MIN_FINAL_SCORE, type Candidate, type CategoryWeight, type LlmScoreResult } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { chatJson } from '../llm.js';

const SYSTEM = `You are the content editor for "The Unhinged Toaster", a comedy Shorts channel (YouTube Shorts + TikTok).
Brand: loud, comic-book, red/black/yellow, an angry toaster mascot that yells one-liners. Family-friendly, never cruel.
Content pillars: funny people & unexpected fails, funny animals, unbelievable moments, wholesome & hilarious reactions.
You rate candidate clips from their metadata (title, source community, stats, duration, optional transcript) and, when provided,
a contact sheet of six frames in time order (left-to-right, top-to-bottom). Describe what actually happens in visual_summary (one sentence).
Look for on-screen watermarks or handles (Instagram/TikTok/YouTube/Snapchat logos, "@name" text, channel bugs): report
detected_handle (transcribe it EXACTLY character by character as written on screen, without @; if any character is uncertain return null) and detected_platform (instagram|tiktok|youtube|snapchat|facebook|twitter|other|null). A watermark from
another platform means the poster is probably not the creator: copyright_risk at least "medium" (keep "high" for professional/broadcast/compilation/music content).
Score each dimension 0-10 as integers:
- entertainment: how funny/delightful is this likely to be
- surprise: unexpected twist or payoff
- clarity: works with no context within the first 3 seconds, in a vertical crop, muted or with sound. The audience is English-speaking: a visual gag works in any language, but a clip whose joke is spoken or written in another language (transliterated Hindi/Urdu titles like "Papa ko remote todna pada", non-English dialogue in the transcript, burned-in captions in another script) scores clarity 0-2
- brand_fit: fits a loud comedic mascot commenting on it; not political, not mean-spirited
- rewatchability: loop/replay value
Pick category from: ${CONTENT_CATEGORIES.join(', ')}.
safety_flags (array, possibly empty) from: nsfw, hate, graphic_injury, mild_injury, death, animal_cruelty, self_harm,
minor_humiliation (a child being mocked), minor_visible, private_person_mocking (laughing AT a non-public person in a humiliating way),
copyrighted_music, profanity, brand_logos, political, dangerous_stunt_imitable.
Be strict with safety. rationale: one sentence. Respond with a single JSON object containing all fields.
Also assess copyright_risk for reusing this footage in a transformed commentary short WITHOUT a license from the owner:
- "high": professional/broadcast/TV/film/sports-league/news-agency footage, music videos, clips with a prominent commercial music track as the point, stock-agency watermarks, footage from another commentary/compilation channel, or any indication the poster is not the person who filmed it
- "medium": ordinary user-filmed clip but the poster may not be the filmer, or there is background commercial music, or identifiable third parties are the joke
- "low": clearly self-filmed amateur phone footage posted by the person who filmed it, no commercial music
copyright_risk_reasons: array of short strings.`;

/** True when the source gave real engagement numbers (views or comments or shares), not just a rank proxy. */
export function statsKnown(c: Pick<Candidate, 'views' | 'comments' | 'shares'>): boolean {
  return c.views != null || c.comments != null || c.shares != null;
}

export async function scoreCandidate(cfg: Config, cIn: Candidate, weights: CategoryWeight[], transcript?: string | null, framesJpegBase64?: string): Promise<Candidate> {
  let c = cIn;
  const h = heuristicScore(c);
  let llm: LlmScoreWithRisk | null = null;
  try {
    llm = await chatJson<LlmScoreWithRisk>(cfg, SYSTEM, JSON.stringify({
      title: c.title,
      description: c.description,
      source: `${c.source_platform}${c.description?.startsWith('r/') ? ' ' + c.description : ''}`,
      suggested_category: c.category,
      stats: { views: c.views, likes: c.likes, comments: c.comments, shares: c.shares, published_at: c.published_at },
      duration_sec: c.duration_sec,
      transcript: transcript?.slice(0, 600) ?? null,
      frames: framesJpegBase64 ? 'attached: 6 frames, time order left-to-right, top-to-bottom' : 'not available',
    }), { temperature: 0.2, maxTokens: 500, imageJpegBase64: framesJpegBase64 });
    llm = sanitise(llm);
    if (llm.visual_summary) c = { ...c, visual_summary: llm.visual_summary };
    if (llm.detected_handle) c = { ...c, detected_handle: llm.detected_handle, detected_platform: llm.detected_platform ?? null };
    const cr = llm.copyright_risk;
    if ((cr === 'low' || cr === 'medium' || cr === 'high') && c.copyright_risk !== 'high') {
      c = { ...c, copyright_risk: cr, copyright_risk_reasons: JSON.stringify(llm.copyright_risk_reasons ?? []) };
    }
  } catch (e) {
    log.warn(`llm scoring failed for ${c.id}: ${(e as Error).message}`);
  }
  const now = new Date().toISOString();
  if (!llm) {
    // Without an LLM we only trust the heuristic, discounted, and we never auto-pass safety.
    const f = finalScore(h, h * 0.8, c.category, weights);
    const blockedByProvenance = c.copyright_risk === 'high' && c.rights_status !== 'cleared';
    return { ...c, heuristic_score: h, llm_score: null, final_score: f, status: blockedByProvenance ? 'blocked_rights' : f >= MIN_FINAL_SCORE ? 'scored' : 'rejected_score', status_reason: blockedByProvenance ? 'copyright_risk high (provenance)' : 'heuristic_only', updated_at: now };
  }
  const { score, blocked, reason } = llmScore(llm);
  const category = CONTENT_CATEGORIES.includes(llm.category) ? llm.category : c.category;
  // Without real engagement stats (Reddit feeds carry none: the "likes" field is a rank proxy) the heuristic is noise
  // that sat at ~50 and pulled every blend to the threshold (10% pass in the first 287-candidate run), so the LLM
  // rubric alone decides; the vision pass in produce re-scores with frames before anything is rendered.
  const f = statsKnown(c) ? finalScore(h, score, category, weights) : finalScore(score, score, category, weights);
  let status: Candidate['status'] = 'scored';
  let status_reason: string | null = null;
  if (blocked) { status = 'rejected_safety'; status_reason = reason ?? 'safety'; }
  else if (f < MIN_FINAL_SCORE) { status = 'rejected_score'; status_reason = `final ${f} < ${MIN_FINAL_SCORE}`; }
  else if (c.rights_status === 'transformation_review' && c.copyright_risk === 'high') { status = 'blocked_rights'; status_reason = `copyright_risk high: ${(JSON.parse(c.copyright_risk_reasons ?? '[]') as string[]).slice(0, 3).join('; ')}`; }
  // provenance heuristics can mark risk high before the LLM runs (compilation / licensing accounts): never produce those
  if (status === 'scored' && c.copyright_risk === 'high' && c.rights_status !== 'cleared') { status = 'blocked_rights'; status_reason = `copyright_risk high (provenance): ${(JSON.parse(c.copyright_risk_reasons ?? '[]') as string[]).slice(0, 3).join('; ')}`; }
  return {
    ...c, heuristic_score: h, llm_score: score, final_score: f, category, llm_rationale: llm.rationale,
    safety_flags: JSON.stringify(llm.safety_flags), status, status_reason, updated_at: now,
  };
}

type LlmScoreWithRisk = LlmScoreResult & { copyright_risk?: string; copyright_risk_reasons?: string[]; visual_summary?: string | null; detected_handle?: string | null; detected_platform?: string | null };
function sanitise(r: LlmScoreWithRisk): LlmScoreWithRisk {
  const n = (v: unknown) => Math.max(0, Math.min(10, Math.round(Number(v) || 0)));
  return {
    entertainment: n(r.entertainment), surprise: n(r.surprise), clarity: n(r.clarity), brand_fit: n(r.brand_fit), rewatchability: n(r.rewatchability),
    category: r.category, safety_flags: Array.isArray(r.safety_flags) ? r.safety_flags.map(String) : [], rationale: String(r.rationale ?? '').slice(0, 300),
    copyright_risk: typeof r.copyright_risk === 'string' ? r.copyright_risk.toLowerCase() : undefined,
    copyright_risk_reasons: Array.isArray(r.copyright_risk_reasons) ? r.copyright_risk_reasons.map(String).slice(0, 6) : [],
    visual_summary: typeof r.visual_summary === 'string' ? r.visual_summary.slice(0, 300) : null,
    detected_handle: typeof r.detected_handle === 'string' && /^[A-Za-z0-9._]{2,40}$/.test(r.detected_handle.replace(/^@/, '')) ? r.detected_handle.replace(/^@/, '') : null,
    detected_platform: typeof r.detected_platform === 'string' ? r.detected_platform.toLowerCase().slice(0, 20) : null,
  };
}
