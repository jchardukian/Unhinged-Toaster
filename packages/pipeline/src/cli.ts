#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildWeekPlan, canProduce, permissionRequestMessage, type Candidate, type RightsBasis, type SourceAdapter } from '@toaster/shared';
import { alert } from './alerts.js';
import { loadConfig, log, repoRoot, type Config } from './config.js';
import { makeStore, type Store } from './store.js';
import { discoverAll } from './steps/discover.js';
import { produceCandidate, produceUntil, scoreAll } from './steps/produce.js';
import { publishWeek } from './steps/publish.js';
import { readinessReport } from './steps/report.js';
import { learn, syncBuffer } from './steps/sync.js';
import { runDemo } from './demo.js';

const USAGE = `toaster <command> [options]

Daily / weekly automation
  run-daily [--stock 10]    discover -> score -> keep >= N finished productions in stock -> fill open slots -> report
  run-weekly [--dry-run]    produce up to 21, create next week's Buffer drafts, retry, report; exits 1 if incomplete
  sync                      poll Buffer: approvals, confirmed rejections, publishes; auto-replace rejected posts
  learn                     pull Buffer metrics for published posts and update category weights
  report [--week current|next] [--json]   weekly readiness report (21 targets, funnel, shortages, blockers)

Individual steps
  discover [--sources youtube_viral,reddit_rss,reddit,tiktok,youtube_search,youtube_trending,youtube,pixabay,pexels,internet_archive] [--limit 50]
           [--dry-run [--fetch N]]   print what each source finds without storing it; --fetch downloads the top N to prove the fetch path
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
  demo [--offline] [--vertical] [--commentary outro_voice|text_only|none]   render a synthetic clip through the template
  buffer:tags               list Buffer tags (best effort) to fill BUFFER_TAG_REVIEW_ID / BUFFER_TAG_CLEARED_ID
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
      const sources = String(flags.sources ?? defaultSources(cfg)).split(',').filter(Boolean) as SourceAdapter[];
      if (flags['dry-run']) { await probeSources(cfg, sources, Number(flags.limit ?? 20), Number(flags.fetch ?? 0)); return; }
      await discoverInto(cfg, store, sources, Number(flags.limit ?? 50));
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
      log.info(`weeks ${r.weeks.join(',')}: created ${r.created}, adopted ${r.adopted}, failed ${r.failed}, open slots left ${r.openSlots}`);
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
      if (r.errors.length) await alert('warn', `Buffer sync reported ${r.errors.length} error(s)`, r.errors.map((e) => `- ${e.post_id}: ${e.error}`).join('\n'), { issueKey: 'buffer-sync-errors' });
      return;
    }
    case 'learn': { console.log(JSON.stringify(await learn(cfg, store), null, 2)); return; }
    case 'report': {
      const { report, markdown } = await readinessReport(cfg, store, flags.week === 'current' ? 'current' : 'next');
      console.log(flags.json ? JSON.stringify(report, null, 2) : markdown);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
      return;
    }
    case 'run-daily': {
      await discoverInto(cfg, store, defaultSources(cfg).split(',').filter(Boolean) as SourceAdapter[], Number(flags.limit ?? 50));
      await scoreAll(cfg, store);
      const stock = Number(flags.stock ?? 10);
      const have = await produceUntil(cfg, store, stock);
      let pub = { created: 0, adopted: 0, failed: 0, openSlots: 0 };
      if (cfg.bufferKey) pub = await publishWeek(cfg, store);
      const { report, markdown } = await readinessReport(cfg, store, 'next');
      log.info(`run-daily done; stock ${have}/${stock}; drafts created ${pub.created}, adopted ${pub.adopted}, failed ${pub.failed}`);
      console.log(markdown);
      if (!report.complete) await alert('warn', `Next week (${report.week}) is not fully covered yet: ${report.videos_ready}/${report.target_videos} videos`, markdown, { issueKey: `readiness ${report.week}` });
      else await alert('info', `Next week (${report.week}) fully covered`, markdown);
      return;
    }
    case 'run-weekly': {
      const dryRun = !!flags['dry-run'];
      // up to 3 rounds: produce -> publish -> re-check, so transient failures get a second chance within the run
      let last = { created: 0, adopted: 0, failed: 0, openSlots: 0 };
      for (let round = 1; round <= 3; round++) {
        await produceUntil(cfg, store, 21);
        last = await publishWeek(cfg, store, { dryRun });
        log.info(`run-weekly round ${round}: created ${last.created}, adopted ${last.adopted}, failed ${last.failed}, open ${last.openSlots}`);
        if (last.failed === 0 && last.openSlots === 0) break;
        if (last.failed === 0 && last.openSlots > 0) {
          // open slots with no failures means we ran out of footage; try discovering once more then stop looping
          if (round === 1) { await discoverInto(cfg, store, defaultSources(cfg).split(',').filter(Boolean) as SourceAdapter[], 50); await scoreAll(cfg, store); continue; }
          break;
        }
      }
      const { report, markdown } = await readinessReport(cfg, store, 'next');
      console.log(markdown);
      if (report.complete) {
        await alert('info', `Weekly batch ${report.week} complete: ${report.videos_ready} videos / ${report.funnel.drafts_created} drafts waiting for your approval in Buffer`, markdown);
      } else {
        await alert('error', `Weekly batch ${report.week} INCOMPLETE: ${report.videos_ready}/${report.target_videos} videos, ${report.videos_missing} missing`, markdown, { issueKey: `readiness ${report.week}` });
        if (!flags['allow-incomplete']) process.exitCode = 1;
      }
      return;
    }
    case 'status': return status(store);
    case 'buffer:tags': {
      const { bufferClient } = await import('./steps/publish.js');
      const client = bufferClient(cfg);
      // Not covered by Buffer's guides; the changelog lists Query.tagsV2. Reported verbatim on failure.
      try {
        const d = await client.gql<{ tagsV2: { edges?: { node: { id: string; name: string } }[] } | { id: string; name: string }[] }>(
          `query($organizationId: OrganizationId!) { tagsV2(input: { organizationId: $organizationId }) { ... on TagConnection { edges { node { id name } } } } }`, { organizationId: cfg.bufferOrgId });
        const list = Array.isArray(d.tagsV2) ? d.tagsV2 : (d.tagsV2.edges ?? []).map((e) => e.node);
        for (const tg of list) console.log(`${tg.id}  ${tg.name}`);
        if (list.length === 0) console.log('no tags found; create "REVIEW" and "CLEARED" tags in Buffer (Settings > Tags) and re-run');
      } catch (e) {
        console.log(`tags query failed (${(e as Error).message.slice(0, 200)}). Create tags "REVIEW" and "CLEARED" in Buffer > Settings > Tags, then copy their ids from the tag URL into BUFFER_TAG_REVIEW_ID / BUFFER_TAG_CLEARED_ID.`);
      }
      return;
    }
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

async function discoverInto(cfg: Config, store: Store, sources: SourceAdapter[], limit: number): Promise<number> {
  if (sources.length === 0) { log.warn('no discovery sources configured (set PIXABAY_API_KEY / PEXELS_API_KEY, or DISCOVERY_SOURCES)'); return 0; }
  const found = await discoverAll(cfg, { sources, limitPerSource: limit });
  const known = new Set((await store.dedupeIndex()).map((e) => e.source_url.toLowerCase()));
  const fresh = found.filter((c) => !known.has(c.source_url.toLowerCase()));
  await store.upsertCandidates(fresh);
  log.info(`stored ${fresh.length} new candidates (${found.length - fresh.length} already known)`);
  return fresh.length;
}

/** `discover --dry-run`: run the adapters, print the top rows per source, optionally download the first N to prove the fetch path on this runner. */
async function probeSources(cfg: Config, sources: SourceAdapter[], limit: number, fetchN: number): Promise<void> {
  const { ffprobe, downloadMedia } = await import('./steps/media.js');
  const lines: string[] = [];
  const say = (s: string) => { console.log(s); lines.push(s); };
  const fetched: Candidate[] = [];
  for (const s of sources) {
    const found = await discoverAll(cfg, { sources: [s], limitPerSource: limit });
    const ranked = [...found].sort((a, b) => (b.engagement_velocity ?? 0) - (a.engagement_velocity ?? 0) || (b.views ?? b.likes ?? 0) - (a.views ?? a.likes ?? 0));
    say(`\n## ${s}: ${found.length} candidates`);
    say('| views | per hour | dur | size | uploaded | risk | title | source | found via |');
    say('|---|---|---|---|---|---|---|---|---|');
    for (const c of ranked.slice(0, 15)) {
      say(`| ${c.views ?? (c.likes != null ? `~${c.likes} likes` : '?')} | ${c.engagement_velocity ?? '-'} | ${c.duration_sec ?? '?'}s | ${c.width && c.height ? `${c.width}x${c.height}` : '?'} | ${c.published_at?.slice(0, 10) ?? '?'} | ${c.copyright_risk ?? '-'} | ${c.title.replace(/\|/g, '/').slice(0, 70)} | ${c.source_url} | ${(c.description ?? '').split('\n')[0].replace(/\|/g, '/').slice(0, 80)} |`);
    }
    fetched.push(...ranked.filter((c) => c.copyright_risk !== 'high').slice(0, Math.max(0, fetchN - fetched.length)));
  }
  for (const c of fetched) {
    const dir = path.join(cfg.workDir, 'probe');
    try {
      const file = await downloadMedia(c, dir);
      const p = await ffprobe(file);
      say(`\nFETCH OK ${c.source_platform} ${c.source_url} -> ${p.width}x${p.height} ${p.duration.toFixed(1)}s ${(fs.statSync(file).size / 1e6).toFixed(1)} MB (${file})`);
    } catch (e) {
      say(`\nFETCH FAILED ${c.source_platform} ${c.source_url}: ${(e as Error).message.split('\n').slice(-3).join(' / ').slice(0, 400)}`);
      process.exitCode = 2;
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# Sourcing probe\n${lines.join('\n')}\n`);
}

/**
 * Viral-first: Reddit (transformation review) and YouTube (when enabled) before the stock-style fillers.
 * Everything without an explicit license is drafted with a review note; nothing is auto-classified as cleared.
 */
function defaultSources(cfg: Config): string {
  if (cfg.sources) return cfg.sources;
  const s: string[] = [];
  if (cfg.enableYoutubeTransform && cfg.transformationReview) s.push('youtube_viral');
  if (cfg.transformationReview) s.push(cfg.reddit.clientId ? 'reddit' : 'reddit_rss');
  if (cfg.transformationReview && cfg.tiktokAccounts.length) s.push('tiktok');
  if (cfg.enableYoutubeTransform && cfg.transformationReview && cfg.youtubeKey) s.push('youtube_trending');
  if (cfg.youtubeKey && cfg.enableYoutubeCc) s.push('youtube');
  if (cfg.pixabayKey) s.push('pixabay');
  if (cfg.pexelsKey) s.push('pexels');
  s.push('internet_archive');
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
    try { execFileSync(tool, [flag], { stdio: 'ignore' }); check(tool, true); } catch { check(tool, false, tool === 'yt-dlp' ? 'pip install "yt-dlp[default]" (YouTube / TikTok sources)' : 'install'); }
  }
  try { execFileSync('python3', ['-c', 'import yt_dlp_ejs'], { stdio: 'ignore' }); check('yt-dlp JS challenge solver (yt-dlp-ejs)', true); } catch { check('yt-dlp JS challenge solver (yt-dlp-ejs)', false, 'pip install "yt-dlp[default]" – YouTube downloads 403 without it'); }
  check('LLM key', !!(cfg.openaiKey || cfg.anthropicKey), 'OPENAI_API_KEY or ANTHROPIC_API_KEY');
  check('ElevenLabs key', !!cfg.elevenKey, 'ELEVENLABS_API_KEY (voice-over disabled without it)');
  check('Buffer key', !!cfg.bufferKey, 'BUFFER_API_KEY from Buffer > Settings > API');
  check('Pixabay key (auto-clearable source)', !!cfg.pixabayKey, 'PIXABAY_API_KEY (free)');
  check('Pexels key (auto-clearable source)', !!cfg.pexelsKey, 'PEXELS_API_KEY (free)');
  check('YouTube CC source', !!cfg.youtubeKey && cfg.enableYoutubeCc, 'YOUTUBE_API_KEY + ENABLE_YOUTUBE_CC=true (read docs/SOURCES.md first)');
  check('Reddit app (viral source, transformation review)', !!cfg.reddit.clientId, 'optional: without it the public RSS feeds are used (no scores, rank proxy)');
  check('TikTok creator accounts (transformation review)', cfg.tiktokAccounts.length > 0, 'TIKTOK_ACCOUNTS=handle1,handle2 (original creators)');
  check(`YouTube virals, no key needed (windows: ${cfg.youtubeViralWindows.join(',') || 'none'})`, cfg.enableYoutubeTransform, 'ENABLE_YOUTUBE_TRANSFORM=true (+ YOUTUBE_API_KEY for the most-popular chart; YTDLP_COOKIES_B64 if downloads get bot-walled)');
  check(`Transformation review ${cfg.transformationReview ? 'ON' : 'OFF'} (max risk ${cfg.maxCopyrightRisk})`, true);
  check('R2 credentials', !!(cfg.r2.accountId && cfg.r2.accessKeyId && cfg.r2.publicBaseUrl), 'R2_* vars; Buffer needs a public video URL');
  check('Control-plane API', !!(cfg.apiUrl && cfg.apiToken), 'TOASTER_API_URL/TOKEN (falls back to work/db.json)');
  check('Alert webhook', !!process.env.ALERT_WEBHOOK_URL, 'ALERT_WEBHOOK_URL (optional; GitHub issues + step summary still work in Actions)');
  check('Buffer review tag', !!cfg.bufferTagReviewId, 'BUFFER_TAG_REVIEW_ID (optional: marks review-path drafts in the Buffer UI; the readiness report lists them regardless)');
  check(`Contact e-mail in credits: ${cfg.contactEmail}`, true);
  check(`Commentary default: ${cfg.commentaryDefault}`, true);
  check('Brand: mascot.png', fs.existsSync(path.join(cfg.assetsDir, 'brand', 'mascot.png')), 'using placeholder');
  check('Brand: background_loop.mp4', fs.existsSync(path.join(cfg.assetsDir, 'brand', 'background_loop.mp4')), 'using procedural sunburst');
  check('Font', fs.existsSync(path.join(cfg.templateDir, 'fonts', 'Bangers-Regular.ttf')));
  console.log(`default discovery sources: ${defaultSources(cfg) || '(none)'}`);
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
