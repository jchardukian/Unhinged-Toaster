import fs from 'node:fs';
import path from 'node:path';
import { ffprobe, run } from './media.js';

/**
 * 2x3 contact sheet (six frames at 8/25/42/58/75/92 % of the clip) as a small JPEG for the vision model.
 * Cheap (one low-detail image) and enough to see the action, the payoff and any on-screen watermark/handle.
 */
export async function contactSheet(video: string, outJpg: string, cols = 3, rows = 2, tileW = 512): Promise<string> {
  const p = await ffprobe(video);
  const n = cols * rows;
  const fps = n / Math.max(0.5, p.duration);
  const tileH = Math.round(tileW * (p.height / p.width) / 2) * 2;
  await run('ffmpeg', ['-y', '-v', 'error', '-i', video, '-vf', `fps=${fps.toFixed(5)},scale=${tileW}:${tileH}:flags=area,tile=${cols}x${rows}:padding=4:margin=4`, '-frames:v', '1', '-q:v', '5', outJpg]);
  return outJpg;
}

export function sheetBase64(file: string): string | undefined {
  try { return fs.readFileSync(file).toString('base64'); } catch { return undefined; }
}

export function sheetPathFor(dir: string): string { return path.join(dir, 'frames.jpg'); }

import { chatJson } from '../llm.js';
import type { Config } from '../config.js';

const OCR_SYSTEM = 'You read on-screen watermarks in short-video frames. Respond with JSON {"handle": string|null, "platform": "instagram"|"tiktok"|"youtube"|"snapchat"|"facebook"|"twitter"|"other"|null, "confidence": "high"|"medium"|"low"}. Transcribe the creator handle EXACTLY as printed (letters, digits, dots, underscores), without the @. If no watermark or handle is visible, or any character is unclear, handle must be null.';

/**
 * Creator handle printed in the footage (platform watermark). Read from two different full-resolution frames with a
 * dedicated vision model; accepted only when both reads agree exactly, so a misread never becomes a wrong credit.
 */
export async function readWatermark(cfg: Config, video: string, dir: string): Promise<{ handle: string; platform: string | null } | null> {
  const p = await ffprobe(video);
  const times = [Math.min(2, p.duration * 0.2), Math.max(0.5, p.duration * 0.7)];
  const reads: { handle: string | null; platform: string | null }[] = [];
  for (let i = 0; i < times.length; i++) {
    const frame = path.join(dir, `wm_${i}.jpg`);
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', times[i].toFixed(2), '-i', video, '-frames:v', '1', '-q:v', '3', frame]);
    const b64 = sheetBase64(frame);
    if (!b64) return null;
    try {
      const r = await chatJson<{ handle?: string | null; platform?: string | null; confidence?: string }>({ ...cfg, llmModel: cfg.visionOcrModel }, OCR_SYSTEM,
        'Frame from a vertical video. Is there a platform watermark or creator handle? Transcribe exactly.', { temperature: 0, maxTokens: 120, imageJpegBase64: b64 });
      const h = typeof r.handle === 'string' ? r.handle.replace(/^@/, '').trim() : null;
      reads.push({ handle: h && /^[A-Za-z0-9._]{2,40}$/.test(h) && r.confidence !== 'low' ? h.toLowerCase() : null, platform: typeof r.platform === 'string' ? r.platform.toLowerCase() : null });
    } catch { reads.push({ handle: null, platform: null }); }
  }
  const [a, b] = reads;
  if (a.handle && b.handle && a.handle === b.handle) {
    const platform = a.platform ?? b.platform ?? null;
    if (!isCreatorHandle(a.handle, platform)) return null;
    return { handle: a.handle, platform };
  }
  return null;
}

/** Camera / app / platform brands printed in footage are not creators: never credit them. Pure, for tests. */
const BRAND_WATERMARKS = new Set(['blink', 'ring', 'nest', 'arlo', 'wyze', 'eufy', 'gopro', 'dji', 'insta360', 'hikvision', 'reolink', 'lorex', 'tiktok', 'capcut', 'instagram', 'reels', 'youtube', 'shorts', 'snapchat', 'facebook', 'twitter', 'x', 'kick', 'twitch', 'vsco', 'viralhog', 'jukin', 'storyful', 'newsflare', 'collab', 'ladbible', 'unilad', 'dailymail', 'espn', 'nfl', 'nba', 'mlb', 'nhl', 'fifa']);
export function isCreatorHandle(handle: string, platform: string | null): boolean {
  const h = handle.toLowerCase().replace(/^@/, '');
  if (BRAND_WATERMARKS.has(h) || BRAND_WATERMARKS.has(h.replace(/[._\d]+$/, ''))) return false;
  // a handle only counts as a creator credit when it comes from a social platform's watermark (not a device/app overlay)
  return ['instagram', 'tiktok', 'youtube', 'snapchat', 'facebook', 'twitter'].includes(platform ?? '');
}
