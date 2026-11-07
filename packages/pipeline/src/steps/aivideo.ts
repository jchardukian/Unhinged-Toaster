import fs from 'node:fs';
import path from 'node:path';
import { log, type Config } from '../config.js';
import { assertOpen, assertVideoBudget, fetchWithTimeout, recordFailure, recordSuccess, StageTimeoutError, videoBudget } from '../guard.js';
import { recordVideoGen } from '../usage.js';
import { run } from './media.js';

/**
 * AI video providers behind one interface so two models can be benchmarked without touching the pipeline.
 * Facts verified on the official docs on 2026-11-07 (see docs/DOG_CONTENT_PLAN.md):
 *  - gemini: Gemini API "Gemini Omni 1.2 Flash" (Veo 3.1 was shut down in the Gemini API on 2026-10-22):
 *    POST https://generativelanguage.googleapis.com/v1beta/interactions, model gemini-omni-1.2-flash, 3–15 s,
 *    aspect_ratio 9:16, 720p default, native audio, ≈ $0.07 per 720p second (5,792 tokens/s at $12 per 1M output tokens).
 *  - runway: Runway developer API, POST /v1/text_to_video, X-Runway-Version 2024-11-06, task polling GET /v1/tasks/{id},
 *    output URLs expire in 24–48 h. kling_4_flash 720p, 3–20 s, audio, 9.4 credits/s (29-credit minimum); gen4.5 12 cr/s.
 *  - mock: ffmpeg-synthesised clip, $0, for tests and non-paid runs.
 * Every attempt is metered (recordVideoGen) and checked against the HARD AI_VIDEO_BUDGET_USD cap before it starts.
 */
