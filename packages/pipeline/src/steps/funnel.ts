import fs from 'node:fs';
import path from 'node:path';
import { productionBasis, qualityTier, type Candidate } from '@toaster/shared';
import { log, type Config } from '../config.js';
import type { Store } from '../store.js';
import { costOf, readUsageLog, sumUsage } from '../usage.js';
import { downloadMedia, ffprobe } from './media.js';
import { maxSourceSec, rightsPolicy } from './produce.js';
import { withRetry } from '../retry.js';

/**
 * Measurement helpers for the production funnel:
 *   discovered -> unique -> passed scoring -> eligible (rights) -> downloadable -> quality OK -> rendered
 * `fetchProbe` downloads scored candidates WITHOUT rendering them (files land in the same job folder, so a later
 * `produce` reuses them) and records resolution / audio / failure on the candidate. `funnelReport` reads the store
 * and the usage log and prints measured conversion rates plus the per-video cost.
 */
export async function fetchProbe(cfg: Config, store: Store, limit: number): Promise<{ tried: number; ok: number; failed: number }> {
  const policy = rightsPolicy(cfg);
  const cands = (await store.listCandidates({ status: ['scored', 'ready'] }))
    .filter((c) => productionBasis(c, policy) !== null && !c.status_reason?.startsWith('fetch:'))
    .sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))
    .slice(0, limit);
  let ok = 0, failed = 0;
  for (const c of cands) {
    const dir = path.join(cfg.workDir, 'jobs', c.id);
    try {
      const src = await withRetry(`download ${c.id}`, () => downloadMedia(c, dir), { attempts: 2, baseMs: 2000 });
      const p = await ffprobe(src);
      const tier = qualityTier(p.width, p.height);
      const mb = fs.statSync(src).size / 1e6;
      const reason = `fetch: ${p.width}x${p.height} ${tier}, ${p.hasAudio ? 'audio' : 'NO AUDIO'}, ${p.duration.toFixed(1)}s, ${mb.toFixed(1)} MB`;
      const patch: Partial<Candidate> = { width: p.width, height: p.height, duration_sec: p.duration, quality_tier: tier, status_reason: reason };
      if (tier === 'low' && !cfg.allowLowQuality) patch.status = 'rejected_quality';
      else if (p.duration > maxSourceSec(cfg)) { patch.status = 'rejected_quality'; patch.status_reason = `too long for a Short (${p.duration.toFixed(0)}s > ${maxSourceSec(cfg)}s; no auto-trim)`; }
      else if (!p.hasAudio) { patch.status = 'failed'; patch.status_reason = `fetch: no audio track (${p.width}x${p.height})`; }
      await store.patchCandidate(c.id, patch);
      log.info(`${c.id} ${reason}${patch.status ? ` -> ${patch.status}` : ''}`);
      if (!patch.status) ok++; else failed++;
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0].slice(0, 200);
      await store.patchCandidate(c.id, { status: 'failed', status_reason: `download failed: ${msg}` });
      log.warn(`${c.id} download failed: ${msg}`);
      failed++;
    }
  }
  return { tried: cands.length, ok, failed };
}

export interface Funnel {
  discovered: number; unique: number; scored_pass: number; eligible: number; fetched: number; download_failed: number; no_audio: number;
  quality: { hd: number; ok: number; low: number; unknown: number }; rejected_quality: number; rendered: number; produce_failed: number;
  by_status: Record<string, number>; failure_reasons: Record<string, number>; by_platform: Record<string, number>;
  rates: { score_pass: number | null; eligible: number | null; download_ok: number | null; quality_ok: number | null; render_ok: number | null; end_to_end: number | null };
  candidates_per_21: number | null;
}

