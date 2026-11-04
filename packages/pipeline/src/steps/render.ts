import fs from 'node:fs';
import path from 'node:path';
import { escapeDrawtext, planEdit, wrapText, type CommentaryMode, type EditTimeline } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { assColor, buildAss, maskProfanity, muteWindows, type Word } from './captions.js';
import { ffprobe, mediaDuration, run } from './media.js';

export interface Template {
  canvas: { width: number; height: number; fps: number };
  colors: Record<string, string>;
  font: string;
  assets: Record<string, string>;
  handle: string;
  headline: { style?: 'text' | 'box'; x: number; y: number; textTop?: number; coverTextTop?: number; boxWidth: number; coverBoxWidth?: number; coverY?: number; maxCharsPerLine: number; maxLines: number; fontSizes: number[]; fill: string; accentFill?: string; outline: string; outlineWidth: number; glow?: string; glowWidth?: number; sideMargin?: number; scaleX?: number; spacing?: number; assSizeFactor?: number };
  clip: { maxWidth: number; maxHeight: number; coverIfTallerThan?: number; landscapeCenterY?: number; minTop?: number; frameWidth: number; shadowOffset: number };
  captions: { fontSize: number; bottomPadding: number; coverMarginV?: number; activeColor: string; idleColor: string; outlineColor: string };
  mascot: { width: number; coverWidth?: number; right: number; bottom: number; bobAmplitude: number; bobSpeed: number };
  watermark: { logoWidth: number; x: number; y: number; fontSize: number; wordmarkWidth?: number; wordmarkBottom?: number };
  commentary: { position: 'outro' | 'intro'; introDelay?: number; duckVolume?: number; outroSeconds: number; fontSize: number; boxColor: string; textColor: string; y: number; maxCharsPerLine: number; maxLines?: number };
  audio: { musicVolume: number; musicDuck?: number; voVolume: number; loudnorm: string };
  limits: { maxDurationSec: number };
}

export interface RenderJob {
  clipPath: string;
  headline: string;
  commentary: string;
  commentaryMode?: CommentaryMode; // default outro_voice; 'none' = no outro at all (the clip's own sound carries the ending)
  voPath: string | null;          // mp3 of the commentary (optional)
  words: Word[] | null;           // transcript words for captions (optional, source time)
  musicPath: string | null;
  outPath: string;
  workDir: string;
  timeline?: EditTimeline;        // clip-specific comedic edit plan (optional: plain template when absent)
}

export interface RenderResult { outPath: string; durationSec: number; thumbnailPath: string; command: string[]; editedClipSec: number }

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
 * Clip chain (comedic edit): [A] -> freeze-frame + text -> [B with punch-in zoom at the peak] -> slow-mo replay -> outro freeze.
 * Layers (bottom -> top): animated background, clip shadow, edited clip, yellow frame, headline box + text,
 * captions (ASS, remapped to the edited timeline), reaction sticker, commentary box (outro), watermark, mascot.
 */
