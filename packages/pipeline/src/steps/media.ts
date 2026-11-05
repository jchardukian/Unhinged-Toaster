import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { phashFrame, type Candidate } from '@toaster/shared';
import { log } from '../config.js';

const execFileP = promisify(execFile);
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface Probe { duration: number; width: number; height: number; hasAudio: boolean; fps: number }

export async function ffprobe(file: string): Promise<Probe> {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { maxBuffer: 10 << 20 });
  const j = JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string; duration?: string; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }[]; format: { duration?: string } };
  const v = j.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error(`no video stream in ${file}`);
  const [n, d] = (v.r_frame_rate ?? '30/1').split('/').map(Number);
  const rotation = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.[0]?.rotation ?? 0)) % 180;
  const w = v.width ?? 0, h = v.height ?? 0;
  return {
    duration: Number(j.format.duration ?? v.duration ?? 0),
    width: rotation === 90 ? h : w,
    height: rotation === 90 ? w : h,
    hasAudio: j.streams.some((s) => s.codec_type === 'audio'),
    fps: d ? n / d : 30,
  };
}

/** Duration of any media file (audio-only included), from the container. */
export async function mediaDuration(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    const d = Number(stdout.trim());
    return Number.isFinite(d) ? d : null;
  } catch { return null; }
}

export function run(cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean } = {}): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ code: 0, stderr });
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

/** 5 evenly spaced 32x32 grayscale frames -> "h1:h2:h3:h4:h5" */
export async function videoPhash(file: string, frames = 5): Promise<string> {
  const probe = await ffprobe(file);
  const step = Math.max(0.2, probe.duration / (frames + 1));
  const hashes: string[] = [];
  for (let i = 1; i <= frames; i++) {
    const t = Math.min(probe.duration - 0.05, step * i);
    const { stdout } = await execFileP('ffmpeg', ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=32:32:flags=area,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 20 });
    if (stdout.length >= 1024) hashes.push(phashFrame(new Uint8Array(stdout.subarray(0, 1024))));
  }
  if (hashes.length === 0) throw new Error('could not extract frames for phash');
  return hashes.join(':');
}

/** Download the candidate's media into workDir. Returns the local mp4 path. */
export async function downloadMedia(c: Candidate, dir: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${c.id}.source.mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 10_000) return out;
  switch (c.source_platform) {
    case 'reddit': return downloadReddit(c, out);
    case 'youtube': return downloadWithYtDlp(c.source_url, out, { youtube: true });
    case 'tiktok': return downloadWithYtDlp(c.source_url, out, {});
    default:
      if (!c.media_url) throw new Error('no media_url');
      await fetchToFile(c.media_url, out);
      return out;
  }
}

async function downloadReddit(c: Candidate, out: string): Promise<string> {
  if (!c.media_url) throw new Error('reddit candidate without media url');
  const baseUrl = c.media_url.split('?')[0].replace(/\/[^/]+$/, ''); // https://v.redd.it/<id>
  const v = out.replace(/\.mp4$/, '.v.mp4');
  const a = out.replace(/\.mp4$/, '.a.mp4');
  // Reddit publishes a DASH manifest listing the real rendition files (CMAF_1080.mp4, DASH_720.mp4, ...). Parse it and
  // take the highest video + audio instead of guessing names; direct guesses fall back when the manifest is unavailable.
  const renditions = await redditRenditions(baseUrl).catch(() => null);
  let videoName: string | null = null;
  let audioName: string | null = null;
  if (renditions) {
    videoName = renditions.video[0]?.file ?? null;
    audioName = renditions.audio[0] ?? null;
    if (renditions.video[0]) log.info(`reddit: manifest offers ${renditions.video.map((r) => `${r.width}x${r.height}`).join(', ')} -> using ${videoName}`);
  }
  const videoCandidates = [videoName, 'CMAF_1080.mp4', 'DASH_1080.mp4', 'CMAF_720.mp4', 'DASH_720.mp4', c.media_url.split('?')[0].split('/').pop()].filter((x): x is string => !!x);
  let gotVideo = false;
  for (const name of [...new Set(videoCandidates)]) {
    try {
      await fetchToFile(`${baseUrl}/${name}`, v, { 'user-agent': BROWSER_UA, referer: 'https://www.reddit.com/' });
      if (fs.statSync(v).size > 50_000) { gotVideo = true; break; }
    } catch { /* next */ }
  }
  if (!gotVideo) throw new Error('reddit: no downloadable video rendition');
  let gotAudio = false;
  for (const name of [...new Set([audioName, 'CMAF_AUDIO_128.mp4', 'DASH_AUDIO_128.mp4', 'CMAF_AUDIO_64.mp4', 'DASH_AUDIO_64.mp4', 'DASH_audio.mp4'].filter((x): x is string => !!x))]) {
    try {
      await fetchToFile(`${baseUrl}/${name}`, a, { 'user-agent': BROWSER_UA, referer: 'https://www.reddit.com/' });
      if (fs.statSync(a).size > 1000) { gotAudio = true; break; }
    } catch { /* next */ }
  }
  if (gotAudio) await run('ffmpeg', ['-y', '-v', 'error', '-i', v, '-i', a, '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-shortest', out]);
  else await run('ffmpeg', ['-y', '-v', 'error', '-i', v, '-c', 'copy', out]);
  return out;
}

