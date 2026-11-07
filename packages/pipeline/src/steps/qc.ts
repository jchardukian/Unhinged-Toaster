import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HARD_BLOCK_FLAGS, languageGate, UK_SLANG, type Candidate } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { isFatal } from '../guard.js';
import { chatJson } from '../llm.js';
import { isProfane, type SpeechInfo, type Word } from './captions.js';
import { contactSheet, sheetBase64 } from './frames.js';
import { ffprobe } from './media.js';

const execFileP = promisify(execFile);

/**
 * Automated quality control of a FINISHED render, independent of the steps that produced it. Technical checks are
 * ffmpeg-only; the editorial check looks at six frames of the final file with the vision model. The verdict and every
 * check are stored on the production (qc_json / qc_score); a blocking failure rejects the video so a replacement is
 * produced. Nothing here publishes.
 */
export interface QcCheck { name: string; ok: boolean; severity: 'block' | 'warn'; detail: string }
export interface QcResult { ok: boolean; score: number | null; checks: QcCheck[]; editorial: EditorialVerdict | null; cost_note: string }
export interface EditorialVerdict { hook: number; payoff: number; entertainment: number; commentary: number; storytelling: number; editing: number; us_fit: number; works_muted: number; natural_american_english: boolean; dialogue_dependent: boolean; onscreen_text_language: string; onscreen_text_essential: boolean; cultural_context_needed: boolean; defects: string[]; brand_visible: boolean; captions_readable: boolean; rationale: string }

export const QC_LIMITS = {
  width: 1080, height: 1920, minSec: 5, maxSec: 60, maxBlackSec: 0.4, maxFreezeSec: 2.6, avDriftSec: 0.5, minLufs: -22, maxLufs: -8,
  minHook: 6, minPayoff: 6, minEntertainment: 6, minCommentary: 6, minStorytelling: 6, minEditing: 5, minUsFit: 6, captionOverlap: 0.6,
} as const;

export interface QcInput {
  file: string;                         // final mp4
  candidate: Pick<Candidate, 'id' | 'safety_flags' | 'source_url' | 'author' | 'rights_status' | 'rights_basis'>;
  headline: string; caption: string; publicText: string; hashtags: string[];
  words: Word[] | null;                 // caption words as rendered (edited timeline) when captions were burned in
  commentaryMode: 'outro_voice' | 'text_only' | 'none';
  commentary?: string;                  // the toaster's original line (judged for meaning, not just presence)
  edits?: { freeze: boolean; punchIn: boolean; replay: boolean; captions: boolean };
  /** productions for the same candidate already in the store (double production = duplicate) */
  siblingProductions: number;
  /** optional: re-transcribe the final render (caption accuracy + spoken language; Whisper, ~$0.006) */
  transcribe?: (file: string) => Promise<SpeechInfo | null>;
  /** what Whisper heard in the SOURCE before editing (preferred over the final mix, which also carries music/VO) */
  sourceSpeech?: { language: string | null; words: number; excerpt: string } | null;
  /** optional: skip the vision model (tests) */
  editorial?: boolean;
}

/** Pure: parse ffmpeg blackdetect / freezedetect / silencedetect stderr into intervals. */
export function parseIntervals(stderr: string, kind: 'black' | 'freeze' | 'silence'): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (kind === 'black') for (const m of stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)) out.push({ start: +m[1], end: +m[2] });
  if (kind === 'silence') for (const m of stderr.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)) out.push({ start: +m[1], end: +m[2] });
  if (kind === 'freeze') {
    const starts = [...stderr.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => +m[1]);
    const ends = [...stderr.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => +m[1]);
    starts.forEach((s, i) => out.push({ start: s, end: ends[i] ?? s + 999 }));
  }
  return out;
}

/** Pure: integrated loudness from ffmpeg ebur128 summary. */
export function parseLufs(stderr: string): number | null {
  const m = stderr.match(/I:\s+(-?[\d.]+) LUFS/);
  return m ? Number(m[1]) : null;
}

/** Pure: word-level overlap between the caption text and a transcript of the final render (0-1). */
export function captionOverlap(captionWords: string[], transcriptWords: string[]): number {
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '');
  const a = captionWords.map(norm).filter(Boolean); const b = new Set(transcriptWords.map(norm).filter(Boolean));
  if (a.length === 0) return 1;
  return a.filter((w) => b.has(w)).length / a.length;
}

