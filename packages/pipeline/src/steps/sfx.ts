import fs from 'node:fs';
import path from 'node:path';
import type { EditBeats } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { assertOpen, fetchWithTimeout, recordFailure, recordSuccess, TIMEOUTS } from '../guard.js';
import { run } from './media.js';

/**
 * Comedic sound effects. A small named library lives in assets/sfx (manifest.json lists file + license); effects are
 * attached to REAL moments of the edited timeline (the detected peak, the freeze, the replay, ranking cuts, the #1
 * reveal), never sprinkled at fixed intervals. Missing library files can be created once by:
 *   - 'elevenlabs': the already-connected ElevenLabs sound-generation endpoint (200 credits per effect, within the
 *     free tier for a 12-sound library) — only when SFX_PROVIDER=elevenlabs is set on purpose;
 *   - 'synth': ffmpeg-synthesised placeholders (free, for tests and offline runs).
 */
export const SFX_LIBRARY: { name: string; prompt: string; seconds: number }[] = [
  { name: 'boing', prompt: 'cartoon spring boing, short, comedic', seconds: 0.8 },
  { name: 'thud', prompt: 'soft comedic body thud on carpet, short', seconds: 0.6 },
  { name: 'slip', prompt: 'cartoon slip and slide whistle, short', seconds: 0.9 },
  { name: 'record_scratch', prompt: 'vinyl record scratch stop, short', seconds: 0.7 },
  { name: 'whoosh', prompt: 'quick cinematic whoosh transition, short', seconds: 0.5 },
  { name: 'victory', prompt: 'tiny triumphant fanfare, 8-bit style, short', seconds: 1.2 },
  { name: 'sting', prompt: 'dramatic suspense sting, short', seconds: 1.0 },
  { name: 'pop', prompt: 'cartoon pop, very short', seconds: 0.3 },
  { name: 'squeak', prompt: 'dog toy squeak, short', seconds: 0.5 },
  { name: 'ding', prompt: 'bright bell ding, short', seconds: 0.6 },
];

export interface SfxEntry { name: string; file: string; license: string; source: string }

/** Real library: assets/sfx (committed, licensed). Synth placeholders: <workDir>/sfx, never inside assets/, so they cannot ship by accident. */
export function sfxDir(cfg: Config, provider: 'synth' | 'elevenlabs' | 'library' = 'library'): string {
  return provider === 'synth' ? path.join(cfg.workDir ?? 'work', 'sfx') : path.join(cfg.assetsDir, 'sfx');
}

function readManifest(dir: string): SfxEntry[] {
  const f = path.join(dir, 'manifest.json');
  if (!fs.existsSync(f)) return [];
  try { return ((JSON.parse(fs.readFileSync(f, 'utf8')) as { effects?: SfxEntry[] }).effects ?? []).filter((e) => e.license && fs.existsSync(path.join(dir, e.file))); } catch { return []; }
}

/** Licensed library first; synth placeholders only when SFX_PROVIDER=synth was chosen on purpose (tests, mock runs). */
export function loadSfxManifest(cfg: Config): (SfxEntry & { dir: string })[] {
  const lib = readManifest(sfxDir(cfg, 'library')).map((e) => ({ ...e, dir: sfxDir(cfg, 'library') }));
  if (lib.length || process.env.SFX_PROVIDER !== 'synth') return lib;
  return readManifest(sfxDir(cfg, 'synth')).map((e) => ({ ...e, dir: sfxDir(cfg, 'synth') }));
}

export function sfxPath(cfg: Config, name: string): string | null {
  const e = loadSfxManifest(cfg).find((x) => x.name === name);
  return e ? path.join(e.dir, e.file) : null;
}

/** Create any library sound that is missing. provider 'synth' is free (placeholders in the work dir); 'elevenlabs' spends credits and writes the real library into assets/sfx. */
export async function ensureSfxLibrary(cfg: Config, provider: 'synth' | 'elevenlabs'): Promise<{ created: number; present: number }> {
  const dir = sfxDir(cfg, provider);
  fs.mkdirSync(dir, { recursive: true });
  const manifestFile = path.join(dir, 'manifest.json');
  const effects: SfxEntry[] = readManifest(dir);
  let created = 0;
  for (const sfx of SFX_LIBRARY) {
    if (effects.some((e) => e.name === sfx.name)) continue;
    const file = `${sfx.name}.mp3`;
    const out = path.join(dir, file);
    if (provider === 'elevenlabs') {
      await elevenLabsSfx(cfg, sfx.prompt, sfx.seconds, out);
      effects.push({ name: sfx.name, file, license: 'ElevenLabs sound-generation output (account terms); generated for this channel', source: 'elevenlabs:sound-generation' });
    } else {
      await synthSfx(sfx.name, sfx.seconds, out);
      effects.push({ name: sfx.name, file, license: 'synthesised placeholder (ffmpeg); replace before launch', source: 'synth' });
    }
    created++;
  }
  fs.writeFileSync(manifestFile, JSON.stringify({ _comment: 'Only effects listed here with a license are mixed into videos.', effects }, null, 2));
  return { created, present: effects.length };
}

