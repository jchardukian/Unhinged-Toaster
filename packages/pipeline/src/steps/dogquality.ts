import { log, type Config } from '../config.js';
import { chatJson } from '../llm.js';
import { contactSheet, sheetBase64, sheetPathFor } from './frames.js';

/**
 * Explicit visual-quality gate for generated dog clips (and the finished real-dog rankings). A vision model sees a
 * 2×3 contact sheet and scores the review's criteria 0–10. The decision rule is pure (testable) and strict: every
 * realism item must clear the bar, otherwise the attempt is REJECTED and counted (never silently accepted).
 */
export interface QualityScores {
  realistic_anatomy: number; believable_motion: number; natural_lighting: number; no_artifacts: number;
  hook_2s: number; payoff: number; sfx_fit: number; is_dog: boolean; notes: string;
}
export interface QualityVerdict { accepted: boolean; reasons: string[]; scores: QualityScores }

export const QUALITY_BAR = { realistic_anatomy: 7, believable_motion: 7, natural_lighting: 6, no_artifacts: 7, hook_2s: 6, payoff: 6, sfx_fit: 5 } as const;

export function judge(s: QualityScores): QualityVerdict {
  const reasons: string[] = [];
  if (!s.is_dog) reasons.push('no real-looking dog in frame');
  for (const [k, bar] of Object.entries(QUALITY_BAR) as [keyof typeof QUALITY_BAR, number][]) {
    const v = Number(s[k]);
    if (!Number.isFinite(v) || v < bar) reasons.push(`${k} ${Number.isFinite(v) ? v : '?'} < ${bar}`);
  }
  return { accepted: reasons.length === 0, reasons, scores: s };
}

const SYSTEM = `You are a strict quality judge for short dog comedy videos that must look like REAL smartphone footage.
You see a 2x3 contact sheet (six frames, time order left-to-right, top-to-bottom). Score 0-10 as integers:
- realistic_anatomy: real dog anatomy (four legs, correct paws/ears/tail, consistent breed and size across frames); 0 if limbs merge, extra legs, melting faces
- believable_motion: physically plausible movement and weight between frames; no teleporting, floating or morphing
- natural_lighting: natural light, real fur texture, real-world setting; penalise plastic skin, over-smooth, uncanny glow
- no_artifacts: 10 = no AI artifacts at all (warped objects, text gibberish, doubled items, impossible geometry); be harsh
- hook_2s: is the funny situation already readable in the first frame or two
- payoff: is there a clear, understandable comedic payoff in the later frames
- sfx_fit: given the planned sound effects described in the input, do they fit the visible actions (0 if none planned where a slip/thud/boing clearly happens)
is_dog: true only if a convincingly real dog is the subject. notes: one sentence on the biggest flaw.
Respond with a single JSON object with exactly these fields.`;

export async function assessClip(cfg: Config, clipPath: string, workDir: string, context: { premise: string; plannedSfx: string[] }): Promise<QualityVerdict> {
  const sheet = await contactSheet(clipPath, sheetPathFor(workDir));
  const b64 = sheetBase64(sheet);
  const r = await chatJson<Partial<QualityScores>>({ ...cfg, llmModel: cfg.visionOcrModel }, SYSTEM, JSON.stringify({ premise: context.premise, planned_sound_effects: context.plannedSfx }), { temperature: 0, maxTokens: 300, imageJpegBase64: b64 });
  const scores: QualityScores = {
    realistic_anatomy: num(r.realistic_anatomy), believable_motion: num(r.believable_motion), natural_lighting: num(r.natural_lighting), no_artifacts: num(r.no_artifacts),
    hook_2s: num(r.hook_2s), payoff: num(r.payoff), sfx_fit: num(r.sfx_fit), is_dog: r.is_dog === true, notes: String(r.notes ?? '').slice(0, 200),
  };
  const v = judge(scores);
  log.info(`quality gate ${v.accepted ? 'ACCEPT' : 'REJECT'}: ${JSON.stringify(scores)}${v.reasons.length ? ` (${v.reasons.join('; ')})` : ''}`);
  return v;
}
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
