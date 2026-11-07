import type { Candidate, Production, RightsBasis } from './types.js';
import { isCleared } from './rights.js';

/**
 * Unattended publishing ("autopilot"): the rules that decide whether the pipeline may SCHEDULE a post in Buffer with no
 * human approval. Pure functions shared by the pipeline runner and the Worker so both apply exactly the same gate.
 *
 * Invariants (tested):
 *  - OFF by default; it needs the switch AND the owner's exact authorization phrase AND no stop flag AND no pause record.
 *  - Rights: only an explicitly documented reuse basis (CC0, public domain, CC BY with low provenance risk, Pexels /
 *    Pixabay licences, written permission, licensed, own content). Transformation review, owner_reviewed, popularity,
 *    attribution or editing never qualify.
 *  - Quality: the production must carry a passed QC verdict with a score at or above the configured minimum.
 */
export const AUTOPILOT_AUTHORIZATION_PHRASE = 'I authorize The Unhinged Toaster to publish automatically without my review';
export const AUTOPILOT_DEFAULT_MIN_QC = 7;
export const AUTOPILOT_SETTING_KEY = 'autopilot';

/** Reuse bases that document permission well enough for unattended publication. */
export const UNATTENDED_RIGHTS_BASES: readonly RightsBasis[] = ['cc0', 'public_domain', 'cc_by', 'pexels_license', 'pixabay_license', 'written_permission', 'licensed', 'owned'];

export interface AutopilotSetting {
  paused: boolean;
  reason?: string | null;
  at?: string | null;        // ISO of the last pause / resume
  by?: string | null;        // 'owner' | 'monitor' | 'emergency-stop'
}

export interface AutopilotInputs {
  enabled: boolean;                 // UNATTENDED_PUBLISHING=true
  authorization: string | undefined; // UNATTENDED_AUTHORIZATION (must equal the phrase exactly)
  emergencyStop: boolean;           // EMERGENCY_STOP=true (repository variable; no network needed)
  setting: AutopilotSetting | null; // control-plane pause record (set by `toaster stop` / the monitor)
}

export interface AutopilotVerdict { active: boolean; reasons: string[] }

/** Pure: may the pipeline schedule posts without approval right now? Every missing condition is listed. */
export function autopilotActive(i: AutopilotInputs): AutopilotVerdict {
  const reasons: string[] = [];
  if (!i.enabled) reasons.push('UNATTENDED_PUBLISHING is not "true" (drafts-only mode)');
  if ((i.authorization ?? '').trim() !== AUTOPILOT_AUTHORIZATION_PHRASE) reasons.push('UNATTENDED_AUTHORIZATION does not contain the owner\'s exact authorization phrase');
  if (i.emergencyStop) reasons.push('EMERGENCY_STOP is set');
  if (i.setting?.paused) reasons.push(`paused${i.setting.by ? ` by ${i.setting.by}` : ''}${i.setting.reason ? `: ${i.setting.reason}` : ''}${i.setting.at ? ` (${i.setting.at})` : ''}`);
  return { active: reasons.length === 0, reasons };
}

export interface EligibilityVerdict { eligible: boolean; reasons: string[]; basis: RightsBasis | null; qcScore: number | null }

/** Pure: is this finished production allowed to be scheduled unattended? Rights first, then quality. */
export function unattendedEligible(c: Pick<Candidate, 'rights_status' | 'rights_basis' | 'rights_evidence' | 'copyright_risk' | 'safety_flags' | 'status'>, p: Pick<Production, 'qc_score' | 'qc_json' | 'public_url'>, minQc = AUTOPILOT_DEFAULT_MIN_QC): EligibilityVerdict {
  const reasons: string[] = [];
  const basis = c.rights_basis ?? null;
  if (!isCleared(c)) reasons.push(`rights not documented (${c.rights_status}/${basis ?? 'none'}): unattended publishing needs an explicit licence or permission`);
  else if (!basis || !UNATTENDED_RIGHTS_BASES.includes(basis)) reasons.push(`rights basis ${basis ?? 'none'} is not in the unattended allow-list`);
  if (!c.rights_evidence) reasons.push('no rights evidence recorded');
  if (c.copyright_risk === 'high') reasons.push('copyright risk high');
  const flags = safeFlags(c.safety_flags);
  if (flags.length) reasons.push(`safety flags: ${flags.join(', ')}`);
  const qc = parseQc(p.qc_json);
  if (!qc) reasons.push('no QC verdict recorded');
  else if (!qc.ok) reasons.push(`QC failed: ${qc.blocking.join(', ') || 'see qc_json'}`);
  const score = p.qc_score ?? qc?.score ?? null;
  if (score == null) reasons.push('no QC score');
  else if (score < minQc) reasons.push(`QC score ${score} below the unattended minimum ${minQc}`);
  if (!p.public_url) reasons.push('no public media URL');
  return { eligible: reasons.length === 0, reasons, basis, qcScore: score };
}