export async function renderShort(cfg: Config, t: Template, job: RenderJob): Promise<RenderResult> {
  const probe = await ffprobe(job.clipPath);
  const W = t.canvas.width, H = t.canvas.height, fps = t.canvas.fps;
  const mode: CommentaryMode = job.commentaryMode ?? 'outro_voice';
  const useVo = mode === 'outro_voice' && !!job.voPath;
  const voDur = useVo ? (await mediaDuration(job.voPath!)) ?? 3.0 : 0;
  const intro = t.commentary.position === 'intro' && mode !== 'none';
  // outro only when the commentary is placed at the end; always long enough for the whole sentence
  const outro = !intro && mode !== 'none' ? Math.max(t.commentary.outroSeconds, useVo ? voDur + 0.5 : 0) : 0;
  const introStart = t.commentary.introDelay ?? 0.35;
  const introEnd = intro ? introStart + (useVo ? voDur : 3.0) + 0.2 : 0;
  const maxClip = t.limits.maxDurationSec - outro;
  const srcDur = Math.min(probe.duration, maxClip);
  const tl: EditTimeline = job.timeline ?? planEdit({ sourceDuration: srcDur, peak: null, maxTotal: maxClip, style: 'light' });
  const b = tl.beats;
  const D = Math.min(srcDur, tl.sourceDuration);
  const editedDur = tl.editedDuration;
  const total = editedDur + outro;

  // Layout: the footage owns the screen and is NEVER cropped. Tall sources are fitted to the full canvas (a 9:16
  // source fills it exactly; 4:5 / 3:4 sources get the burst background above and below) with branding overlapping;
  // landscape/square sources run full-width in the upper-middle with the headline above and captions below.
  const containScale = Math.min(W / probe.width, H / probe.height);
  const cover = probe.height * containScale >= (t.clip.coverIfTallerThan ?? 1440);
  const sharpen = containScale > 1.15 ? ',unsharp=5:5:0.6:5:5:0.0' : '';
  let cw: number, ch: number, cx: number, cy: number, preScale = '';
  if (cover) {
    cw = even(Math.floor(probe.width * containScale));
    ch = even(Math.floor(probe.height * containScale));
    cx = Math.round((W - cw) / 2);
    cy = Math.round((H - ch) / 2);
    preScale = `scale=${cw}:${ch}:flags=lanczos${sharpen}`;
  } else {
    const sc = Math.min(t.clip.maxWidth / probe.width, t.clip.maxHeight / probe.height);
    cw = even(Math.floor(probe.width * sc));
    ch = even(Math.floor(probe.height * sc));
    cx = Math.round((W - cw) / 2);
    const minTop = t.clip.minTop ?? 440;
    const centerY = t.clip.landscapeCenterY ?? 900;
    cy = Math.max(minTop, Math.min(H - ch - 380, Math.round(centerY - ch / 2)));
    preScale = `scale=${cw}:${ch}:flags=lanczos${sharpen}`;
  }
  const fw = cover ? 0 : t.clip.frameWidth, so = t.clip.shadowOffset;

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
  const iBox = (t.headline.style ?? 'text') === 'box' ? add('-loop', '1', '-i', hbox) : -1;
  const iLogo = add('-loop', '1', '-i', logo);
  const shoutPath = path.join(cfg.assetsDir, 'brand', 'mascot_shout.png');
  const iShout = fs.existsSync(shoutPath) ? add('-loop', '1', '-i', shoutPath) : -1;
  const wordmarkPath = path.join(cfg.assetsDir, 'brand', 'wordmark.png');
  const iWordmark = fs.existsSync(wordmarkPath) ? add('-loop', '1', '-i', wordmarkPath) : -1;
  const iVo = useVo ? add('-i', job.voPath!) : -1;
  const iMusic = job.musicPath ? add('-stream_loop', '-1', '-i', job.musicPath) : -1;

  // ---------- captions file (source time -> edited time; drop words inside the replay since it is a repeat)
  let assFile: string | null = null;
  if (job.words && job.words.length) {
    const words = job.words.filter((w) => w.start < D).map((w) => ({ ...w, word: maskProfanity(w.word), start: tl.map(w.start), end: tl.map(Math.min(w.end, D)) }));
    assFile = path.join(job.workDir, 'captions.ass');
    fs.writeFileSync(assFile, buildAss(words, {
      fontName: fontFamilyName(font), fontSize: t.captions.fontSize, playResX: W, playResY: H,
      marginV: cover ? Math.max(t.captions.coverMarginV ?? 470, H - (cy + ch) + t.captions.bottomPadding) : H - (cy + ch) + t.captions.bottomPadding,
      primary: assColor(t.captions.activeColor), secondary: assColor(t.captions.idleColor), outline: assColor(t.captions.outlineColor),
    }));
  }

  // ---------- video graph
  const f: string[] = [];
  if (useBgLoop) f.push(`[${iBg}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=rgba[bg0]`);
  else f.push(`[${iBg}:v]rotate=t*0.10:ow=${W}:oh=${H}:c=black,scale=w=${W}*(1.02+0.02*sin(t*1.3)):h=${H}*(1.02+0.02*sin(t*1.3)):eval=frame,crop=${W}:${H},fps=${fps},format=rgba[bg0]`);
  if (cover && cw === W && ch === H) f.push('[bg0]null[bg1]');
  else f.push(`[bg0]drawbox=x=${cx - fw + so}:y=${cy - fw + so}:w=${cw + 2 * fw}:h=${ch + 2 * fw}:color=${t.colors.black}@0.85:t=fill[bg1]`);

  // --- edited clip chain
  f.push(`[${iClip}:v]${preScale},setsar=1,fps=${fps},trim=0:${D.toFixed(3)},setpts=PTS-STARTPTS[c0]`);
  const splits = ['cB'];
  if (b.freeze) splits.unshift('cA');
  if (b.replay) splits.push('cR');
  if (splits.length > 1) f.push(`[c0]split=${splits.length}${splits.map((s) => `[${s}]`).join('')}`);
  else f.push('[c0]null[cB]');
  let mainLabel: string;
  if (b.freeze) {
    const tf = b.freeze.at;
    const freezeTxt = `drawtext=fontfile='${esc(font)}':text='${escapeDrawtext(b.freeze.text)}':fontsize=${Math.round(cw / 9)}:fontcolor=${t.colors.yellow}:borderw=10:bordercolor=${t.colors.black}:x=(w-text_w)/2:y=h*0.72-text_h/2:enable='gte(t,${tf.toFixed(3)})'`;
    f.push(`[cA]trim=0:${tf.toFixed(3)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${b.freeze.duration},${freezeTxt},setsar=1[segA]`);
    f.push(`[cB]trim=${tf.toFixed(3)}:${D.toFixed(3)},setpts=PTS-STARTPTS${punchIn(b, tf, fps, cw, ch)}[segB]`);
    f.push(`[segA][segB]concat=n=2:v=1:a=0[main]`);
    mainLabel = 'main';
  } else {
    f.push(`[cB]setpts=PTS-STARTPTS${punchIn(b, 0, fps, cw, ch)}[main]`);
    mainLabel = 'main';
  }
  if (b.replay) {
    const z = b.replay.zoom;
    const zw = even(Math.round(cw * z)), zh = even(Math.round(ch * z));
    const label = `drawtext=fontfile='${esc(font)}':text='REPLAY':fontsize=${Math.round(cw / 16)}:fontcolor=${t.colors.white}:box=1:boxcolor=${t.colors.red}:boxborderw=12:x=28:y=28`;
    f.push(`[cR]trim=${b.replay.from.toFixed(3)}:${b.replay.to.toFixed(3)},setpts=(PTS-STARTPTS)/${b.replay.speed},scale=${zw}:${zh},crop=${cw}:${ch},setsar=1,${label}[rep]`);
    f.push(`[${mainLabel}][rep]concat=n=2:v=1:a=0[edited0]`);
    mainLabel = 'edited0';
  }
  const padClip = outro > 0 ? `,tpad=stop_mode=clone:stop_duration=${outro}` : '';
  f.push(`[${mainLabel}]setpts=PTS-STARTPTS${padClip}[clip]`);

  f.push(`[bg1][clip]overlay=x=${cx}:y=${cy}:shortest=0[v1]`);
  if (cover && cw === W && ch === H) f.push('[v1]null[v2]');
  else f.push(`[v1]drawbox=x=${cx - fw}:y=${cy - fw}:w=${cw + 2 * fw}:h=${ch + 2 * fw}:color=${t.colors.yellow}:t=${fw}[v2]`);

  // headline: brush-style lettering in the channel-art look (white/yellow letters, black outline, red glow), no box
  const lines = wrapText(job.headline, t.headline.maxCharsPerLine, t.headline.maxLines);
  let cur = 'v2';
  if ((t.headline.style ?? 'text') === 'box') {
    const hboxW = cover ? (t.headline.coverBoxWidth ?? 900) : t.headline.boxWidth;
    const hboxX = Math.round((W - hboxW) / 2);
    const hboxY = cover ? (t.headline.coverY ?? 40) : t.headline.y;
    const hScale = hboxW / t.headline.boxWidth;
    const fsz = Math.round(t.headline.fontSizes[Math.min(lines.length, t.headline.fontSizes.length) - 1] * hScale);
    f.push(`[${iBox}:v]scale=${hboxW}:-1[hbox]`);
    f.push(`[v2][hbox]overlay=x=${hboxX}:y=${hboxY}[v3]`);
    cur = 'v3';
    const boxH = Math.round(hboxW * 0.34);
    const lineH = Math.round(fsz * 1.02);
    const textTop = hboxY + Math.round((boxH - lines.length * lineH) / 2);
    lines.forEach((line, i) => {
      const nxt = `h${i}`;
      f.push(`[${cur}]drawtext=fontfile='${esc(font)}':text='${escapeDrawtext(line)}':fontsize=${fsz}:fontcolor=${t.headline.fill}:borderw=${t.headline.outlineWidth}:bordercolor=${t.headline.outline}:x=(w-text_w)/2:y=${textTop + i * lineH}[${nxt}]`);
      cur = nxt;
    });
  } else {
    // libass headline: true outlines (no drawtext clipping), horizontal letter scaling for narrower, cleaner lettering,
    // red glow layer under a black-outlined white/yellow layer. Font size shrinks until the widest line fits the safe width.
    const glowW0 = t.headline.glowWidth ?? 14;
    const scaleX = (t.headline.scaleX ?? 86) / 100;
    const safeW = W - 2 * (t.headline.sideMargin ?? 70) - 2 * glowW0;
    let fsz = t.headline.fontSizes[Math.min(lines.length, t.headline.fontSizes.length) - 1];
    const widest = Math.max(...lines.map((l) => measureText(font, l, 100) * scaleX));
    if (widest > 0) fsz = Math.min(fsz, Math.floor((safeW / widest) * 100));
    const textTop = cover ? (t.headline.coverTextTop ?? 120) : (t.headline.textTop ?? 150);
    const headlineAss = path.join(job.workDir, 'headline.ass');
    // ASS font size is a line height, not an em size: scale up so the lettering matches the em-based fit above
    fs.writeFileSync(headlineAss, buildHeadlineAss(lines, {
      fontName: fontFamilyName(font), fontSize: Math.round(fsz * (t.headline.assSizeFactor ?? 1.45)), scaleX: t.headline.scaleX ?? 86, spacing: t.headline.spacing ?? 1, top: textTop, playResX: W, playResY: H,
      fill: t.headline.fill, accentFill: t.headline.accentFill ?? t.headline.fill, outline: t.headline.outline, outlineWidth: t.headline.outlineWidth,
      glow: t.headline.glow ?? t.colors.red, glowWidth: glowW0, durationSec: total,
    }));
    f.push(`[${cur}]ass='${esc(headlineAss)}':fontsdir='${esc(fontsDir)}'[hl]`);
    cur = 'hl';
  }

  // captions
  if (assFile) {
    f.push(`[${cur}]ass='${esc(assFile)}':fontsdir='${esc(fontsDir)}'[cap]`);
    cur = 'cap';
  }

  // reaction sticker at the peak (pops in with an alpha ramp), on the composite so it can overhang the frame
  if (b.sticker) {
    const ts = tl.map(b.sticker.at);
    const te = ts + b.sticker.duration;
    f.push(`[${cur}]drawtext=fontfile='${esc(font)}':text='${escapeDrawtext(b.sticker.text)}':fontsize=${Math.round(W / 7)}:fontcolor=${t.colors.yellow}:borderw=14:bordercolor=${t.colors.black}:box=1:boxcolor=${t.colors.red}@0.92:boxborderw=26:x=(w-text_w)/2:y=${Math.round(cy + ch * 0.30)}:alpha='min(1,(t-${ts.toFixed(3)})*8)':enable='between(t,${ts.toFixed(3)},${te.toFixed(3)})'[stk]`);
    cur = 'stk';
  }

  // commentary text (outro_voice / text_only); with mode 'none' the clip's own sound carries the ending
  const cLines = mode === 'none' ? [] : wrapText(job.commentary, t.commentary.maxCharsPerLine, t.commentary.maxLines ?? 3);
  const enable = intro ? `between(t,${introStart.toFixed(2)},${introEnd.toFixed(2)})` : outro > 0 ? `gte(t,${editedDur.toFixed(2)})` : `lt(t,${Math.min(editedDur, 3.5).toFixed(2)})`;
  cLines.forEach((line, i) => {
    const nxt = `c${i}`;
    f.push(`[${cur}]drawtext=fontfile='${esc(font)}':text='${escapeDrawtext(line)}':fontsize=${t.commentary.fontSize}:fontcolor=${t.commentary.textColor}:box=1:boxcolor=${t.commentary.boxColor}:boxborderw=14:x=(w-text_w)/2-120:y=${t.commentary.y + i * Math.round(t.commentary.fontSize * 1.25)}:enable='${enable}'[${nxt}]`);
    cur = nxt;
  });

  // watermark: the real wordmark when available, else round logo + handle text
  if (iWordmark >= 0) {
    const ww = t.watermark.wordmarkWidth ?? 330;
    f.push(`[${iWordmark}:v]scale=${ww}:-1[wmark]`);
    f.push(`[${cur}][wmark]overlay=x=${t.watermark.x}:y=H-h-${t.watermark.wordmarkBottom ?? 28}[wm]`);
  } else {
    f.push(`[${iLogo}:v]scale=${t.watermark.logoWidth}:-1[logo]`);
    f.push(`[${cur}][logo]overlay=x=${t.watermark.x}:y=${t.watermark.y}[wm0]`);
    f.push(`[wm0]drawtext=fontfile='${esc(font)}':text='${escapeDrawtext(t.handle)}':fontsize=${t.watermark.fontSize}:fontcolor=${t.colors.white}:borderw=4:bordercolor=${t.colors.black}:x=${t.watermark.x + t.watermark.logoWidth + 14}:y=${t.watermark.y + Math.round(t.watermark.logoWidth / 2 - t.watermark.fontSize / 2)}[wm]`);
  }

  // mascot (bobbing); optional "shout" pose while the commentary plays and at the sticker moment
  const mascotW = cover ? (t.mascot.coverWidth ?? 250) : t.mascot.width;
  f.push(`[${iMascot}:v]scale=${mascotW}:-1[masc]`);
  if (iShout >= 0) {
    const stickerWin = b.sticker ? `+between(t,${tl.map(b.sticker.at).toFixed(3)},${(tl.map(b.sticker.at) + b.sticker.duration).toFixed(3)})` : '';
    const shoutEnable = `(${mode === 'none' ? '0' : intro ? `between(t,${introStart.toFixed(2)},${introEnd.toFixed(2)})` : outro > 0 ? `gte(t,${editedDur.toFixed(2)})` : `lt(t,${Math.min(editedDur, 3.5).toFixed(2)})`}${stickerWin})`;
    f.push(`[${iShout}:v]scale=${mascotW}:-1[shout]`);
    f.push(`[wm][masc]overlay=x=W-w-${t.mascot.right}:y=H-h-${t.mascot.bottom}+${t.mascot.bobAmplitude}*sin(t*${t.mascot.bobSpeed}):eval=frame:enable='not(${shoutEnable})'[m1]`);
    f.push(`[m1][shout]overlay=x=W-w-${t.mascot.right}:y=H-h-${t.mascot.bottom}+${t.mascot.bobAmplitude * 1.6}*sin(t*${t.mascot.bobSpeed * 2.5}):eval=frame:enable='${shoutEnable}':format=auto,format=yuv420p[vout]`);
  } else {
    f.push(`[wm][masc]overlay=x=W-w-${t.mascot.right}:y=H-h-${t.mascot.bottom}+${t.mascot.bobAmplitude}*sin(t*${t.mascot.bobSpeed}):eval=frame:format=auto,format=yuv420p[vout]`);
  }

  // ---------- audio graph (mirrors the edit: freeze = silence, replay = slowed original, outro = padding)
  const aParts: string[] = [];
  const mixIn: string[] = [];
  // swear words are silenced in the source audio (captions show them masked); windows are in source time, before any edit
  const mutes = (job.words ? muteWindows(job.words) : []).filter((m) => m.from < D).map((m) => `,volume=0:enable='between(t,${m.from.toFixed(3)},${Math.min(m.to, D).toFixed(3)})'`).join('');
  if (probe.hasAudio && !b.muteSource) aParts.push(`[${iClip}:a]aresample=48000,atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS${mutes}[a0]`);
  else aParts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS[a0]`);
  const asplits = ['aB'];
  if (b.freeze) asplits.unshift('aA');
  if (b.replay) asplits.push('aR');
  if (asplits.length > 1) aParts.push(`[a0]asplit=${asplits.length}${asplits.map((s) => `[${s}]`).join('')}`);
  else aParts.push('[a0]anull[aB]');
  let amain: string;
  if (b.freeze) {
    aParts.push(`[aA]atrim=0:${b.freeze.at.toFixed(3)},asetpts=PTS-STARTPTS,apad=pad_dur=${b.freeze.duration}[aA1]`);
    aParts.push(`[aB]atrim=${b.freeze.at.toFixed(3)}:${D.toFixed(3)},asetpts=PTS-STARTPTS[aB1]`);
    aParts.push(`[aA1][aB1]concat=n=2:v=0:a=1[amain]`);
    amain = 'amain';
  } else {
    aParts.push(`[aB]asetpts=PTS-STARTPTS[amain]`);
    amain = 'amain';
  }
  if (b.replay) {
    aParts.push(`[aR]atrim=${b.replay.from.toFixed(3)}:${b.replay.to.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${b.replay.speed},volume=0.8[arep]`);
    aParts.push(`[${amain}][arep]concat=n=2:v=0:a=1[aedit]`);
    amain = 'aedit';
  }
  const duck = intro && useVo ? `,volume=${t.commentary.duckVolume ?? 0.25}:enable='between(t,${introStart.toFixed(2)},${introEnd.toFixed(2)})'` : '';
  aParts.push(`[${amain}]apad=pad_dur=${outro}${duck}[ca]`);
  mixIn.push('[ca]');
  if (iVo >= 0) {
    const delayMs = Math.round((intro ? introStart : outro > 0 ? editedDur + 0.15 : 0.3) * 1000);
    aParts.push(`[${iVo}:a]aresample=48000,volume=${t.audio.voVolume},adelay=${delayMs}:all=1[vo]`);
    mixIn.push('[vo]');
  }
  if (iMusic >= 0) {
    // light bed: fade in/out, ducked further while the toaster speaks
    const voWin = useVo ? (intro ? `between(t,${introStart.toFixed(2)},${introEnd.toFixed(2)})` : `gte(t,${editedDur.toFixed(2)})`) : null;
    const musicDuck = voWin ? `,volume=${(t.audio.musicDuck ?? 0.35).toFixed(2)}:enable='${voWin}'` : '';
    aParts.push(`[${iMusic}:a]aresample=48000,atrim=0:${total.toFixed(2)},afade=t=in:st=0:d=0.8,afade=t=out:st=${Math.max(0, total - 1.2).toFixed(2)}:d=1.2,volume=${t.audio.musicVolume}${musicDuck}[mus]`);
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
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    job.outPath,
  ];
  log.info(`ffmpeg render -> ${path.basename(job.outPath)} (${total.toFixed(1)}s = clip ${D.toFixed(1)}s + freeze ${tl.freezeDuration}s + replay ${tl.replayDuration}s + outro ${outro.toFixed(1)}s [${mode}${intro ? ' intro' : ''}${useVo ? ` vo ${voDur.toFixed(1)}s` : ''}]; ${cover ? 'full-screen' : 'full-width'} ${cw}x${ch} at ${cx},${cy}; source ${probe.width}x${probe.height}, scale x${containScale.toFixed(2)}${sharpen ? ' +sharpen' : ''})`);
  await run('ffmpeg', args);

  const thumbnailPath = job.outPath.replace(/\.mp4$/, '.jpg');
  const thumbAt = b.sticker ? tl.map(b.sticker.at) + 0.3 : Math.min(1.0, editedDur / 2);
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', Math.min(thumbAt, total - 0.1).toFixed(2), '-i', job.outPath, '-frames:v', '1', '-q:v', '3', thumbnailPath]);
  const out = await ffprobe(job.outPath);
  if (out.width !== W || out.height !== H) throw new Error(`render produced ${out.width}x${out.height}, expected ${W}x${H}`);
  if (out.duration > t.limits.maxDurationSec + 0.5) throw new Error(`render is ${out.duration.toFixed(1)}s, over the ${t.limits.maxDurationSec}s limit`);
  return { outPath: job.outPath, durationSec: out.duration, thumbnailPath, command: ['ffmpeg', ...args], editedClipSec: editedDur };
}

/** zoompan punch-in around the peak; `offset` = segment start in source time. Returns a filter suffix (",zoompan=...") or "". */
function punchIn(b: EditTimeline['beats'], offset: number, fps: number, cw: number, ch: number): string {
  if (!b.punchIn) return '';
  const p = b.punchIn;
  const n0 = Math.max(0, Math.round((p.at - offset) * fps));
  const n1 = n0 + Math.round(p.rampIn * fps);
  const n2 = n1 + Math.round(p.hold * fps);
  const n3 = n2 + Math.round(p.rampOut * fps);
  const Z = p.zoom.toFixed(3);
  const z = `if(lt(on,${n0}),1,if(lt(on,${n1}),1+(${Z}-1)*(on-${n0})/${n1 - n0},if(lt(on,${n2}),${Z},if(lt(on,${n3}),${Z}-(${Z}-1)*(on-${n2})/${n3 - n2},1))))`;
  return `,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${cw}x${ch}:fps=${fps},setsar=1`;
}

const even = (n: number) => (n % 2 ? n - 1 : n);

/** Two-layer ASS headline: glow layer (fill + outline in the glow colour) under the lettering layer (fill + black outline). */
function buildHeadlineAss(lines: string[], o: { fontName: string; fontSize: number; scaleX: number; spacing: number; top: number; playResX: number; playResY: number; fill: string; accentFill: string; outline: string; outlineWidth: number; glow: string; glowWidth: number; durationSec: number; lineHeight?: number }): string {
  const end = Math.max(1, o.durationSec + 1);
  const ts = (sec: number) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60); return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.00`; };
  const accent = assColor(o.accentFill);
  // one positioned line per row (tight, predictable line height instead of libass's font-ascent spacing)
  const lineH = Math.round(o.fontSize * (o.lineHeight ?? 0.72));
  const rows = lines.map((l, i) => ({ y: o.top + i * lineH, text: l.replace(/[{}]/g, ''), accent: i === lines.length - 1 && lines.length > 1 }));
  const events = rows.flatMap((r) => [
    `Dialogue: 0,${ts(0)},${ts(end)},Glow,,0,0,0,,{\\an8\\pos(${o.playResX / 2},${r.y})}${r.text}`,
    `Dialogue: 1,${ts(0)},${ts(end)},Head,,0,0,0,,{\\an8\\pos(${o.playResX / 2},${r.y})}${r.accent ? `{\\c${accent}}` : ''}${r.text}`,
  ]).join('\n');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${o.playResX}
PlayResY: ${o.playResY}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Glow,${o.fontName},${o.fontSize},${assColor(o.glow)},${assColor(o.glow)},${assColor(o.glow)},&H00000000,0,0,0,0,${o.scaleX},100,${o.spacing},0,1,${o.outlineWidth + o.glowWidth},0,8,40,40,${o.top},1
Style: Head,${o.fontName},${o.fontSize},${assColor(o.fill)},${assColor(o.fill)},${assColor(o.outline)},&H00000000,0,0,0,0,${o.scaleX},100,${o.spacing},0,1,${o.outlineWidth},0,8,40,40,${o.top},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}

/** Text width in px at `size`, from a per-character advance table generated for the font (falls back to 0.55 em). */
let metricsCache: { size: number; advance: Record<string, number>; default: number } | null | undefined;
function measureText(fontFile: string, text: string, size: number): number {
  if (metricsCache === undefined) {
    const mf = fontFile.replace(/\.(ttf|otf)$/i, '-metrics.json');
    metricsCache = fs.existsSync(mf) ? (JSON.parse(fs.readFileSync(mf, 'utf8')) as { size: number; advance: Record<string, number>; default: number }) : null;
  }
  if (!metricsCache) return text.length * 0.55 * size;
  let w = 0;
  for (const ch of text) w += metricsCache.advance[ch] ?? metricsCache.advance[ch.toUpperCase()] ?? metricsCache.default;
  return (w / metricsCache.size) * size;
}
const esc = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
function fontFamilyName(file: string): string {
  const b = path.basename(file).replace(/\.(ttf|otf|woff2?)$/i, '');
  return b.replace(/-?(Regular|Bold|Italic|Medium)$/i, '');
}
