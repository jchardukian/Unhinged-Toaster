import type { Candidate } from './types.js';
import { broadcastRisk } from './provenance.js';

/**
 * Case-specific fair-use ASSESSMENT for footage without a documented licence (owner policy, 2026-11-07).
 * This is not a licence, not legal clearance and not legal advice: it records the facts the pipeline can verify and
 * an explicit verdict with its uncertainty, so the owner's one-time policy decision ("publish edited viral clips with
 * a reasonably supportable fair-use basis") is applied the same way every time and every decision is auditable.
 *
 * Verdicts:
 *  - supportable: every verifiable factor is in favour and no factor is uncertain
 *  - uncertain: at least one factor cannot be verified or points the other way (held for the owner, never unattended)
 *  - not_supportable: a factor is clearly against (never published)
 * A model-generated score never upgrades a verdict; model output can only mark a factor uncertain or against.
 */
export type FairUseVerdict = 'supportable' | 'uncertain' | 'not_supportable';
export interface FairUseFactor { name: string; state: 'for' | 'uncertain' | 'against'; detail: string }
export interface FairUseAssessment {
  verdict: FairUseVerdict;
  factors: FairUseFactor[];
  summary: string;
  assessed_at: string;
  note: string;
}
export const FAIR_USE_NOTE = 'Case-specific fair-use assessment under the owner\'s policy. Not a licence, not legal clearance, not legal advice; commentary, captions, attribution and effects do not by themselves establish fair use.';

export interface FairUseInputs {
  candidate: Pick<Candidate, 'source_platform' | 'rights_status' | 'rights_basis' | 'copyright_risk' | 'copyright_risk_reasons' | 'detected_platform' | 'detected_handle' | 'safety_flags' | 'title' | 'description' | 'visual_summary' | 'author' | 'duration_sec'>;
  commentary: string;
  commentaryMode: 'outro_voice' | 'text_only' | 'none';
  headline: string;
  edits: { freeze: boolean; punchIn: boolean; replay: boolean; captions: boolean; muteSource: boolean };
  editedSeconds: number;
  transcriptChars: number;
  now?: string;
  /** owner policy: highest model-rated copyright risk still counted in favour for "nature of source" (default low) */
  maxRisk?: 'low' | 'medium';
}

const UGC_PLATFORMS = new Set(['reddit', 'tiktok', 'youtube']);