export async function funnelReport(cfg: Config, store: Store): Promise<{ funnel: Funnel; markdown: string }> {
  const cands = await store.listCandidates();
  const prods = await store.listProductions();
  const by = (f: (c: Candidate) => string | null | undefined) => cands.reduce<Record<string, number>>((m, c) => { const k = f(c) ?? '?'; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const byStatus = by((c) => c.status);
  const discovered = cands.length;
  const unique = discovered - (byStatus.rejected_duplicate ?? 0);
  const scoredPass = cands.filter((c) => !['discovered', 'rejected_score', 'rejected_safety'].includes(c.status) && !(c.status === 'blocked_rights' && !c.status_reason?.startsWith('rights '))).length;
  const eligible = cands.filter((c) => !['discovered', 'rejected_score', 'rejected_safety', 'blocked_rights'].includes(c.status)).length;
  const fetchedList = cands.filter((c) => c.quality_tier != null || c.status === 'produced' || c.status_reason?.startsWith('fetch:'));
  const downloadFailed = cands.filter((c) => c.status === 'failed' && /^download failed|download .* failed|ECONN|403|404/i.test(c.status_reason ?? '')).length;
  const noAudio = cands.filter((c) => c.status_reason?.includes('no audio')).length;
  const quality = { hd: 0, ok: 0, low: 0, unknown: 0 };
  for (const c of fetchedList) quality[(c.quality_tier ?? 'unknown') as keyof typeof quality]++;
  const rendered = byStatus.produced ?? 0;
  const produceFailed = cands.filter((c) => c.status === 'failed' && !/^download failed|^fetch:/.test(c.status_reason ?? '')).length;
  const failureReasons = cands.filter((c) => ['failed', 'rejected_quality', 'rejected_duplicate', 'rejected_safety', 'blocked_rights'].includes(c.status))
    .reduce<Record<string, number>>((m, c) => { const k = `${c.status}: ${(c.status_reason ?? '').replace(/\d+x\d+/g, 'WxH').replace(/[\d.]+s\b/g, 'Ns').replace(/[\d.]+ MB/g, 'N MB').slice(0, 70)}`; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  const attemptedRender = cands.filter((c) => c.status === 'produced' || produceFailedMatch(c)).length;
  const funnel: Funnel = {
    discovered, unique, scored_pass: scoredPass, eligible, fetched: fetchedList.length, download_failed: downloadFailed, no_audio: noAudio, quality, rejected_quality: byStatus.rejected_quality ?? 0,
    rendered, produce_failed: produceFailed, by_status: byStatus, failure_reasons: failureReasons, by_platform: by((c) => c.source_platform),
    rates: {
      score_pass: rate(scoredPass, cands.filter((c) => c.status !== 'discovered').length),
      eligible: rate(eligible, scoredPass),
      download_ok: rate(fetchedList.length, fetchedList.length + downloadFailed),
      quality_ok: rate(quality.hd + quality.ok, fetchedList.length),
      render_ok: rate(rendered, attemptedRender),
      end_to_end: rate(rendered, discovered),
    },
    candidates_per_21: null,
  };
  if (funnel.rates.end_to_end) funnel.candidates_per_21 = Math.ceil(21 / (funnel.rates.end_to_end / 100));
  const usage = sumUsage(readUsageLog(cfg.workDir));
  const cost = costOf(usage);
  const perVideo = rendered > 0 ? cost.total_usd / rendered : null;
  const md: string[] = [];
  md.push(`# Production funnel (${cfg.workDir})`, '');
  md.push('| stage | count | rate |', '|---|---|---|');
  md.push(`| discovered (stored, URL-unique at discovery) | ${discovered} | |`);
  md.push(`| unique after perceptual dedupe | ${unique} | ${rate(unique, discovered) ?? '-'}% |`);
  md.push(`| passed scoring (LLM rubric + safety) | ${scoredPass} | ${funnel.rates.score_pass ?? '-'}% of scored |`);
  md.push(`| eligible for production (rights policy, max risk ${cfg.maxCopyrightRisk}) | ${eligible} | ${funnel.rates.eligible ?? '-'}% |`);
  md.push(`| downloaded + probed | ${fetchedList.length} | ${funnel.rates.download_ok ?? '-'}% of attempted (${downloadFailed} failed) |`);
  md.push(`| quality 1080p-class / 720p-class / low | ${quality.hd} / ${quality.ok} / ${quality.low} | ${funnel.rates.quality_ok ?? '-'}% usable |`);
  md.push(`| rendered | ${rendered} | ${funnel.rates.render_ok ?? '-'}% of render attempts (${produceFailed} failed) |`);
  md.push(`| **end-to-end** | ${rendered} / ${discovered} | **${funnel.rates.end_to_end ?? '-'}%** → ${funnel.candidates_per_21 ?? '?'} discovered candidates per 21 Shorts |`);
  md.push('', '## Status breakdown', '');
  for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) md.push(`- ${k}: ${v}`);
  md.push('', '## Failure / rejection reasons', '');
  for (const [k, v] of Object.entries(failureReasons).sort((a, b) => b[1] - a[1]).slice(0, 25)) md.push(`- ${v} × ${k}`);
  md.push('', '## By platform', '');
  for (const [k, v] of Object.entries(funnel.by_platform)) md.push(`- ${k}: ${v}`);
  md.push('', '## Measured usage and cost (all runs in this work dir)', '');
  for (const l of cost.lines) md.push(`- ${l}`);
  md.push(`- API cost total $${cost.total_usd.toFixed(4)}${perVideo != null ? `; per rendered video $${perVideo.toFixed(4)}; ×21/week = $${(perVideo * 21).toFixed(2)}` : ''}`);
  return { funnel, markdown: md.join('\n') };
}

function produceFailedMatch(c: Candidate): boolean {
  return c.status === 'failed' && !/^download failed|^fetch:/.test(c.status_reason ?? '');
}
