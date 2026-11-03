import fs from 'node:fs';
import path from 'node:path';
import { escapeDrawtext, wrapText } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { assColor, buildAss, type Word } from './captions.js';
import { ffprobe, run } from './media.js';

export interface Template {
  canvas: { width: number; height: number; fps: number };
  colors: Record<string, string>;
  font: string;
  assets: Record<string, string>;
  handle: string;
  headline: { x: number; y: number; boxWidth: number; maxCharsPerLine: number; maxLines: number; fontSizes: number[]; fill: string; outline: string; outlineWidth: number };
  clip: { maxWidth: number; top: number; maxHeight: number; frameWidth: number; shadowOffset: number };
  captions: { fontSize: number; bottomPadding: number; activeColor: string; idleColor: string; outlineColor: string };
  mascot: { width: number; right: number; bottom: number; bobAmplitude: number; bobSpeed: number };
  watermark: { logoWidth: number; x: number; y: number; fontSize: number };
  commentary: { position: 'outro' | 'intro'; outroSeconds: number; fontSize: number; boxColor: string; textColor: string; y: number; maxCharsPerLine: number; maxLines?: number };
  audio: { musicVolume: number; voVolume: number; loudnorm: string };
  limits: { maxDurationSec: number };
}

export interface RenderJob {
  clipPath: string;
  headline: string;
  commentary: string;
  voPath: string | null;          // mp3 of the commentary (optional)
  words: Word[] | null;           // transcript words for captions (optional)
  musicPath: string | null;
  outPath: string;
  workDir: string;
}

export interface RenderResult { outPath: string; durationSec: number; thumbnailPath: string; command: string[] }

export function loadTemplate(cfg: Config): Template {
  const t = JSON.parse(fs.readFileSync(path.join(cfg.templateDir, 'template.json'), 'utf8')) as Template;
  const colorsFile = path.join(cfg.assetsDir, 'brand', 'colors.json');
  if (fs.existsSync(colorsFile)) Object.assign(t.colors, JSON.parse(fs.readFileSync(colorsFile, 'utf8')));
  return t;
}

function asset(cfg: Config, t: Template, key: string): string {
  const primary = path.join(cfg.assetsDir, t.assets[key]);
  if (fs.existsSync(primary)) return primary;
  const fb = t.assets[`${key}_fallback`];
  if (fb && fs.existsSync(path.join(cfg.assetsDir, fb))) return path.join(cfg.assetsDir, fb);
  throw new Error(`missing brand asset "${key}" (${primary}); run npm run brand:generate or add the approved file`);
}

export function fontPath(cfg: Config, t: Template): string {
  const custom = path.join(cfg.assetsDir, 'brand', 'font.ttf');
  return fs.existsSync(custom) ? custom : path.join(cfg.templateDir, t.font);
}

/** Pick a music track from assets/music/manifest.json whose file exists. */
export function pickMusic(cfg: Config, category: string | null): string | null {
  const manifest = path.join(cfg.assetsDir, 'music', 'manifest.json');
  if (!fs.existsSync(manifest)) return null;
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { tracks: { file: string; license?: string; moods?: string[] }[] };
  const ok = m.tracks.filter((tr) => tr.license && fs.existsSync(path.join(cfg.assetsDir, 'music', tr.file)) && (!category || !tr.moods || tr.moods.includes(category)));
  if (ok.length === 0) return null;
  return path.join(cfg.assetsDir, 'music', ok[Math.floor(Math.random() * ok.length)].file);
}

/**
 * Compose the branded 1080x1920 short with a single FFmpeg invocation.
 * Layers (bottom -> top): animated background, clip shadow, clip, yellow frame, headline box + text,
 * captions (ASS), commentary box (intro/outro), watermark, mascot.
 */
