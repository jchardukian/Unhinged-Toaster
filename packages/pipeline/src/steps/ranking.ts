import fs from 'node:fs';
import path from 'node:path';
import { escapeDrawtext, type Candidate } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { chatJson } from '../llm.js';
import { ffprobe, run } from './media.js';
import { fontPath, loadTemplate } from './render.js';
import { sfxPath } from './sfx.js';

/**
 * Real-dog ranking compilations: 3–5 licensed clips, strongest hook first, best payoff last, "#N" badges and a short
 * caption per clip, quick cross-fades, a whoosh on every cut and a tiny fanfare on the #1 reveal. The assembled
 * 1080×1920 clip is then handed to the normal renderShort (headline, mascot, wordmark, music, loudnorm) so the brand
 * treatment is identical to every other Short.
 */
export interface RankingSegment { candidate: Candidate; clipPath: string; label: string; start?: number; seconds: number }
export interface RankingPlan { title: string; headline: string; commentary: string; order: { candidate_id: string; label: string }[] }

export const RANKING_MIN_CLIPS = 3, RANKING_MAX_CLIPS = 5, RANKING_MAX_SEC = 40, RANKING_CLIP_MIN = 4, RANKING_CLIP_MAX = 9;

/** Ask the copywriter for a ranking theme, order and per-clip labels; falls back to score order. */
export async function planRanking(cfg: Config, clips: Candidate[]): Promise<RankingPlan> {
  const fallback: RankingPlan = {
    title: 'Ranking dogs who immediately regretted their decisions', headline: 'DOGS WHO REGRETTED IT', commentary: 'Not one of these dogs thought it through and I respect every single one.',
    order: [...clips].sort((a, b) => (a.final_score ?? 0) - (b.final_score ?? 0)).map((c) => ({ candidate_id: c.id, label: (c.visual_summary ?? c.title).split(/[.,;]/)[0].slice(0, 34) })),
  };
  try {
    const r = await chatJson<RankingPlan>(cfg,
      `You produce a ranked dog-comedy compilation for "The Unhinged Toaster" (angry toaster mascot, PG, loud comic-book energy). Given 3-5 clips with what happens in each, pick a punchy theme and return JSON {"title": string (<= 60 chars, e.g. "Ranking dogs who immediately regretted their decisions"), "headline": string (<= 5 words ALL CAPS for the top of the video), "commentary": string (one sentence the toaster yells, <= 85 chars), "order": [{"candidate_id": string, "label": string (<= 34 chars, what the dog does, ALL CAPS not needed)}]}. order lists the clips from the LAST place (#N, shown first) to #1 (shown last): the strongest hook first, the best payoff last. Use every clip exactly once.`,
      JSON.stringify({ clips: clips.map((c) => ({ candidate_id: c.id, what_happens: c.visual_summary ?? c.title, score: c.final_score })) }), { temperature: 0.7, maxTokens: 400 });
    const ids = new Set(clips.map((c) => c.id));
    if (r.order?.length === clips.length && r.order.every((o) => ids.has(o.candidate_id)) && new Set(r.order.map((o) => o.candidate_id)).size === clips.length && r.headline && r.commentary) {
      return { title: r.title?.slice(0, 60) || fallback.title, headline: r.headline.slice(0, 50), commentary: r.commentary.slice(0, 100), order: r.order.map((o) => ({ candidate_id: o.candidate_id, label: String(o.label ?? '').slice(0, 34) })) };
    }
  } catch (e) { log.warn(`planRanking: ${(e as Error).message.slice(0, 120)}; using score order`); }
  return fallback;
}

/** Trim each clip to its best window (around the detected peak when known), capped so the whole ranking stays under 40 s. */
export function segmentSeconds(n: number, max = RANKING_MAX_SEC): number {
  return Math.max(RANKING_CLIP_MIN, Math.min(RANKING_CLIP_MAX, Math.floor((max - 1.5) / n)));
}

/** Build the 1080×1920 ranking clip (badges, labels, cross-fades, cut whooshes, #1 fanfare). Returns the assembled file and the SFX cue list for renderShort. */
export async function assembleRanking(cfg: Config, segments: RankingSegment[], outPath: string): Promise<{ path: string; sfx: { path: string; at: number; gain?: number }[]; durationSec: number }> {
  const t = loadTemplate(cfg);
  const font = fontPath(cfg, t);
  const W = 1080, H = 1920, fps = 30, xfade = 0.3;
  const inputs: string[] = [];
  const f: string[] = [];
  let acc = 0;
  const cutTimes: number[] = [];
  segments.forEach((s, i) => {
    inputs.push('-ss', (s.start ?? 0).toFixed(2), '-t', s.seconds.toFixed(2), '-i', s.clipPath);
    const rank = segments.length - i;
    const badge = `drawtext=fontfile='${esc(font)}':text='${escapeDrawtext(`#${rank}`)}':fontsize=150:fontcolor=${rank === 1 ? '#FFD400' : 'white'}:borderw=10:bordercolor=#111111:x=60:y=420:enable='between(t,0,${s.seconds.toFixed(2)})'`;
    const label = `drawtext=fontfile='${esc(font)}':text='${escapeDrawtext(s.label.toUpperCase())}':fontsize=58:fontcolor=white:borderw=7:bordercolor=#111111:x=(w-text_w)/2:y=1400`;
    // contain without cropping onto a dark canvas (the brand burst comes from renderShort behind it only when the source is not full-bleed)
    f.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=#111111,setsar=1,fps=${fps},format=yuv420p,${badge},${label}[v${i}]`);
    f.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${s.seconds.toFixed(2)},asetpts=PTS-STARTPTS[a${i}]`);
    if (i > 0) cutTimes.push(acc);
    acc += s.seconds - (i > 0 ? xfade : 0);
  });
  // chained xfade / acrossfade
  let v = 'v0', a = 'a0', offset = 0;
  for (let i = 1; i < segments.length; i++) {
    offset += segments[i - 1].seconds - xfade;
    f.push(`[${v}][v${i}]xfade=transition=slideleft:duration=${xfade}:offset=${offset.toFixed(2)}[vx${i}]`);
    f.push(`[${a}][a${i}]acrossfade=d=${xfade}[ax${i}]`);
    v = `vx${i}`; a = `ax${i}`;
  }
  const total = segments.reduce((s, x) => s + x.seconds, 0) - xfade * (segments.length - 1);
  await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', f.join(';'), '-map', `[${v}]`, '-map', `[${a}]`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath]);
  const p = await ffprobe(outPath);
  const sfx: { path: string; at: number; gain?: number }[] = [];
  const whoosh = sfxPath(cfg, 'whoosh'), victory = sfxPath(cfg, 'victory'), ding = sfxPath(cfg, 'ding');
  cutTimes.forEach((ct, i) => {
    const at = ct - xfade * i;
    if (whoosh) sfx.push({ path: whoosh, at: Math.max(0, at - 0.05), gain: 0.6 });
    if (ding && i < cutTimes.length - 1) sfx.push({ path: ding, at: at + 0.25, gain: 0.5 });
  });
  if (victory && cutTimes.length) sfx.push({ path: victory, at: Math.max(0, cutTimes[cutTimes.length - 1] - xfade * (cutTimes.length - 1) + 0.3), gain: 0.8 });
  return { path: outPath, sfx, durationSec: p.duration || total };
}

const esc = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
export function rankingWorkDir(cfg: Config, id: string): string { const d = path.join(cfg.workDir, 'jobs', id); fs.mkdirSync(d, { recursive: true }); return d; }