async function elevenLabsSfx(cfg: Config, text: string, seconds: number, out: string): Promise<void> {
  assertOpen('elevenlabs');
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'audio/mpeg' };
  if (cfg.elevenKey) headers['xi-api-key'] = cfg.elevenKey;
  const res = await fetchWithTimeout('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', {
    method: 'POST', headers, body: JSON.stringify({ text, duration_seconds: seconds, prompt_influence: 0.5 }),
  }, TIMEOUTS.ttsMs, 'ElevenLabs sound-generation');
  if (!res.ok) { const body = (await res.text()).slice(0, 200); const fatal = recordFailure('elevenlabs', res.status, body); throw fatal ?? new Error(`elevenlabs sound-generation ${res.status}: ${body}`); }
  recordSuccess('elevenlabs');
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

/** Free placeholder sounds so the mixing path can be exercised without any credits. */
async function synthSfx(name: string, seconds: number, out: string): Promise<void> {
  const d = seconds.toFixed(2);
  const recipes: Record<string, string> = {
    boing: `sine=frequency=220:duration=${d},vibrato=f=12:d=0.8,afade=t=out:st=0:d=${d}`,
    thud: `sine=frequency=70:duration=${d},afade=t=out:st=0:d=${d}`,
    slip: `sine=frequency=1200:duration=${d},vibrato=f=6:d=0.9,afade=t=out:st=0:d=${d}`,
    record_scratch: `anoisesrc=color=pink:duration=${d}:amplitude=0.5,afade=t=out:st=0:d=${d}`,
    whoosh: `anoisesrc=color=white:duration=${d}:amplitude=0.3,afade=t=in:st=0:d=0.2,afade=t=out:st=0.2:d=0.3`,
    victory: `sine=frequency=660:duration=${d},tremolo=f=8:d=0.6,afade=t=out:st=0.6:d=0.6`,
    sting: `sine=frequency=110:duration=${d},tremolo=f=5:d=0.5,afade=t=out:st=0.4:d=0.6`,
    pop: `sine=frequency=900:duration=${d},afade=t=out:st=0:d=${d}`,
    squeak: `sine=frequency=1500:duration=${d},vibrato=f=20:d=0.5,afade=t=out:st=0:d=${d}`,
    ding: `sine=frequency=1760:duration=${d},afade=t=out:st=0:d=${d}`,
  };
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', recipes[name] ?? `sine=frequency=440:duration=${d}`, '-ac', '2', '-ar', '44100', '-b:a', '96k', out]);
}

/**
 * Where effects go on the EDITED timeline for a single-clip Short: slip/thud at the peak (or its freeze), a record
 * scratch when the freeze lands, a whoosh when the replay starts. Rankings add their own cue list.
 */
export function planSfx(cfg: Config, beats: EditBeats, map: (t: number) => number, opts: { category?: string | null } = {}): { path: string; at: number; gain?: number }[] {
  const cues: { name: string; at: number; gain?: number }[] = [];
  if (beats.freeze) { cues.push({ name: 'record_scratch', at: map(beats.freeze.at), gain: 0.8 }); }
  if (beats.punchIn) { cues.push({ name: opts.category === 'funny_animals' ? 'boing' : 'thud', at: map(beats.punchIn.at) + 0.05, gain: 0.9 }); }
  if (beats.replay) { cues.push({ name: 'whoosh', at: map(beats.replay.from) - 0.1, gain: 0.7 }); }
  const out: { path: string; at: number; gain?: number }[] = [];
  for (const c of cues) { const p = sfxPath(cfg, c.name); if (p && c.at >= 0) out.push({ path: p, at: Math.max(0, c.at), gain: c.gain }); }
  if (cues.length && !out.length) log.info('sfx: library missing; no effects mixed (run ensureSfxLibrary)');
  return out;
}