export interface GenerateRequest { prompt: string; seconds: number; ratio: '9:16'; negative?: string; outPath: string }
export interface GenerateResult { path: string; provider: string; model: string; jobId: string; seconds: number; usd: number; elapsedSec: number }
export interface VideoProvider {
  readonly name: string;
  readonly model: string;
  /** published price of ONE attempt of this length, in USD (for the budget check before the call) */
  estimateUsd(seconds: number): number;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export type ProviderName = 'gemini' | 'runway' | 'mock';

export function makeProvider(cfg: Config, name: ProviderName, modelOverride?: string): VideoProvider {
  if (name !== 'mock' && videoBudget() <= 0) throw new Error(`paid AI video generation is paused (AI_VIDEO_BUDGET_USD is 0); provider '${name}' not started. The code stays available for a future, explicitly budgeted run.`);
  if (name === 'gemini') return new GeminiProvider(cfg, modelOverride ?? process.env.AI_VIDEO_MODEL_GEMINI ?? 'gemini-omni-1.2-flash');
  if (name === 'runway') return new RunwayProvider(cfg, modelOverride ?? process.env.AI_VIDEO_MODEL_RUNWAY ?? 'kling_4_flash');
  return new MockProvider();
}

/** Budgeted wrapper: refuses when the next attempt would cross the cap, records every attempt. */
export async function generateClip(p: VideoProvider, req: GenerateRequest): Promise<GenerateResult> {
  const est = p.estimateUsd(req.seconds);
  assertVideoBudget(est);
  assertOpen(`video:${p.name}`);
  const t0 = Date.now();
  try {
    const r = await p.generate(req);
    recordVideoGen(p.name, r.seconds, r.usd, 'pending');
    recordSuccess(`video:${p.name}`);
    log.info(`ai video ${p.name}/${p.model}: ${r.seconds}s in ${r.elapsedSec}s, $${r.usd.toFixed(2)} (job ${r.jobId})`);
    return r;
  } catch (e) {
    // a failed call may or may not be billed; count the published price conservatively
    recordVideoGen(p.name, req.seconds, est, 'failed');
    throw e;
  }
}

// ------------------------------------------------------------------ Google Gemini (Omni 1.2 Flash)
export class GeminiProvider implements VideoProvider {
  readonly name = 'gemini';
  constructor(private readonly cfg: Config, readonly model: string) {}
  estimateUsd(seconds: number): number { return seconds * 0.0695; } // 5,792 tokens/s × $12 / 1M (720p)
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set (Google AI Studio → API keys; billing must be enabled for video)');
    const t0 = Date.now();
    const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/interactions?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: req.prompt, response_format: { type: 'video', aspect_ratio: req.ratio, resolution: '720p', duration: `${Math.round(req.seconds)}s` } }),
    }, 600_000, 'Gemini video');
    if (!res.ok) { const body = (await res.text()).slice(0, 300); const fatal = recordFailure(`video:${this.name}`, res.status, body); throw fatal ?? new Error(`Gemini ${res.status}: ${body}`); }
    const j = (await res.json()) as GeminiInteraction;
    const video = findGeminiVideo(j);
    if (!video) throw new Error(`Gemini returned no video (status ${j.status ?? '?'}): ${JSON.stringify(j).slice(0, 200)}`);
    if (video.data) fs.writeFileSync(req.outPath, Buffer.from(video.data, 'base64'));
    else if (video.uri) await downloadGeminiFile(key, video.uri, req.outPath);
    else throw new Error('Gemini video content has neither data nor uri');
    return { path: req.outPath, provider: this.name, model: this.model, jobId: j.id ?? 'n/a', seconds: req.seconds, usd: this.estimateUsd(req.seconds), elapsedSec: Math.round((Date.now() - t0) / 1000) };
  }
}
interface GeminiInteraction { id?: string; status?: string; steps?: { type?: string; content?: { type?: string; mime_type?: string; data?: string; uri?: string; file_uri?: string }[] }[]; output_video?: { data?: string; uri?: string } }
export function findGeminiVideo(j: GeminiInteraction): { data?: string; uri?: string } | null {
  if (j.output_video?.data || j.output_video?.uri) return j.output_video;
  for (const s of j.steps ?? []) for (const c of s.content ?? []) if (c.type === 'video' || c.mime_type?.startsWith('video/')) return { data: c.data, uri: c.uri ?? c.file_uri };
  return null;
}
async function downloadGeminiFile(key: string, uri: string, out: string): Promise<void> {
  // uri is a files API resource (files/<id>) or a full URL; poll until ACTIVE then download alt=media
  const base = uri.startsWith('http') ? uri : `https://generativelanguage.googleapis.com/v1beta/${uri}`;
  for (let i = 0; i < 60; i++) {
    const meta = await fetchWithTimeout(`${base}?key=${encodeURIComponent(key)}`, {}, 30_000, 'Gemini file');
    if (meta.ok) { const m = (await meta.json()) as { state?: string }; if (!m.state || m.state === 'ACTIVE') break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  const dl = await fetchWithTimeout(`${base}:download?alt=media&key=${encodeURIComponent(key)}`, {}, 300_000, 'Gemini download');
  if (!dl.ok) throw new Error(`Gemini file download ${dl.status}`);
  fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
}

// ------------------------------------------------------------------ Runway developer API (Kling / Gen-4.5 / Veo via one platform)
const RUNWAY_CREDITS_PER_SEC: Record<string, number> = { kling_4_flash: 9.4, kling_4: 12.56, 'gen4.5': 12, gen4_turbo: 5, 'veo3.1_fast': 15, 'veo3.1': 40 };
export class RunwayProvider implements VideoProvider {
  readonly name = 'runway';
  constructor(private readonly cfg: Config, readonly model: string) {}
  estimateUsd(seconds: number): number {
    const perSec = RUNWAY_CREDITS_PER_SEC[this.model] ?? 15;
    const credits = Math.max(this.model === 'kling_4_flash' ? 29 : 10, Math.ceil(perSec * seconds));
    return credits * 0.01;
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const key = process.env.RUNWAY_API_KEY;
    if (!key) throw new Error('RUNWAY_API_KEY is not set (dev.runwayml.com → API keys; buy credits first)');
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06' };
    const t0 = Date.now();
    const start = await fetchWithTimeout('https://api.dev.runwayml.com/v1/text_to_video', {
      method: 'POST', headers, body: JSON.stringify({ model: this.model, promptText: req.prompt, ratio: '720:1280', duration: Math.round(req.seconds) }),
    }, 60_000, 'Runway text_to_video');
    if (!start.ok) { const body = (await start.text()).slice(0, 300); const fatal = recordFailure(`video:${this.name}`, start.status, body); throw fatal ?? new Error(`Runway ${start.status}: ${body}`); }
    const task = (await start.json()) as { id: string };
    let output: string[] | undefined;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const poll = await fetchWithTimeout(`https://api.dev.runwayml.com/v1/tasks/${task.id}`, { headers }, 30_000, 'Runway task');
      if (!poll.ok) throw new Error(`Runway task poll ${poll.status}`);
      const t = (await poll.json()) as { status: string; output?: string[]; failure?: string; failureCode?: string };
      if (t.status === 'SUCCEEDED') { output = t.output; break; }
      if (t.status === 'FAILED' || t.status === 'CANCELLED') throw new Error(`Runway task ${t.status}: ${t.failure ?? t.failureCode ?? 'no detail'}`);
    }
    if (!output?.[0]) throw new StageTimeoutError('Runway task', 600_000);
    const dl = await fetchWithTimeout(output[0], {}, 300_000, 'Runway download');
    if (!dl.ok) throw new Error(`Runway output download ${dl.status}`);
    fs.writeFileSync(req.outPath, Buffer.from(await dl.arrayBuffer()));
    return { path: req.outPath, provider: this.name, model: this.model, jobId: task.id, seconds: req.seconds, usd: this.estimateUsd(req.seconds), elapsedSec: Math.round((Date.now() - t0) / 1000) };
  }
}

// ------------------------------------------------------------------ mock (free): a moving test pattern with a spoken-looking beat, for tests and dry runs
export class MockProvider implements VideoProvider {
  readonly name = 'mock';
  readonly model = 'ffmpeg-testsrc';
  estimateUsd(): number { return 0; }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const t0 = Date.now();
    fs.mkdirSync(path.dirname(req.outPath), { recursive: true });
    const label = req.prompt.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 28);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=720x1280:rate=30:duration=${req.seconds}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${req.seconds}`,
      '-vf', `drawtext=text='MOCK AI DOG':fontsize=64:fontcolor=white:borderw=4:x=(w-text_w)/2:y=h/2-60,drawtext=text='${label}':fontsize=28:fontcolor=yellow:x=(w-text_w)/2:y=h/2+40`,
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', req.outPath]);
    return { path: req.outPath, provider: this.name, model: this.model, jobId: `mock-${Date.now()}`, seconds: req.seconds, usd: 0, elapsedSec: Math.round((Date.now() - t0) / 1000) };
  }
}