/** Pure: caption timing sanity on the rendered timeline. */
export function captionTimingIssues(words: Word[], durationSec: number): string[] {
  const issues: string[] = [];
  let last = -1;
  for (const w of words) {
    if (w.end < w.start) issues.push(`word "${w.word}" ends before it starts`);
    if (w.start < last - 0.01) issues.push(`word "${w.word}" is out of order`);
    if (w.end > durationSec + 0.5) { issues.push(`word "${w.word}" at ${w.end.toFixed(1)}s is past the end (${durationSec.toFixed(1)}s)`); break; }
    if (w.end - w.start > 4) issues.push(`word "${w.word}" shown for ${(w.end - w.start).toFixed(1)}s`);
    if (isProfane(w.word)) issues.push(`unmasked profanity "${w.word}"`);
    last = w.start;
  }
  return issues.slice(0, 5);
}

/** Pure: the editorial gate. */
/** Pure: a 0-10 score; a boolean answer (the model sometimes returns true/false for a score) counts as "not scored" (-1). */
export function score10(v: unknown): number {
  if (typeof v === 'boolean' || v == null || v === '') return -1;
  const x = Number(v); return Number.isFinite(x) ? Math.max(0, Math.min(10, Math.round(x))) : -1;
}

export function editorialGate(e: EditorialVerdict, commentaryMode: 'outro_voice' | 'text_only' | 'none' = 'outro_voice'): string[] {
  const r: string[] = [];
  if (e.hook < QC_LIMITS.minHook) r.push(`weak opening hook (${e.hook}/10)`);
  if (e.payoff < QC_LIMITS.minPayoff) r.push(`no clear comedic payoff (${e.payoff}/10)`);
  if (e.entertainment < QC_LIMITS.minEntertainment) r.push(`entertainment ${e.entertainment}/10`);
  if (commentaryMode !== 'none' && e.commentary < QC_LIMITS.minCommentary) r.push(`commentary adds little (${e.commentary}/10)`);
  if (e.storytelling < QC_LIMITS.minStorytelling) r.push(`weak setup-to-payoff storytelling (${e.storytelling}/10)`);
  if (e.editing < QC_LIMITS.minEditing) r.push(`editing not purposeful (${e.editing}/10)`);
  if (e.us_fit === -1) r.push('U.S.-audience fit not scored');
  else if (e.us_fit < QC_LIMITS.minUsFit) r.push(`weak fit for an English-speaking U.S. audience (${e.us_fit}/10)`);
  if (!e.natural_american_english) r.push('headline/commentary/caption not natural American English');
  if (e.defects.length) r.push(`visual defects: ${e.defects.join(', ')}`);
  if (!e.brand_visible) r.push('brand elements not visible');
  if (!e.captions_readable) r.push('captions / headline not readable');
  return r;
}

/** Pure: 0-10 editorial score from the vision verdict (hook, payoff, entertainment), minus a point per defect. */
export function qcScore(e: EditorialVerdict | null): number | null {
  if (!e) return null;
  const dims = [e.hook, e.payoff, e.entertainment, e.commentary, e.storytelling].filter((v) => Number.isFinite(v));
  return Math.max(0, Math.round((dims.reduce((a, b) => a + b, 0) / dims.length - e.defects.length) * 10) / 10);
}

