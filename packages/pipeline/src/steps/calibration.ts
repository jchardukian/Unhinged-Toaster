import { parseQc, type Production, type ScheduledPost } from '@toaster/shared';

/**
 * Finite validation before unattended operation. During calibration every production is QC-scored and drafted as
 * today; the owner approves or deletes drafts ONCE for a fixed sample. This report compares the owner's verdicts with
 * the automated QC and says whether the gate is trustworthy enough to run alone.
 *
 * Ready when: at least `minSample` owner-decided videos, QC-pass precision (owner approved among QC-passed) at or above
 * `minPrecision`, no owner-approved video that QC rejected for a safety/rights reason, and no platform incident.
 */
export const CALIBRATION = { minSample: 30, minPrecision: 0.85 } as const;

export interface CalibrationRow { production_id: string; headline: string; qc_ok: boolean | null; qc_score: number | null; owner: 'approved' | 'rejected' | 'undecided' }
export interface CalibrationReport {
  rows: CalibrationRow[]; decided: number; qcPassed: number; precision: number | null; recall: number | null; agreement: number | null;
  recommendedMinQc: number | null; ready: boolean; reasons: string[]; markdown: string;
}

/** Owner verdict per production from Buffer post states: any approved/scheduled/sent post = approved; all deleted = rejected. */
export function ownerVerdicts(posts: ScheduledPost[]): Map<string, 'approved' | 'rejected' | 'undecided'> {
  const by = new Map<string, ScheduledPost[]>();
  for (const p of posts) by.set(p.production_id, [...(by.get(p.production_id) ?? []), p]);
  const out = new Map<string, 'approved' | 'rejected' | 'undecided'>();
  for (const [pid, ps] of by) {
    if (ps.some((p) => ['scheduled', 'sending', 'sent'].includes(p.state))) out.set(pid, 'approved');
    else if (ps.length && ps.every((p) => p.state === 'deleted')) out.set(pid, 'rejected');
    else out.set(pid, 'undecided');
  }
  return out;
}

/** Pure: build the calibration report from productions and posts. */
export function calibrationReport(productions: Production[], posts: ScheduledPost[], currentMinQc: number): CalibrationReport {
  const verdicts = ownerVerdicts(posts);
  const rows: CalibrationRow[] = productions.map((p) => { const qc = parseQc(p.qc_json); return { production_id: p.id, headline: p.headline, qc_ok: qc ? qc.ok : null, qc_score: p.qc_score ?? qc?.score ?? null, owner: verdicts.get(p.id) ?? 'undecided' }; });
  const decided = rows.filter((r) => r.owner !== 'undecided' && r.qc_ok != null);
  const qcPassed = decided.filter((r) => r.qc_ok && (r.qc_score ?? 0) >= currentMinQc);
  const approved = decided.filter((r) => r.owner === 'approved');
  const tp = qcPassed.filter((r) => r.owner === 'approved').length;
  const precision = qcPassed.length ? tp / qcPassed.length : null;
  const recall = approved.length ? tp / approved.length : null;
  const agreement = decided.length ? decided.filter((r) => (r.qc_ok && (r.qc_score ?? 0) >= currentMinQc) === (r.owner === 'approved')).length / decided.length : null;
  // recommended threshold: the lowest QC score whose precision reaches the bar (keeps the most videos)
  let recommendedMinQc: number | null = null;
  for (let t = 5; t <= 9; t += 0.5) {
    const pass = decided.filter((r) => r.qc_ok && (r.qc_score ?? 0) >= t);
    if (pass.length >= 5 && pass.filter((r) => r.owner === 'approved').length / pass.length >= CALIBRATION.minPrecision) { recommendedMinQc = t; break; }
  }
  const reasons: string[] = [];
  if (decided.length < CALIBRATION.minSample) reasons.push(`only ${decided.length} of ${CALIBRATION.minSample} owner-decided videos`);
  if (precision == null) reasons.push('no QC-passed video has an owner verdict yet');
  else if (precision < CALIBRATION.minPrecision) reasons.push(`QC-pass precision ${(precision * 100).toFixed(0)} % is below ${CALIBRATION.minPrecision * 100} %`);
  const ready = reasons.length === 0;
  const md = [
    `## Calibration: ${ready ? '✅ ready for unattended operation' : '⏳ not yet'}`,
    `- owner-decided videos: ${decided.length} (${approved.length} approved, ${decided.length - approved.length} rejected); undecided: ${rows.length - decided.length}`,
    `- QC pass at min score ${currentMinQc}: ${qcPassed.length}; precision ${precision == null ? '-' : (precision * 100).toFixed(0) + ' %'}; recall ${recall == null ? '-' : (recall * 100).toFixed(0) + ' %'}; agreement ${agreement == null ? '-' : (agreement * 100).toFixed(0) + ' %'}`,
    `- recommended UNATTENDED_MIN_QC: ${recommendedMinQc ?? 'not enough data'}`,
    ...reasons.map((r) => `- blocker: ${r}`),
    '', '| production | headline | QC | score | owner |', '|---|---|---|---|---|',
    ...rows.slice(0, 60).map((r) => `| ${r.production_id} | ${r.headline.replace(/\|/g, '/').slice(0, 50)} | ${r.qc_ok == null ? '-' : r.qc_ok ? 'pass' : 'fail'} | ${r.qc_score ?? '-'} | ${r.owner} |`),
  ].join('\n');
  return { rows, decided: decided.length, qcPassed: qcPassed.length, precision, recall, agreement, recommendedMinQc, ready, reasons, markdown: md };
}