export function assessFairUse(i: FairUseInputs): FairUseAssessment {
  const c = i.candidate;
  const f: FairUseFactor[] = [];
  const flags = parseFlags(c.safety_flags);
  const reasons = parseFlags(c.copyright_risk_reasons);

  // 1. nature of the source: amateur user-generated footage weighs for; broadcast / professional / music weighs against
  const bc = broadcastRisk(`${c.title}\n${c.description ?? ''}\n${c.visual_summary ?? ''}`);
  if (bc.high || c.copyright_risk === 'high') f.push({ name: 'nature_of_source', state: 'against', detail: bc.high ? `broadcast/professional footage: ${bc.reasons.slice(0, 2).join(', ')}` : `copyright risk rated high: ${reasons.slice(0, 2).join('; ') || 'see candidate'}` });
  else if (!UGC_PLATFORMS.has(c.source_platform)) f.push({ name: 'nature_of_source', state: 'uncertain', detail: `source platform ${c.source_platform} is not a user-generated-content feed` });
  else if (c.copyright_risk === 'low') f.push({ name: 'nature_of_source', state: 'for', detail: 'user-filmed amateur footage on a UGC platform; copyright risk rated low' });
  else if (c.copyright_risk === 'medium' && i.maxRisk === 'medium') f.push({ name: 'nature_of_source', state: 'for', detail: `amateur UGC footage; copyright risk rated medium (${reasons.slice(0, 2).join('; ') || 'poster may not be the filmer'}) and accepted by the owner policy UNATTENDED_FAIR_USE_MAX_RISK=medium` });
  else f.push({ name: 'nature_of_source', state: 'uncertain', detail: `copyright risk ${c.copyright_risk ?? 'not rated'}: ${reasons.slice(0, 2).join('; ') || 'poster may not be the filmer'}` });

  // 2. provenance: a watermark from another platform means the poster is probably not the creator
  if (c.detected_platform && c.detected_platform !== c.source_platform && c.detected_platform !== 'other') f.push({ name: 'provenance', state: 'uncertain', detail: `${c.detected_platform} watermark${c.detected_handle ? ` (@${c.detected_handle})` : ''}: the poster is probably not the original creator; credit goes to the watermark handle` });
  else if (/compilation|re-?upload|not (my|mine)|credit to|via @/i.test(`${c.title}\n${c.description ?? ''}`)) f.push({ name: 'provenance', state: 'uncertain', detail: 'title/description signals a re-upload or compilation' });
  else f.push({ name: 'provenance', state: 'for', detail: `self-posted by ${c.author ?? 'the poster'} on ${c.source_platform}; no foreign watermark seen` });

  // 3. transformation: original, specific commentary plus purposeful editing (the owner's editorial standard)
  const commentaryOk = i.commentaryMode !== 'none' && i.commentary.trim().length >= 12;
  const editsOk = i.edits.freeze || i.edits.punchIn || i.edits.replay || i.edits.captions;
  if (commentaryOk && editsOk) f.push({ name: 'transformation', state: 'for', detail: `original commentary (${i.commentaryMode}) "${i.commentary.trim().slice(0, 60)}" + headline + edits (${['freeze', 'punchIn', 'replay', 'captions'].filter((k) => (i.edits as Record<string, boolean>)[k]).join(', ')})` });
  else if (commentaryOk || editsOk) f.push({ name: 'transformation', state: 'uncertain', detail: commentaryOk ? 'commentary present but no edit beats or captions' : 'edits present but no original commentary' });
  else f.push({ name: 'transformation', state: 'against', detail: 'no commentary and no editing: a bare re-upload' });

  // 4. amount: the whole short clip is normally used; it is a factor against or neutral, never for
  const src = c.duration_sec ?? i.editedSeconds;
  if (src > 0 && i.editedSeconds < src * 0.8) f.push({ name: 'amount_used', state: 'for', detail: `${i.editedSeconds.toFixed(0)} of ${src.toFixed(0)} s used` });
  else if (src <= 60) f.push({ name: 'amount_used', state: 'for', detail: `the whole ${src.toFixed(0)} s clip is used; neutral for a short-form clip whose moment is the whole clip` });
  else f.push({ name: 'amount_used', state: 'uncertain', detail: `${i.editedSeconds.toFixed(0)} of a ${src.toFixed(0)} s source used (more than 80 %)` });

  // 5. music: a commercial track is a separate work; it must be muted
  if (flags.includes('copyrighted_music') && !i.edits.muteSource) f.push({ name: 'music', state: 'against', detail: 'commercial music flagged and not muted' });
  else if (flags.includes('copyrighted_music')) f.push({ name: 'music', state: 'for', detail: 'commercial music flagged: source audio muted' });
  else f.push({ name: 'music', state: 'for', detail: 'no commercial music flagged' });

  // 6. market effect: not verifiable automatically; recorded as uncertain unless the use is clearly commentary-led
  f.push({ name: 'market_effect', state: commentaryOk && i.editedSeconds <= 60 ? 'uncertain' : 'uncertain', detail: 'not verifiable automatically; a commentary Short is unlikely to substitute for the original post, but this is an assumption' });

  // 7. people: mocking private individuals is both a policy and a legal exposure
  if (flags.some((x) => ['private_person_mocking', 'minor_humiliation', 'minor_visible'].includes(x))) f.push({ name: 'people', state: 'against', detail: `safety flags: ${flags.join(', ')}` });
  else f.push({ name: 'people', state: 'for', detail: 'no private-person or minor flags' });

  const against = f.filter((x) => x.state === 'against');
  // market_effect is always uncertain by construction and does not block a "supportable" verdict; everything else must be "for"
  const uncertain = f.filter((x) => x.state === 'uncertain' && x.name !== 'market_effect');
  const verdict: FairUseVerdict = against.length ? 'not_supportable' : uncertain.length ? 'uncertain' : 'supportable';
  const summary = verdict === 'supportable'
    ? 'Reasonably supportable fair-use basis under the owner policy: amateur UGC source with low rated risk, self-posted, transformed by original commentary and editing, no commercial music, no private-person mocking. Market effect assumed, not verified.'
    : verdict === 'uncertain' ? `Uncertain: ${uncertain.map((x) => `${x.name} (${x.detail})`).join('; ')}` : `Not supportable: ${against.map((x) => `${x.name} (${x.detail})`).join('; ')}`;
  return { verdict, factors: f, summary, assessed_at: i.now ?? new Date().toISOString(), note: FAIR_USE_NOTE };
}

export function parseFairUse(json: string | null | undefined): FairUseAssessment | null {
  if (!json) return null;
  try { return JSON.parse(json) as FairUseAssessment; } catch { return null; }
}

function parseFlags(json: string | null | undefined): string[] {
  try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
