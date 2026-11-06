import fs from 'node:fs';
import { log, type Config } from '../config.js';
import type { Store } from '../store.js';
import { budget, fetchWithTimeout, spentUsd } from '../guard.js';
import { discoverRedditRss } from './discover.js';
import { fetchProbe } from './funnel.js';
import { produceUntil, scoreAll, unpostedProductions } from './produce.js';
import { publishWeek } from './publish.js';
import { runPreflight } from './preflight.js';

/**
 * Cost-controlled testing ladder. Each rung is a separate command with its own budget (API_BUDGET_USD, default $2):
 *   preflight  -> config + one scoring call + Worker + Buffer (read-only) + voices + feed, ~30 s, < $0.01
 *   smoke      -> 2 feeds, score <= 5, download + render exactly 1, verify the public URL plays, no Buffer posts
 *   pilot      -> preflight(production) + 3 distinct Shorts; Buffer drafts only with --drafts (still drafts: owner approves)
 * Nothing here publishes. The weekly batch requires a green production preflight first.
 */
export interface LadderResult { ok: boolean; markdown: string; elapsedSec: number; spentUsd: number }

const t0 = () => Date.now();
const since = (t: number) => Math.round((Date.now() - t) / 1000);

export async function runSmoke(cfg: Config, store: Store): Promise<LadderResult> {
  const start = t0();
  const lines: string[] = ['## Smoke test', ''];
  const pre = await runPreflight(cfg, 'diagnostic');
  lines.push(pre.markdown, '');
  if (!pre.ok) return { ok: false, markdown: lines.join('\n') + '\nPreflight failed: stopping before any download or render.', elapsedSec: since(start), spentUsd: spentUsd() };

  const found = await discoverRedditRss(cfg, 15, ['day'], [{ sub: 'AnimalsBeingDerps', category: 'funny_animals' }, { sub: 'Unexpected', category: 'unbelievable' }]);
  const known = new Set((await store.dedupeIndex()).map((e) => e.source_url.toLowerCase()));
  const fresh = found.filter((c) => !known.has(c.source_url.toLowerCase()));
  await store.upsertCandidates(fresh);
  lines.push(`- discovered ${found.length} candidates from 2 feeds (${fresh.length} new)`);

  const sc = await scoreAll(cfg, store, 5);
  lines.push(`- scored ${sc.scored}/${sc.attempted} with ${cfg.llmModel}: ${sc.passed} passed, ${sc.errors} LLM errors`);
  if (sc.scored === 0) return { ok: false, markdown: lines.join('\n') + '\nNo candidate could be scored: stopping.', elapsedSec: since(start), spentUsd: spentUsd() };

  const fp = await fetchProbe(cfg, store, 5);
  lines.push(`- downloaded/probed ${fp.tried}: ${fp.ok} usable, ${fp.failed} rejected`);
  const before = (await unpostedProductions(store)).length;
  const have = await produceUntil(cfg, store, before + 1);
  const prods = await store.listProductions();
  const newest = prods.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const rendered = have > before && newest;
  lines.push(rendered ? `- rendered 1 Short: "${newest.headline}" (${(newest.duration_sec ?? 0).toFixed(1)} s)` : '- render: no Short produced (see log)');
  let urlOk = false;
  if (rendered && newest.public_url) {
    try {
      const r = await fetchWithTimeout(newest.public_url, { method: 'GET', headers: { range: 'bytes=0-1023' } }, 30_000, 'public url');
      const ct = r.headers.get('content-type') ?? '';
      urlOk = (r.status === 200 || r.status === 206) && ct.startsWith('video/');
      lines.push(`- public URL ${urlOk ? 'plays' : 'NOT playable'}: ${newest.public_url} -> ${r.status} ${ct}`);
    } catch (e) { lines.push(`- public URL check failed: ${(e as Error).message.slice(0, 120)}`); }
  } else if (rendered) lines.push(`- public URL: none (${cfg.apiUrl && cfg.apiToken ? 'upload failed' : 'no control plane token configured'}; file is local only)`);
  const ok = !!rendered && (urlOk || !(cfg.apiUrl && cfg.apiToken));
  lines.push('', `Elapsed ${since(start)} s, API spend $${spentUsd().toFixed(4)} of $${budget().toFixed(2)} budget. No Buffer posts were created.`);
  return { ok, markdown: lines.join('\n'), elapsedSec: since(start), spentUsd: spentUsd() };
}

export async function runPilot(cfg: Config, store: Store, opts: { drafts: boolean; count?: number }): Promise<LadderResult> {
  const start = t0();
  const count = opts.count ?? 3;
  const lines: string[] = [`## Pilot (${count} Shorts${opts.drafts ? ', Buffer drafts' : ', no Buffer posts'})`, ''];
  const pre = await runPreflight(cfg, opts.drafts ? 'production' : 'diagnostic');
  lines.push(pre.markdown, '');
  if (!pre.ok) return { ok: false, markdown: lines.join('\n') + '\nPreflight failed: stopping.', elapsedSec: since(start), spentUsd: spentUsd() };

  const scoredReady = (await store.listCandidates({ status: ['scored', 'ready'] })).length;
  if (scoredReady < count * 4) {
    const found = await discoverRedditRss(cfg, 25, ['day']);
    const known = new Set((await store.dedupeIndex()).map((e) => e.source_url.toLowerCase()));
    const fresh = found.filter((c) => !known.has(c.source_url.toLowerCase()));
    await store.upsertCandidates(fresh);
    const sc = await scoreAll(cfg, store, 40);
    lines.push(`- discovered ${found.length} (${fresh.length} new), scored ${sc.scored}: ${sc.passed} passed, ${sc.errors} LLM errors`);
  } else lines.push(`- ${scoredReady} scored candidates already in the store; no new discovery needed`);
  const before = (await unpostedProductions(store)).length;
  const have = await produceUntil(cfg, store, before + count);
  const made = have - before;
  const prods = (await store.listProductions()).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, made);
  lines.push(`- rendered ${made}/${count} distinct Shorts:`);
  for (const p of prods) lines.push(`  - "${p.headline}" ${(p.duration_sec ?? 0).toFixed(1)} s ${p.public_url ? `public ✓` : 'local only'} [${p.reuse_basis}]`);
  let ok = made === count && prods.every((p) => !!p.public_url || !cfg.apiUrl);
  if (ok && opts.drafts) {
    const r = await publishWeek(cfg, store, { limit: count });
    lines.push(`- Buffer drafts: created ${r.created}, adopted ${r.adopted}, failed ${r.failed} (weeks ${r.weeks.join(', ')}); all are DRAFTS awaiting your approval in Buffer`);
    ok = r.failed === 0 && r.created + r.adopted >= count * 2;
  }
  lines.push('', `Elapsed ${since(start)} s, API spend $${spentUsd().toFixed(4)} of $${budget().toFixed(2)} budget.${opts.drafts ? '' : ' No Buffer posts were created.'}`);
  return { ok, markdown: lines.join('\n'), elapsedSec: since(start), spentUsd: spentUsd() };
}

export function writeSummary(markdown: string): void {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
}
