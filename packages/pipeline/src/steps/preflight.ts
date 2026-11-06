import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BufferClient, type Candidate } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { breakerState, fetchWithTimeout, spentUsd } from '../guard.js';
import { scoreCandidate } from './score.js';

/**
 * Preflight: everything the weekly run depends on, checked in ~30 seconds for well under a cent, before a single
 * candidate is discovered. One cheap real scoring call proves the LLM model/key pair works (the 400 "you must provide
 * a model parameter" of run 42237222419 would have failed here in 5 seconds instead of after 19 minutes).
 * Essential failures make the command exit 1; optional ones are reported. Secret values are never printed.
 */
export interface Check { name: string; ok: boolean; essential: boolean; detail: string }
export type PreflightMode = 'production' | 'diagnostic';

export async function runPreflight(cfg: Config, mode: PreflightMode, deps: { fetch?: typeof fetch; score?: typeof scoreCandidate; bufferClient?: (key: string) => Pick<BufferClient, 'account' | 'channels'>; hasTool?: (tool: string) => boolean } = {}): Promise<{ ok: boolean; checks: Check[]; markdown: string }> {
  const get = (url: string, init: RequestInit = {}, ms = 15_000) => (deps.fetch ? deps.fetch(url, init) : fetchWithTimeout(url, init, ms, url));
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, essential: boolean, detail: string) => { checks.push({ name, ok, essential, detail }); log.info(`${ok ? 'OK  ' : essential ? 'FAIL' : 'warn'} ${name}: ${detail}`); };
  const production = mode === 'production';

  // ---- configuration (names only)
  add('LLM model', !!cfg.llmModel.trim(), true, cfg.llmModel.trim() ? `${cfg.llmProvider} / ${cfg.llmModel}` : 'LLM_MODEL is blank');
  add('OpenAI key', !!cfg.openaiKey || !!process.env.HTTPS_PROXY, true, cfg.openaiKey ? 'OPENAI_API_KEY present' : process.env.HTTPS_PROXY ? 'no key, proxy may inject one' : 'OPENAI_API_KEY missing');
  add('ElevenLabs key', !!cfg.elevenKey || !!process.env.HTTPS_PROXY, false, cfg.elevenKey ? 'ELEVENLABS_API_KEY present' : 'missing: videos would ship without voice');
  add('Buffer key', !!cfg.bufferKey, production, cfg.bufferKey ? 'BUFFER_API_KEY present' : 'BUFFER_API_KEY missing' + (production ? '' : ' (not needed for this diagnostic)'));
  add('Control plane settings', !!(cfg.apiUrl && cfg.apiToken), production, cfg.apiUrl && cfg.apiToken ? `TOASTER_API_URL + TOASTER_API_TOKEN present (${cfg.apiUrl})` : !cfg.apiUrl ? 'TOASTER_API_URL missing (config/worker-url.txt not found)' : 'TOASTER_API_TOKEN missing' + (production ? '' : ' (local store will be used)'));
  const hasTool = deps.hasTool ?? ((tool: string) => { try { execFileSync(tool, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } });
  for (const tool of ['ffmpeg', 'ffprobe']) { const ok = hasTool(tool); add(`tool ${tool}`, ok, true, ok ? 'found' : 'not installed'); }
  add('brand assets', ['mascot.png', 'logo.png', 'wordmark.png'].every((a) => fs.existsSync(path.join(cfg.assetsDir, 'brand', a))), true, 'mascot / logo / wordmark');
  add('headline font', fs.existsSync(path.join(cfg.templateDir, 'fonts', 'Bangers-Regular.ttf')), true, 'template/fonts/Bangers-Regular.ttf');

  // ---- one real, cheap scoring call with the configured model (~$0.0003)
  const before = spentUsd();
  try {
    const probe: Candidate = { id: 'PREFLIGHT', source_platform: 'reddit', source_id: 'preflight', source_url: 'https://www.reddit.com/r/funny/comments/preflight/x/', title: 'Dog steals an entire pizza off the counter while owner films', description: 'r/funny', category: 'funny_animals', duration_sec: 12, views: null, likes: 120, comments: null, shares: null, rights_status: 'transformation_review', rights_basis: null, status: 'discovered', discovered_at: new Date().toISOString(), updated_at: '' } as Candidate;
    const scored = await (deps.score ?? scoreCandidate)(cfg, probe, [], null);
    const ok = scored.llm_score != null;
    add('OpenAI scoring call', ok, true, ok ? `model ${cfg.llmModel} answered (llm_score ${scored.llm_score}, $${(spentUsd() - before).toFixed(4)})` : `no score: ${scored.status_reason ?? 'unknown error'}`);
  } catch (e) { add('OpenAI scoring call', false, true, (e as Error).message.slice(0, 200)); }

  // ---- Cloudflare control plane
  if (cfg.apiUrl) {
    try {
      const h = await get(`${cfg.apiUrl.replace(/\/$/, '')}/health`);
      add('Worker reachable', h.ok, production, `GET /health -> ${h.status}`);
      if (cfg.apiToken) {
        const a = await get(`${cfg.apiUrl.replace(/\/$/, '')}/candidates?limit=1`, { headers: { authorization: `Bearer ${cfg.apiToken}` } });
        add('Worker token accepted', a.status === 200, production, a.status === 200 ? 'GET /candidates -> 200' : a.status === 401 ? '401: TOASTER_API_TOKEN differs from the Worker API_TOKEN secret (re-run the deploy workflow)' : `GET /candidates -> ${a.status}`);
      }
      const m = await get(`${cfg.apiUrl.replace(/\/$/, '')}/media/deploy-probe/ok.txt`);
      add('Public media route', m.status === 200 || m.status === 404, production, m.status === 200 ? 'public GET works' : m.status === 404 ? 'route answers (probe object absent)' : `-> ${m.status}`);
    } catch (e) { add('Worker reachable', false, production, (e as Error).message.slice(0, 160)); }
  }

  // ---- Buffer (read-only)
  if (cfg.bufferKey) {
    try {
      const client = deps.bufferClient ? deps.bufferClient(cfg.bufferKey) : new BufferClient({ apiKey: cfg.bufferKey, maxRetries: 1 });
      const acct = await client.account();
      const orgOk = acct.organizations.some((o) => o.id === cfg.bufferOrgId);
      add('Buffer account', orgOk, production, orgOk ? `organization ${cfg.bufferOrgId} visible, account time zone ${acct.timezone}` : `organization ${cfg.bufferOrgId} not in this key's account`);
      const chans = await client.channels(cfg.bufferOrgId);
      const yt = chans.find((c) => c.id === cfg.bufferYoutubeChannelId), tt = chans.find((c) => c.id === cfg.bufferTiktokChannelId);
      add('Buffer channels', !!yt && !!tt, production, `${yt ? `youtube "${yt.name}"` : 'YouTube channel id not found'}; ${tt ? `tiktok "${tt.name}"` : 'TikTok channel id not found'} (no post created)`);
    } catch (e) { add('Buffer account', false, production, (e as Error).message.slice(0, 160)); }
  }

  // ---- ElevenLabs (read-only) and Reddit feed
  try {
    const headers: Record<string, string> = cfg.elevenKey ? { 'xi-api-key': cfg.elevenKey } : {};
    const r = await get('https://api.elevenlabs.io/v1/voices', { headers });
    add('ElevenLabs voices', r.ok, false, r.ok ? `voices list -> 200${cfg.elevenVoiceId ? `, voice pinned` : ', first energetic voice will be auto-picked'}` : `-> ${r.status}`);
  } catch (e) { add('ElevenLabs voices', false, false, (e as Error).message.slice(0, 120)); }
  try {
    const r = await get('https://www.reddit.com/r/AnimalsBeingDerps/top/.rss?t=day&limit=3', { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', accept: 'application/atom+xml' } });
    const xml = r.ok ? await r.text() : '';
    // 429 is Reddit's per-IP rate limit, which the discovery adapter retries with 15/30 s back-off: a warning, not a block
    add('Reddit feed', r.ok && xml.includes('<entry>'), r.status !== 429, r.ok ? `top-of-day feed -> ${xml.includes('<entry>') ? 'entries present' : 'no entries'}` : `-> ${r.status}${r.status === 429 ? ' (rate limited right now; runs retry with back-off)' : ''}`);
  } catch (e) { add('Reddit feed', false, true, (e as Error).message.slice(0, 120)); }

  const ok = checks.every((c) => c.ok || !c.essential);
  const tripped = breakerState();
  const md = [`## Preflight (${mode}) ${ok ? '✅ ready' : '❌ blocked'}`, '', '| check | result | detail |', '|---|---|---|',
    ...checks.map((c) => `| ${c.name} | ${c.ok ? '✅' : c.essential ? '❌' : '⚠️'} | ${c.detail.replace(/\|/g, '/')} |`),
    '', `API spend for this preflight: $${spentUsd().toFixed(4)}${Object.keys(tripped).length ? `; circuit breakers: ${JSON.stringify(tripped)}` : ''}`].join('\n');
  return { ok, checks, markdown: md };
}