const EDITORIAL_SYSTEM = `You are the independent quality reviewer for "The Unhinged Toaster", a comedy Shorts channel (angry toaster mascot,
red/black/yellow comic-book branding, family-friendly). You receive six frames of a FINISHED vertical video in time order
(left to right, top to bottom) plus its headline and caption. Judge the finished product, not the idea. Scale: zero is the
worst you have seen, ten is the best; use the whole range and copy no number from this text. Every score is an
integer from zero to ten, never true or false.
- hook: does the first moment make a scroller stop (clear subject, motion, readable headline)?
- payoff: is there one clear comedic payoff visible in the later frames?
- entertainment: would a general audience enjoy and share it?
- commentary: does the toaster's line (given as "commentary") add a joke, a point of view or meaning beyond describing the
  clip? Ten = a genuinely funny original take; zero = generic ("this is hilarious") or merely descriptive
- storytelling: is there a setup that leads to the payoff (headline frames it, moment lands, ending is a button)?
- editing: are the edits listed under "edits" purposeful for the joke (freeze before the payoff, punch-in on the
  moment, replay of the beat, captions that help), not decoration?
The channel is English-language for viewers in the United States. Judge from observable signals only (speech heard,
on-screen text, what happens), never from people's appearance, ethnicity or accent; footage filmed abroad is fine when
the gag is universal.
- us_fit: would an English-speaking American viewer get the joke instantly, with no translation or cultural explanation?
- works_muted: how well it lands with the original audio muted (headline, commentary and visuals only)
- natural_american_english (bool): headline, commentary and caption read like natural, casual American English (American
  spelling, no British slang, no stiff or translated-sounding phrasing)
- dialogue_dependent (bool): the joke needs the spoken words understood ("speech_heard" tells you the language Whisper
  detected); false for screams, laughter, animal sounds, physical comedy or background talk
- onscreen_text_language: "none" | "english" | "other" for source text that matters (captions, signs, meme text; ignore
  our own yellow/red channel graphics and the Instagram/TikTok handle watermark)
- onscreen_text_essential (bool): the joke needs that text read
- cultural_context_needed (bool): the payoff needs a regional reference, local celebrity, custom or wordplay
- defects (array, possibly empty) from: black_bars, letterboxing, cut_off_text, overlapping_overlays, unreadable_caption,
  blurry, stretched, watermark_covering_action, mascot_missing, black_frame, frozen_frame, wrong_aspect
- brand_visible: the toaster mascot or wordmark appears
- captions_readable: any on-screen text is legible and inside the frame
- rationale: one sentence. Respond with a single JSON object: {"hook":n,"payoff":n,"entertainment":n,"commentary":n,"storytelling":n,"editing":n,"us_fit":n,"works_muted":n,"natural_american_english":true,"dialogue_dependent":false,"onscreen_text_language":"none","onscreen_text_essential":false,"cultural_context_needed":false,"defects":[],"brand_visible":true,"captions_readable":true,"rationale":""}`;

