import fs from 'node:fs';
import path from 'node:path';
import { ffprobe, run } from './media.js';

/**
 * 2x3 contact sheet (six frames at 8/25/42/58/75/92 % of the clip) as a small JPEG for the vision model.
 * Cheap (one low-detail image) and enough to see the action, the payoff and any on-screen watermark/handle.
 */
export async function contactSheet(video: string, outJpg: string, cols = 3, rows = 2, tileW = 360): Promise<string> {
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
