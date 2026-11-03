#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildWeekPlan, canProduce, permissionRequestMessage, type Candidate, type RightsBasis, type SourcePlatform } from '@toaster/shared';
import { loadConfig, log, repoRoot, type Config } from './config.js';
import { makeStore, type Store } from './store.js';
import { discoverAll } from './steps/discover.js';
import { produceCandidate, produceUntil, scoreAll } from './steps/produce.js';
import { publishWeek } from './steps/publish.js';
import { learn, syncBuffer } from './steps/sync.js';
import { runDemo } from './demo.js';

const USAGE = `toaster <command> [options]

Daily / weekly automation
  run-daily                 discover -> score -> keep >= 10 finished productions in stock
  run-weekly                top up to 21 finished productions, then create next week's Buffer drafts
  sync                      poll Buffer: approvals, rejections, publishes; auto-replace rejected posts
  learn                     pull Buffer metrics for published posts and update category weights

Individual steps
  discover [--sources reddit,youtube,pexels] [--limit 50]
  score
  produce [--count N | --id CANDIDATE_ID]
  publish [--dry-run]
  plan                      print next week's 21 slot times
  status                    summary of the local/remote store

Rights
  rights:outreach [--top 20]            print drafted permission requests for unknown-rights candidates
  rights:grant <id> --basis <basis> --evidence <url|note> [--author NAME]
  rights:deny <id> [--reason TEXT]

Utilities
  demo                      render a synthetic clip through the full template (smoke test, no sources needed)
  brand:generate            create placeholder brand assets
  doctor                    check tools and configuration
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const cfg = loadConfig();
  fs.mkdirSync(cfg.workDir, { recursive: true });
  const store = makeStore(cfg);
  switch (cmd) {
    case 'doctor': return doctor(cfg);
    case 'brand:generate':
      execFileSync('python3', [path.join(repoRoot(), 'scripts', 'generate_brand_placeholders.py')], { stdio: 'inherit' });
      return;
    case 'demo': return runDemo(cfg, flags);
    case 'discover': {
      const sources = String(flags.sources ?? defaultSources(cfg)).split(',').filter(Boolean) as SourcePlatform[];
      const found = await discoverAll(cfg, { sources, limitPerSource: Number(flags.limit ?? 50) });
      const index = await store.dedupeIndex();
      const known = new Set(index.map((e) => e.source_url.toLowerCase()));
      const fresh = found.filter((c) => !known.has(c.source_url.toLowerCase()));
      await store.upsertCandidates(fresh);
      log.info(`stored ${fresh.length} new candidates (${found.length - fresh.length} already known)`);
      return;
    }
    case 'score': { await scoreAll(cfg, store); return; }
    case 'produce': {
      if (flags.id) {
        const c = await store.getCandidate(String(flags.id));
        if (!c) throw new Error('candidate not found');
        await produceCandidate(cfg, store, c);
        return;
      }
      const have = await produceUntil(cfg, store, Number(flags.count ?? 1));
      log.info(`finished productions in stock: ${have}`);
      return;
    }
    case 'publish': {
      const r = await publishWeek(cfg, store, { dryRun: !!flags['dry-run'] });
      log.info(`week ${r.week}: created ${r.created} Buffer ${cfg.approvalMode === 'needs_approval' ? 'approval requests' : 'drafts'}, open slots left ${r.openSlots}`);
      return;
    }
    case 'plan': {
      const plan = buildWeekPlan(new Date(), cfg.tz, cfg.publishSlots);
      console.log(plan.week);
      for (const s of plan.slots.filter((x) => x.service === 'youtube')) console.log(' ', s.slot_at, '(both channels)');
      return;
    }
    case 'sync': {
      const r = await syncBuffer(cfg, store, { replace: flags['no-replace'] ? false : true });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case 'learn': { console.log(JSON.stringify(await learn(cfg, store), null, 2)); return; }
    case 'run-daily': {
      const found = await discoverAll(cfg, { sources: defaultSources(cfg).split(',') as SourcePlatform[], limitPerSource: 50 });
      const known = new Set((await store.dedupeIndex()).map((e) => e.source_url.toLowerCase()));
      await store.upsertCandidates(found.filter((c) => !known.has(c.source_url.toLowerCase())));
      await scoreAll(cfg, store);
      const have = await produceUntil(cfg, store, Number(flags.stock ?? 10));
      log.info(`run-daily done; finished productions in stock: ${have}`);
      return;
    }
    case 'run-weekly': {
      await produceUntil(cfg, store, 21);
      const r = await publishWeek(cfg, store, { dryRun: !!flags['dry-run'] });
      log.info(`run-weekly done; week ${r.week}: ${r.created} created, ${r.openSlots} open`);
      return;
    }
    case 'status': return status(store);
    case 'rights:outreach': {
      const cands = (await store.listCandidates({ status: ['scored'] })).filter((c) => c.rights_status === 'unknown').slice(0, Number(flags.top ?? 20));
      for (const c of cands) {
        console.log(`\n=== ${c.id} | score ${c.final_score} | ${c.source_url}\n`);
        console.log(permissionRequestMessage(c));
        await store.patchCandidate(c.id, { rights_status: 'outreach_pending' });
      }
      if (cands.length === 0) console.log('no unknown-rights scored candidates');
      return;
    }
    case 'rights:grant': {
      const id = rest[0];
      if (!id || !flags.basis || !flags.evidence) throw new Error('usage: rights:grant <id> --basis <basis> --evidence <url|note>');
      const c = await store.patchCandidate(id, {
        rights_status: 'cleared', rights_basis: String(flags.basis) as RightsBasis, rights_evidence: String(flags.evidence),
        author: flags.author ? String(flags.author) : undefined, status: 'ready',
      } as Partial<Candidate>);
      console.log(`cleared ${id}: canProduce=${canProduce(c)}`);
      return;
    }
    case 'rights:deny': {
      const id = rest[0];
      if (!id) throw new Error('usage: rights:deny <id>');
      await store.patchCandidate(id, { rights_status: 'denied', status: 'blocked_rights', status_reason: String(flags.reason ?? 'denied') });
      console.log(`denied ${id}`);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

function defaultSources(cfg: Config): string {
  const s: string[] = [];
  if (cfg.youtubeKey) s.push('youtube');
  if (cfg.reddit.clientId) s.push('reddit');
  if (cfg.pexelsKey) s.push('pexels');
  return s.join(',');
}

async function status(store: Store) {
  const cands = await store.listCandidates();
  const byStatus: Record<string, number> = {};
  for (const c of cands) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  const posts = await store.listPosts();
  const byState: Record<string, number> = {};
  for (const p of posts) byState[p.state] = (byState[p.state] ?? 0) + 1;
  console.log(JSON.stringify({ candidates: byStatus, productions: (await store.listProductions()).length, posts: byState, weights: await store.weights() }, null, 2));
}

function doctor(cfg: Config) {
  const check = (name: string, ok: boolean, hint = '') => console.log(`${ok ? 'OK  ' : 'MISS'} ${name}${ok || !hint ? '' : `  -> ${hint}`}`);
  for (const tool of ['ffmpeg', 'ffprobe', 'python3', 'yt-dlp']) {
    const flag = tool.startsWith('ff') ? '-version' : '--version';
    try { execFileSync(tool, [flag], { stdio: 'ignore' }); check(tool, true); } catch { check(tool, false, tool === 'yt-dlp' ? 'pip install yt-dlp (needed for YouTube CC-BY sources)' : 'install'); }
  }
  check('LLM key', !!(cfg.openaiKey || cfg.anthropicKey), 'OPENAI_API_KEY or ANTHROPIC_API_KEY');
  check('ElevenLabs key', !!cfg.elevenKey, 'ELEVENLABS_API_KEY (voice-over disabled without it)');
  check('Buffer key', !!cfg.bufferKey, 'BUFFER_API_KEY from Buffer > Settings > API');
  check('YouTube Data API key', !!cfg.youtubeKey, 'YOUTUBE_API_KEY');
  check('Reddit app', !!cfg.reddit.clientId, 'REDDIT_CLIENT_ID/SECRET');
  check('R2 credentials', !!(cfg.r2.accountId && cfg.r2.accessKeyId && cfg.r2.publicBaseUrl), 'R2_* vars; Buffer needs a public video URL');
  check('Control-plane API', !!(cfg.apiUrl && cfg.apiToken), 'TOASTER_API_URL/TOKEN (falls back to work/db.json)');
  check('Brand: mascot.png', fs.existsSync(path.join(cfg.assetsDir, 'brand', 'mascot.png')), 'using placeholder');
  check('Brand: background_loop.mp4', fs.existsSync(path.join(cfg.assetsDir, 'brand', 'background_loop.mp4')), 'using procedural sunburst');
  check('Font', fs.existsSync(path.join(cfg.templateDir, 'fonts', 'Bangers-Regular.ttf')));
}

export function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = args[i + 1];
    if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true;
  }
  return out;
}

main().catch((e) => { log.error((e as Error).stack ?? String(e)); process.exit(1); });