export async function qualityControl(cfg: Config, i: QcInput): Promise<QcResult> {
  const checks: QcCheck[] = [];
  const add = (name: string, ok: boolean, severity: 'block' | 'warn', detail: string) => checks.push({ name, ok, severity, detail });
  const dir = path.dirname(i.file);

  // ---- technical (ffmpeg only)
  const probe = await ffprobe(i.file);
  add('resolution', probe.width === QC_LIMITS.width && probe.height === QC_LIMITS.height, 'block', `${probe.width}x${probe.height}`);
  add('duration', probe.duration >= QC_LIMITS.minSec && probe.duration <= QC_LIMITS.maxSec, 'block', `${probe.duration.toFixed(1)} s`);
  add('audio_present', probe.hasAudio, 'block', probe.hasAudio ? 'audio stream present' : 'no audio stream');
  const decode = await execFileP('ffmpeg', ['-v', 'error', '-i', i.file, '-f', 'null', '-'], { maxBuffer: 4 << 20 }).then((r) => r.stderr).catch((e: { stderr?: string }) => e.stderr ?? 'decode failed');
  add('decodes_cleanly', !String(decode).trim(), 'block', String(decode).trim().split('\n')[0]?.slice(0, 160) || 'no decoder errors');
  const streams = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', i.file]).then((r) => JSON.parse(r.stdout) as { streams: { codec_type: string; duration?: string }[] }).catch(() => ({ streams: [] }));
  const vd = Number(streams.streams.find((s) => s.codec_type === 'video')?.duration ?? probe.duration), ad = Number(streams.streams.find((s) => s.codec_type === 'audio')?.duration ?? vd);
  add('av_sync', Math.abs(vd - ad) <= QC_LIMITS.avDriftSec, 'block', `video ${vd.toFixed(2)} s / audio ${ad.toFixed(2)} s`);
  const black = await filterRun(i.file, 'blackdetect=d=0.2:pic_th=0.98', 'black');
  const longBlack = black.filter((b) => b.end - b.start >= QC_LIMITS.maxBlackSec);
  add('no_black_frames', longBlack.length === 0, 'block', longBlack.length ? `black ${longBlack.map((b) => `${b.start.toFixed(1)}-${b.end.toFixed(1)}s`).join(', ')}` : 'none');
  const frozen = await filterRun(i.file, `freezedetect=n=-55dB:d=${QC_LIMITS.maxFreezeSec}`, 'freeze');
  add('no_long_freeze', frozen.length === 0, 'block', frozen.length ? `frozen ${frozen.map((f) => `${f.start.toFixed(1)}-${Math.min(f.end, probe.duration).toFixed(1)}s`).join(', ')}` : 'none (intentional freeze beats are shorter)');
  if (probe.hasAudio) {
    const lufs = await execFileP('ffmpeg', ['-v', 'info', '-i', i.file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { maxBuffer: 4 << 20 }).then((r) => parseLufs(r.stderr)).catch(() => null);
    add('loudness', lufs == null || (lufs >= QC_LIMITS.minLufs && lufs <= QC_LIMITS.maxLufs), 'warn', lufs == null ? 'not measured' : `${lufs.toFixed(1)} LUFS`);
    const silence = await filterRun(i.file, 'silencedetect=n=-45dB:d=3', 'silence');
    const silent = silence.reduce((a, s) => a + (Math.min(s.end, probe.duration) - s.start), 0);
    add('not_mostly_silent', silent < probe.duration * 0.7, 'warn', `${silent.toFixed(1)} s of silence`);
  }

  // ---- content / compliance
  add('no_duplicate_production', i.siblingProductions === 0, 'block', i.siblingProductions ? `${i.siblingProductions} other production(s) for the same source` : 'single production for this source');
  const hard = (JSON.parse(i.candidate.safety_flags ?? '[]') as string[]).filter((f) => HARD_BLOCK_FLAGS.has(f));
  add('safety_flags', hard.length === 0, 'block', hard.length ? hard.join(', ') : 'none');
  const textWords = `${i.headline} ${i.caption}`.split(/\s+/);
  add('no_profanity_in_copy', !textWords.some(isProfane), 'block', 'headline + caption');
  add('headline_length', i.headline.trim().length >= 3 && i.headline.length <= 100, 'block', `${i.headline.length} chars`);
  add('caption_length', i.publicText.length <= 2100, 'block', `${i.publicText.length} chars (TikTok limit 2200)`);
  const creditsOk = /📩/.test(i.publicText) && (i.candidate.rights_status === 'cleared' || (i.publicText.includes(i.candidate.source_url) && /🎬|📜/.test(i.publicText)));
  add('source_credits', creditsOk, 'block', creditsOk ? 'credit block present (source, creator, contact)' : 'credit block incomplete');
  add('no_internal_text', !/REVIEW BEFORE APPROVING|transformation review|copyright risk/i.test(i.publicText), 'block', 'public text clean');
  add('hashtags', i.hashtags.length >= 3 && i.hashtags.length <= 10, 'warn', `${i.hashtags.length} tags`);
  let heard: SpeechInfo | null = null;
  if (i.transcribe) { try { heard = await i.transcribe(i.file); } catch (e) { if (isFatal(e)) throw e; } }
  if (i.words && i.words.length) {
    const timing = captionTimingIssues(i.words, probe.duration);
    add('caption_timing', timing.length === 0, 'block', timing.join('; ') || `${i.words.length} caption words inside the timeline`);
    if (i.transcribe) {
      const t = heard?.transcript ?? null;
      const overlap = t ? captionOverlap(i.words.map((w) => w.word), t.words.map((w) => w.word)) : null;
      add('caption_accuracy', overlap == null || overlap >= QC_LIMITS.captionOverlap, 'block', overlap == null ? 'final render not transcribable' : `${(overlap * 100).toFixed(0)} % of caption words heard in the final mix`);
    }
  }
  const speech = i.sourceSpeech ?? (heard && heard.wordCount > 0 ? { language: heard.language, words: heard.wordCount, excerpt: heard.text.slice(0, 300) } : null);
  add('american_english_copy', !UK_SLANG.test(`${i.headline} ${i.caption} ${i.commentary ?? ''}`), 'block', 'no British slang in headline/caption/commentary');

  // ---- editorial (vision model on the finished file)
  let editorial: EditorialVerdict | null = null;
  if (i.editorial !== false) {
    try {
      const sheet = await contactSheet(i.file, path.join(dir, 'qc_frames.jpg'));
      const b64 = sheetBase64(sheet);
      const r = await chatJson<Partial<EditorialVerdict>>(cfg, EDITORIAL_SYSTEM, JSON.stringify({ headline: i.headline, caption: i.caption, commentary: i.commentaryMode === 'none' ? '(none: the clip\'s own sound carries the ending)' : i.commentary ?? '', commentary_mode: i.commentaryMode, edits: i.edits ?? 'unknown', speech_heard: speech ?? 'no speech detected', duration_sec: Number(probe.duration.toFixed(1)), frames: 'attached: six frames, time order' }), { temperature: 0.1, maxTokens: 450, imageJpegBase64: b64 });
      const n = (v: unknown) => Math.max(0, Math.min(10, Math.round(Number(v) || 0)));
      if (score10((r as Record<string, unknown>).us_fit) < 0 || score10((r as Record<string, unknown>).works_muted) < 0) {
        const again = await chatJson<Partial<EditorialVerdict>>(cfg, EDITORIAL_SYSTEM, JSON.stringify({ headline: i.headline, caption: i.caption, commentary: i.commentary ?? '', speech_heard: speech ?? 'no speech detected', note: 'us_fit and works_muted must be integers from 0 to 10', frames: 'attached' }), { temperature: 0.1, maxTokens: 450, imageJpegBase64: b64 });
        (r as Record<string, unknown>).us_fit = (again as Record<string, unknown>).us_fit; (r as Record<string, unknown>).works_muted = (again as Record<string, unknown>).works_muted;
      }
      editorial = { hook: n(r.hook), payoff: n(r.payoff), entertainment: n(r.entertainment), commentary: i.commentaryMode === 'none' ? n(r.entertainment) : n(r.commentary), storytelling: n(r.storytelling), editing: n(r.editing), us_fit: score10(r.us_fit), works_muted: score10(r.works_muted), natural_american_english: r.natural_american_english !== false, dialogue_dependent: r.dialogue_dependent === true, onscreen_text_language: typeof r.onscreen_text_language === 'string' ? r.onscreen_text_language.toLowerCase() : 'none', onscreen_text_essential: r.onscreen_text_essential === true, cultural_context_needed: r.cultural_context_needed === true, defects: Array.isArray(r.defects) ? r.defects.map(String).slice(0, 8) : [], brand_visible: r.brand_visible !== false, captions_readable: r.captions_readable !== false, rationale: String(r.rationale ?? '').slice(0, 300) };
      const gate = editorialGate(editorial, i.commentaryMode);
      const lang = languageGate({ speechLanguage: speech?.language ?? null, speechWords: speech?.words ?? 0, dialogueDependent: editorial.dialogue_dependent, onscreenTextLanguage: editorial.onscreen_text_language, onscreenTextEssential: editorial.onscreen_text_essential, culturalContextNeeded: editorial.cultural_context_needed, worksMuted: editorial.works_muted < 0 ? null : editorial.works_muted });
      add('language_audience', lang.length === 0, 'block', lang.join('; ') || `speech ${speech ? `${speech.language} (${speech.words} words)` : 'none'}; on-screen text ${editorial.onscreen_text_language}; us_fit ${editorial.us_fit}, works muted ${editorial.works_muted}`);
      add('editorial', gate.length === 0, 'block', gate.join('; ') || `hook ${editorial.hook}, payoff ${editorial.payoff}, entertainment ${editorial.entertainment}, commentary ${editorial.commentary}, story ${editorial.storytelling}, editing ${editorial.editing}, us_fit ${editorial.us_fit}`);
    } catch (e) {
      if (isFatal(e)) throw e;
      add('editorial', false, 'block', `vision check failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  const ok = checks.every((c) => c.ok || c.severity === 'warn');
  const score = qcScore(editorial);
  const failed = checks.filter((c) => !c.ok);
  log.info(`QC ${i.candidate.id}: ${ok ? 'PASS' : 'FAIL'} score ${score ?? '-'}${failed.length ? ` (${failed.map((c) => `${c.name}${c.severity === 'warn' ? '?' : ''}: ${c.detail}`).join('; ')})` : ''}`);
  return { ok, score, checks, editorial, cost_note: i.editorial === false ? 'no model calls' : `1 vision call${i.transcribe && i.words?.length ? ' + 1 transcription' : ''}` };
}

async function filterRun(file: string, filter: string, kind: 'black' | 'freeze' | 'silence'): Promise<{ start: number; end: number }[]> {
  const args = kind === 'silence' ? ['-v', 'info', '-i', file, '-af', filter, '-f', 'null', '-'] : ['-v', 'info', '-i', file, '-vf', filter, '-an', '-f', 'null', '-'];
  const stderr = await execFileP('ffmpeg', args, { maxBuffer: 8 << 20 }).then((r) => r.stderr).catch((e: { stderr?: string }) => e.stderr ?? '');
  return parseIntervals(String(stderr), kind);
}

export function qcSummaryLine(r: QcResult): string {
  const failed = r.checks.filter((c) => !c.ok);
  return `${r.ok ? 'PASS' : 'FAIL'} score ${r.score ?? '-'}${failed.length ? ` | ${failed.map((c) => `${c.name}: ${c.detail}`).join('; ')}` : ''}`;
}

/** Keep the QC frames next to the render for the owner's calibration review. */
export function qcFramesPath(file: string): string { return path.join(path.dirname(file), 'qc_frames.jpg'); }
export function hasQcFrames(file: string): boolean { return fs.existsSync(qcFramesPath(file)); }