/** Parse v.redd.it DASHPlaylist.mpd: video renditions (best first) and audio files (best first). */
export async function redditRenditions(baseUrl: string): Promise<{ video: { file: string; width: number; height: number; bandwidth: number }[]; audio: string[] }> {
  const res = await fetch(`${baseUrl}/DASHPlaylist.mpd`, { headers: { 'user-agent': BROWSER_UA, referer: 'https://www.reddit.com/' } });
  if (!res.ok) throw new Error(`mpd ${res.status}`);
  return parseRedditMpd(await res.text());
}

export function parseRedditMpd(xml: string): { video: { file: string; width: number; height: number; bandwidth: number }[]; audio: string[] } {
  const video: { file: string; width: number; height: number; bandwidth: number }[] = [];
  const audio: { file: string; bandwidth: number }[] = [];
  const repRe = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g;
  let m: RegExpExecArray | null;
  while ((m = repRe.exec(xml))) {
    const attrs = m[1];
    const file = m[2].match(/<BaseURL>([^<]+)<\/BaseURL>/)?.[1];
    if (!file) continue;
    const width = Number(attrs.match(/width="(\d+)"/)?.[1] ?? 0);
    const height = Number(attrs.match(/height="(\d+)"/)?.[1] ?? 0);
    const bandwidth = Number(attrs.match(/bandwidth="(\d+)"/)?.[1] ?? 0);
    if (width && height) video.push({ file, width, height, bandwidth });
    else audio.push({ file, bandwidth });
  }
  video.sort((x, y) => y.height * y.width - x.height * x.width || y.bandwidth - x.bandwidth);
  audio.sort((x, y) => y.bandwidth - x.bandwidth);
  return { video, audio: audio.map((x) => x.file) };
}

/**
 * yt-dlp download (TikTok, YouTube). Best video up to 4K + best audio, merged to mp4.
 * YouTube from datacenter IPs often needs an alternate player client or the owner's exported cookies
 * (YTDLP_COOKIES_B64 = base64 of a Netscape cookies.txt); both are applied when configured.
 */
export async function downloadWithYtDlp(url: string, out: string, opts: { youtube?: boolean }): Promise<string> {
  try { await execFileP('yt-dlp', ['--version']); } catch { throw new Error('yt-dlp is not installed (pip install yt-dlp)'); }
  const args = ['--no-warnings', '--no-playlist', '-f', 'bv*[height<=2160][ext=mp4]+ba[ext=m4a]/bv*[height<=2160]+ba/b[ext=mp4]/b', '--merge-output-format', 'mp4', '-o', out];
  for (const a of ytdlpCommonArgs(opts.youtube ?? false)) args.push(a);
  args.push(url);
  await run('yt-dlp', args);
  return out;
}

/**
 * Flags shared by every yt-dlp call.
 * - cookies: YTDLP_COOKIES_B64 (base64 Netscape cookies.txt) when the owner exported them.
 * - JS runtime: YouTube now requires solving a JavaScript "n" challenge for the media URLs; yt-dlp only auto-detects
 *   deno, so the Node binary running this pipeline is registered (needs the `yt-dlp-ejs` solver: `pip install "yt-dlp[default]"`).
 * - player client: yt-dlp's default client set is used unless YTDLP_YOUTUBE_CLIENTS overrides it. (From a datacenter
 *   IP the default set returned metadata + 1080p formats where ios/web/tv were bot-walled.)
 */
export function ytdlpCommonArgs(youtube: boolean, env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  const cookies = env.YTDLP_COOKIES_B64;
  if (cookies) {
    const file = path.join(os.tmpdir(), 'toaster-cookies.txt');
    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(cookies, 'base64'));
    args.push('--cookies', file);
  }
  if (youtube) {
    const runtime = env.YTDLP_JS_RUNTIME ?? `node:${process.execPath}`;
    if (runtime && runtime !== 'none') args.push('--js-runtimes', runtime);
    if (env.YTDLP_YOUTUBE_CLIENTS) args.push('--extractor-args', `youtube:player_client=${env.YTDLP_YOUTUBE_CLIENTS}`);
    args.push('--extractor-args', 'youtubetab:approximate_date'); // upload dates in flat listings (search / hashtag shelves)
  }
  return args;
}

/** Metadata-only yt-dlp call (flat playlist for channel/user pages, or full info for a search/video). Several targets run in one process. */
export async function ytdlpJson(target: string | string[], opts: { flat?: boolean; limit?: number; youtube?: boolean }): Promise<Record<string, unknown>[]> {
  const args = ['--no-warnings', '--skip-download', '--dump-json', '--ignore-errors'];
  if (opts.flat) args.push('--flat-playlist');
  if (opts.limit) args.push('--playlist-end', String(opts.limit));
  for (const a of ytdlpCommonArgs(opts.youtube ?? false)) args.push(a);
  args.push(...(Array.isArray(target) ? target : [target]));
  const { stdout } = await execFileP('yt-dlp', args, { maxBuffer: 64 << 20 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
  return String(stdout).split('\n').filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((x): x is Record<string, unknown> => !!x);
}

export async function fetchToFile(url: string, file: string, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  log.info(`downloaded ${path.basename(file)} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

/** Extract mono 16 kHz mp3 for transcription. Returns null when the clip has no audio. */
export async function extractAudio(video: string, out: string): Promise<string | null> {
  const p = await ffprobe(video);
  if (!p.hasAudio) return null;
  await run('ffmpeg', ['-y', '-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out]);
  return out;
}
