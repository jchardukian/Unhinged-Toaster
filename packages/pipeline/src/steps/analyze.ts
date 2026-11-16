import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectPeak } from '@toaster/shared';
import { log } from '../config.js';
import { ffprobe } from './media.js';

const execFileP = promisify(execFile);

export interface ClipAnalysis {
  duration: number;
  hasAudio: boolean;
  peak: { t: number; method: string } | null;
  audioRms: { t: number; db: number }[];
  sceneScores: { t: number; score: number }[];
  loudnessDb: number | null;   // mean RMS (for "is there usable audio")
}

/** Per-100ms audio RMS and per-frame scene-change scores via FFmpeg metadata filters; picks the moment of interest. */
export async function analyzeClip(file: string): Promise<ClipAnalysis> {
  const probe = await ffprobe(file);
  const audioRms: { t: number; db: number }[] = [];
  if (probe.hasAudio) {
    try {
      const { stdout, stderr } = await execFileP('ffmpeg', ['-v', 'info', '-nostats', '-i', file, '-vn', '-af', 'aresample=16000,asetnsamples=1600,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'], { maxBuffer: 64 << 20 });
      parseMetadata(stdout + '\n' + stderr, 'lavfi.astats.Overall.RMS_level').forEach(({ t, v }) => audioRms.push({ t, db: v }));
    } catch (e) { log.warn(`audio analysis failed: ${(e as Error).message.split('\n')[0]}`); }
  }
  const sceneScores: { t: number; score: number }[] = [];
  try {
    const { stdout, stderr } = await execFileP('ffmpeg', ['-v', 'info', '-nostats', '-i', file, '-an', '-vf', "scale=160:-2,select='gte(scene,0)',metadata=mode=print:key=lavfi.scene_score:file=-", '-f', 'null', '-'], { maxBuffer: 64 << 20 });
    parseMetadata(stdout + '\n' + stderr, 'lavfi.scene_score').forEach(({ t, v }) => sceneScores.push({ t, score: v }));
  } catch (e) { log.warn(`scene analysis failed: ${(e as Error).message.split('\n')[0]}`); }
  const peak = detectPeak({ audioRms, sceneScores, duration: probe.duration });
  const finite = audioRms.filter((x) => x.db > -90);
  const loudnessDb = finite.length ? finite.reduce((a, x) => a + x.db, 0) / finite.length : null;
  log.info(`analysis: duration ${probe.duration.toFixed(1)}s, audio ${probe.hasAudio ? `${finite.length} samples, mean ${loudnessDb?.toFixed(1)} dB` : 'none'}, scenes ${sceneScores.length}, peak ${peak ? `${peak.t}s (${peak.method})` : 'none'}`);
  return { duration: probe.duration, hasAudio: probe.hasAudio, peak, audioRms, sceneScores, loudnessDb };
}

/**
 * The metadata filter prints blocks like:
 *   frame:12   pts:19200 pts_time:1.2
 *   lavfi.astats.Overall.RMS_level=-23.4
 * (ametadata/metadata with file=- writes to stdout, which ffmpeg mixes into stderr when -f null; we parse both.)
 */
export function parseMetadata(text: string, key: string): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  let t: number | null = null;
  for (const line of text.split('\n')) {
    const f = line.match(/pts_time:([\d.]+)/);
    if (f) { t = Number(f[1]); continue; }
    if (t != null && line.startsWith(key + '=')) {
      const v = Number(line.slice(key.length + 1));
      if (Number.isFinite(v)) out.push({ t, v });
      else if (/-inf/i.test(line)) out.push({ t, v: -120 });
    }
  }
  return out;
}

/**
 * Dead lead-in (deep dive 2026-11-16, owner priority: swipe rate): when a clip opens still AND quiet, start it just
 * before the first motion or sound. Conservative by design: at most `maxTrim` seconds, never inside the setup before
 * the detected peak (`keepBeforePeak`), never leaving less than `minRemain` seconds, and nothing under `minTrim`.
 */
export const LEAD_IN = { window: 0.5, motion: 0.008, quietBelowMeanDb: 8, maxTrim: 3, minTrim: 0.6, preRoll: 0.25, keepBeforePeak: 1.0, minRemain: 6 } as const;

export function leadInTrim(a: Pick<ClipAnalysis, 'duration' | 'sceneScores' | 'audioRms' | 'peak' | 'loudnessDb'>, o = LEAD_IN): number {
  if (!a.sceneScores.length) return 0;
  const horizon = Math.min(o.maxTrim + o.preRoll + o.window, a.duration);
  // first moment with visible motion: mean scene score over a short window
  let motionAt = horizon;
  for (const s of a.sceneScores) {
    if (s.t >= horizon) break;
    const win = a.sceneScores.filter((x) => x.t >= s.t && x.t < s.t + o.window);
    if (win.length && win.reduce((m, x) => m + x.score, 0) / win.length >= o.motion) { motionAt = s.t; break; }
  }
  // first moment with real sound (speech, a bark, a crash): close to the clip's mean loudness
  let soundAt = horizon;
  if (a.loudnessDb != null) {
    const hit = a.audioRms.find((x) => x.t < horizon && x.db > -45 && x.db >= a.loudnessDb! - o.quietBelowMeanDb);
    if (hit) soundAt = hit.t;
  }
  let trim = Math.min(motionAt, soundAt) - o.preRoll;
  trim = Math.min(trim, o.maxTrim, a.duration - o.minRemain);
  if (a.peak) trim = Math.min(trim, a.peak.t - o.keepBeforePeak);
  return trim >= o.minTrim ? Math.round(trim * 100) / 100 : 0;
}