export async function renderShort(cfg: Config, t: Template, job: RenderJob): Promise<RenderResult> {
  const probe = await ffprobe(job.clipPath);
  const W = t.canvas.width, H = t.canvas.height, fps = t.canvas.fps;
  const clipDur = Math.min(probe.duration, t.limits.maxDurationSec - (t.commentary.position === 'outro' ? t.commentary.outroSeconds : 0));
  const outro = t.commentary.position === 'outro' ? t.commentary.outroSeconds : 0;
  const total = clipDur + outro;

  // fit clip into the frame
  const scale = Math.min(t.clip.maxWidth / probe.width, t.clip.maxHeight / probe.height);
  const cw = even(Math.floor(probe.width * scale));
  const ch = even(Math.floor(probe.height * scale));
  const cx = Math.round((W - cw) / 2);
  const cy = t.clip.top + Math.round((t.clip.maxHeight - ch) / 2);
  const fw = t.clip.frameWidth, so = t.clip.shadowOffset;

  const font = fontPath(cfg, t);
  const fontsDir = path.dirname(font);
  const bgLoop = path.join(cfg.assetsDir, t.assets.background_loop);
  const useBgLoop = fs.existsSync(bgLoop);
  const bgStill = useBgLoop ? null : asset(cfg, t, 'background_still');
  const mascot = asset(cfg, t, 'mascot');
  const hbox = asset(cfg, t, 'headline_box');
  const logo = asset(cfg, t, 'logo');

  // ---------- inputs
  const inputs: string[] = [];
  let idx = 0;
  const add = (...args: string[]) => { inputs.push(...args); return idx++; };
  const iBg = useBgLoop ? add('-stream_loop', '-1', '-i', bgLoop) : add('-loop', '1', '-framerate', String(fps), '-i', bgStill!);
  const iClip = add('-i', job.clipPath);
  const iMascot = add('-loop', '1', '-i', mascot);
  const iBox = add('-loop', '1', '-i', hbox);
  const iLogo = add('-loop', '1', '-i', logo);
  const shoutPath = path.join(cfg.assetsDir, 'brand', 'mascot_shout.png');
  const iShout = fs.existsSync(shoutPath) ? add('-loop', '1', '-i', shoutPath) : -1;
  const iVo = job.voPath ? add('-i', job.voPath) : -1;
  const iMusic = job.musicPath ? add('-stream_loop', '-1', '-i', job.musicPath) : -1;

  // ---------- captions file
  let assFile: string | null = null;
  if (job.words && job.words.length) {
    assFile = path.join(job.workDir, 'captions.ass');
    fs.writeFileSync(assFile, buildAss(job.words, {
      fontName: fontFamilyName(font), fontSize: t.captions.fontSize, playResX: W, playResY: H,
      marginV: H - (cy + ch) + t.captions.bottomPadding,
      primary: assColor(t.captions.activeColor), secondary: assColor(t.captions.idleColor), outline: assColor(t.captions.outlineColor),
    }));
  }

  // ---------- video graph
  const f: string[] = [];
  if (useBgLoop) f.push(`[${iBg}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=rgba[bg0]`);
  else f.push(`[${iBg}:v]rotate=t*0.10:ow=${W}:oh=${H}:c=black,scale=w=${W}*(1.02+0.02*sin(t*1.3)):h=${H}*(1.02+0.02*sin(t*1.3)):eval=frame,crop=${W}:${H},fps=${fps},format=rgba[bg0]`);
  f.push(`[bg0]drawbox=x=${cx - fw + so}:y=${cy - fw + so}:w=${cw + 2 * fw}:h=${ch + 2 * fw}:color=${t.colors.black}@0.85:t=fill[bg1]`);
  const padClip = outro > 0 ? `,tpad=stop_mode=clone:stop_duration=${outro}` : '';
  f.push(`[${iClip}:v]scale=${cw}:${ch}:flags=lanczos,setsar=1,fps=${fps}${padClip}[clip]`);
  f.push(`[bg1][clip]overlay=x=${cx}:y=${cy}:shortest=0[v1]`);
  f.push(`[v1]drawbox=x=${cx - fw}:y=${cy - fw}:w=${cw + 2 * fw}:h=${ch + 2 * fw}:color=${t.colors.yellow}:t=${fw}[v2]`);

  // headline box + text
  const lines = wrapText(job.headline, t.headline.maxCharsPerLine, t.headline.maxLines);
  const fsz = t.headline.fontSizes[Math.min(lines.length, t.headline.fontSizes.length) - 1];
  f.push(`[${iBox}:v]scale=${t.headline.boxWidth}:-1[hbox]`);
  f.push(`[v2][hbox]overlay=x=${t.headline.x}:y=${t.headline.y}[v3]`);
  const boxH = Math.round(t.headline.boxWidth * 0.34);
  const lineH = Math.round(fsz * 1.02);
  const textTop = t.headline.y + Math.round((boxH - lines.length * lineH) / 2);
  let cur = 'v3';
  lines.forEach((line, i) => {
    const nxt = `h${i}`;
    f.push(`[${cur}]drawtext=fontfile='${esc(font)}':text='${escapeDrawtext(line)}':fontsize=${fsz}:fontcolor=${t.headline.fill}:borderw=${t.headline.outlineWidth}:bordercolor=${t.headline.outline}:x=(w-text_w)/2:y=${textTop + i * lineH}[${nxt}]`);
    cur = nxt;
  });

  // captions
  if (assFile) {
    f.push(`[${cur}]ass='${esc(assFile)}':fontsdir='${esc(fontsDir)}'[cap]`);
    cur = 'cap';
  }

  // commentary text (shown while VO plays)
  const cLines = wrapText(job.commentary, t.commentary.maxCharsPerLine, t.commentary.maxLines ?? 3);
  const enable = outro > 0 ? `gte(t,${clipDur.toFixed(2)})` : `lt(t,${Math.min(clipDur, 3.5).toFixed(2)})`;
  cLines.forEach((line, i) => {
    const nxt = `c${i}`;
    f.push(`[${cur}]drawtext=fontfile='${esc(font)}':text='${escapeDrawtext(line)}':fontsize=${t.commentary.fontSize}:fontcolor=${t.commentary.textColor}:box=1:boxcolor=${t.commentary.boxColor}:boxborderw=14:x=(w-text_w)/2-120:y=${t.commentary.y + i * Math.round(t.commentary.fontSize * 1.25)}:enable='${enable}'[${nxt}]`);
    cur = nxt;
  });

  // watermark
  f.push(`[${iLogo}:v]scale=${t.watermark.logoWidth}:-1[logo]`);
  f.push(`[${cur}][logo]overlay=x=${t.watermark.x}:y=${t.watermark.y}[wm0]`);
  f.push(`[wm0]drawtext=fontfile='${esc(font)}':text='${escapeDrawtext(t.handle)}':fontsize=${t.watermark.fontSize}:fontcolor=${t.colors.white}:borderw=4:bordercolor=${t.colors.black}:x=${t.watermark.x + t.watermark.logoWidth + 14}:y=${t.watermark.y + Math.round(t.watermark.logoWidth / 2 - t.watermark.fontSize / 2)}[wm]`);

  // mascot (bobbing); optional "shout" pose while the commentary plays
  f.push(`[${iMascot}:v]scale=${t.mascot.width}:-1[masc]`);
  if (iShout >= 0) {
    const shoutEnable = outro > 0 ? `gte(t,${clipDur.toFixed(2)})` : `lt(t,${Math.min(clipDur, 3.5).toFixed(2)})`;
    f.push(`[${iShout}:v]scale=${t.mascot.width}:-1[shout]`);
    f.push(`[wm][masc]overlay=x=W-w-${t.mascot.right}:y=H-h-${t.mascot.bottom}+${t.mascot.bobAmplitude}*sin(t*${t.mascot.bobSpeed}):eval=frame:enable='not(${shoutEnable})'[m1]`);
    f.push(`[m1][shout]overlay=x=W-w-${t.mascot.right}:y=H-h-${t.mascot.bottom}+${t.mascot.bobAmplitude * 1.6}*sin(t*${t.mascot.bobSpeed * 2.5}):eval=frame:enable='${shoutEnable}':format=auto,format=yuv420p[vout]`);
  } else {
    f.push(`[wm][masc]overlay=x=W-w-${t.mascot.right}:y=H-h-${t.mascot.bottom}+${t.mascot.bobAmplitude}*sin(t*${t.mascot.bobSpeed}):eval=frame:format=auto,format=yuv420p[vout]`);
  }

  // ---------- audio graph
  const aParts: string[] = [];
  const mixIn: string[] = [];
  if (probe.hasAudio) {
    aParts.push(`[${iClip}:a]aresample=48000,apad=pad_dur=${outro}[ca]`);
    mixIn.push('[ca]');
  } else {
    aParts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(2)}[ca]`);
    mixIn.push('[ca]');
  }
  if (iVo >= 0) {
    const delayMs = Math.round((outro > 0 ? clipDur + 0.15 : 0.3) * 1000);
    aParts.push(`[${iVo}:a]aresample=48000,volume=${t.audio.voVolume},adelay=${delayMs}:all=1[vo]`);
    mixIn.push('[vo]');
  }
  if (iMusic >= 0) {
    aParts.push(`[${iMusic}:a]aresample=48000,volume=${t.audio.musicVolume},atrim=0:${total.toFixed(2)}[mus]`);
    mixIn.push('[mus]');
  }
  aParts.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:duration=longest:normalize=0,loudnorm=${t.audio.loudnorm},alimiter=limit=0.95[aout]`);
  f.push(...aParts);

  const filterFile = path.join(job.workDir, 'filter.txt');
  fs.writeFileSync(filterFile, f.join(';\n'));

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-stats_period', '5',
    ...inputs,
    '-filter_complex_script', filterFile,
    '-map', '[vout]', '-map', '[aout]',
    '-t', total.toFixed(2),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-movflags', '+faststart',
    job.outPath,
  ];
  log.info(`ffmpeg render -> ${path.basename(job.outPath)} (${total.toFixed(1)}s, clip ${cw}x${ch} at ${cx},${cy})`);
  await run('ffmpeg', args);

  const thumbnailPath = job.outPath.replace(/\.mp4$/, '.jpg');
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', Math.min(1.0, clipDur / 2).toFixed(2), '-i', job.outPath, '-frames:v', '1', '-q:v', '3', thumbnailPath]);
  const out = await ffprobe(job.outPath);
  if (out.width !== W || out.height !== H) throw new Error(`render produced ${out.width}x${out.height}, expected ${W}x${H}`);
  return { outPath: job.outPath, durationSec: out.duration, thumbnailPath, command: ['ffmpeg', ...args] };
}

const even = (n: number) => (n % 2 ? n - 1 : n);
const esc = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
function fontFamilyName(file: string): string {
  const b = path.basename(file).replace(/\.(ttf|otf|woff2?)$/i, '');
  return b.replace(/-?(Regular|Bold|Italic|Medium)$/i, '');
}
