import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { phashFrame, type Candidate } from '@toaster/shared';
import { log } from '../config.js';

const execFileP = promisify(execFile);

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
    case 'youtube': return downloadWithYtDlp(c.source_url, out);
    default:
      if (!c.media_url) throw new Error('no media_url');
      await fetchToFile(c.media_url, out);
      return out;
  }
}

async function downloadReddit(c: Candidate, out: string): Promise<string> {
  if (!c.media_url) throw new Error('reddit candidate without fallback_url');
  const videoUrl = c.media_url.split('?')[0];
  const baseUrl = videoUrl.replace(/\/[^/]+$/, '');
  const v = out.replace(/\.mp4$/, '.v.mp4');
  // Always take the highest DASH rendition Reddit has; fallback_url is not always the best one.
  let got = false;
  for (const name of ['DASH_1080.mp4', 'DASH_720.mp4']) {
    if (videoUrl.endsWith('/' + name)) break;
    try {
      await fetchToFile(`${baseUrl}/${name}`, v, { 'user-agent': 'unhinged-toaster/0.1' });
      if (fs.statSync(v).size > 50_000) { got = true; log.info(`reddit: using ${name}`); break; }
    } catch { /* rendition not available */ }
  }
  if (!got) await fetchToFile(videoUrl, v, { 'user-agent': 'unhinged-toaster/0.1' });
  let a: string | null = null;
  for (const name of ['DASH_AUDIO_128.mp4', 'DASH_AUDIO_64.mp4', 'DASH_audio.mp4', 'audio']) {
    const target = out.replace(/\.mp4$/, '.a.mp4');
    try {
      await fetchToFile(`${baseUrl}/${name}`, target, { 'user-agent': 'unhinged-toaster/0.1' });
      if (fs.statSync(target).size > 1000) { a = target; break; }
    } catch { /* try next */ }
  }
  if (a) await run('ffmpeg', ['-y', '-v', 'error', '-i', v, '-i', a, '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-shortest', out]);
  else await run('ffmpeg', ['-y', '-v', 'error', '-i', v, '-c', 'copy', out]);
  return out;
}

async function downloadWithYtDlp(url: string, out: string): Promise<string> {
  try {
    await execFileP('yt-dlp', ['--version']);
  } catch {
    throw new Error('yt-dlp is not installed (pip install yt-dlp). YouTube CC-BY clips cannot be fetched without it.');
  }
  // best video up to 4K (we downscale cleanly), best audio; never a pre-muxed low-quality stream unless nothing else exists
  await run('yt-dlp', ['-f', 'bv*[height<=2160][ext=mp4]+ba[ext=m4a]/bv*[height<=2160]+ba/b[ext=mp4]/b', '--merge-output-format', 'mp4', '--no-playlist', '-o', out, url]);
  return out;
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