export interface QcSummary { ok: boolean; score: number | null; blocking: string[]; warnings: string[] }
export function parseQc(json: string | null | undefined): QcSummary | null {
  if (!json) return null;
  try {
    const j = JSON.parse(json) as { ok?: boolean; score?: number | null; checks?: { name: string; ok: boolean; severity: string }[] };
    const checks = j.checks ?? [];
    return { ok: !!j.ok, score: j.score ?? null, blocking: checks.filter((c) => !c.ok && c.severity === 'block').map((c) => c.name), warnings: checks.filter((c) => !c.ok && c.severity === 'warn').map((c) => c.name) };
  } catch { return null; }
}

function safeFlags(json: string | null | undefined): string[] {
  try { return (JSON.parse(json ?? '[]') as string[]).filter((f) => HARD.has(f)); } catch { return []; }
}
const HARD = new Set(['nsfw', 'hate', 'graphic_injury', 'minor_humiliation', 'death', 'animal_cruelty', 'self_harm', 'private_person_mocking']);

/** Every scheduling decision is recorded, scheduled or not. */
export interface Decision {
  id: string;
  at: string;
  kind: 'schedule' | 'skip' | 'hold' | 'pause' | 'resume' | 'unschedule' | 'stop';
  production_id: string | null;
  candidate_id: string | null;
  service: 'youtube' | 'tiktok' | null;
  slot_at: string | null;
  buffer_post_id: string | null;
  reasons: string;            // JSON array of strings
  detail: string | null;      // JSON (rights basis / evidence, qc score, who)
}

/** Monitoring thresholds that pause unattended publishing automatically. */
export const MONITOR_RULES = {
  maxPublishErrors24h: 2,         // Buffer reported errors publishing our posts
  minQcPassRate: 0.25,            // of the last N productions
  qcWindow: 12,
  maxConsecutiveRunFailures: 2,
} as const;

export interface MonitorInput {
  publishErrors24h: number;
  qcVerdicts: boolean[];          // newest first, up to qcWindow
  consecutiveRunFailures: number;
  budgetExhausted: boolean;
  breakerTripped: boolean;
  platformIncident: boolean;      // copyright complaint / platform warning recorded by the owner or a feed
}

/** Pure: should the monitor pause unattended publishing? Returns the reasons (empty = healthy). */
export function monitorVerdict(m: MonitorInput): string[] {
  const r: string[] = [];
  if (m.publishErrors24h >= MONITOR_RULES.maxPublishErrors24h) r.push(`${m.publishErrors24h} Buffer publishing errors in 24 h`);
  const v = m.qcVerdicts.slice(0, MONITOR_RULES.qcWindow);
  if (v.length >= 6) { const rate = v.filter(Boolean).length / v.length; if (rate < MONITOR_RULES.minQcPassRate) r.push(`QC pass rate ${(rate * 100).toFixed(0)} % over the last ${v.length} productions`); }
  if (m.consecutiveRunFailures >= MONITOR_RULES.maxConsecutiveRunFailures) r.push(`${m.consecutiveRunFailures} consecutive run failures`);
  if (m.budgetExhausted) r.push('API budget exhausted');
  if (m.breakerTripped) r.push('an API circuit breaker tripped');
  if (m.platformIncident) r.push('platform incident recorded (copyright complaint / warning)');
  return r;
}
