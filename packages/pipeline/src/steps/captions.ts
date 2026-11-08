import fs from 'node:fs';
import { log, type Config } from '../config.js';
import { recordWhisper } from '../usage.js';
import { assertBudget, assertOpen, fetchWithTimeout, recordFailure, recordSuccess, TIMEOUTS } from '../guard.js';
import { mediaDuration } from './media.js';

export interface Word { word: string; start: number; end: number }
export interface Transcript { text: string; words: Word[] }

/**
 * What was heard in the audio, kept even when the words are not usable as captions: Whisper's detected language and the
 * raw text. A non-English transcript used to be dropped as a "hallucination", which made foreign-language dialogue look
 * like silence to the language gate.
 */
export interface SpeechInfo { transcript: Transcript | null; language: string | null; text: string; wordCount: number; discarded: string | null }

/** Pure: is this detected speech English? Unknown / empty counts as no speech. */
export function isEnglishSpeech(s: Pick<SpeechInfo, 'language'> | null): boolean { return !s?.language || /^(en|english)$/i.test(s.language); }

/** Whisper (OpenAI) word-level transcription. Returns null when there is no usable speech. */
export async function transcribe(cfg: Config, audioFile: string): Promise<Transcript | null> {
  return (await transcribeDetailed(cfg, audioFile))?.transcript ?? null;
}

export async function transcribeDetailed(cfg: Config, audioFile: string): Promise<SpeechInfo | null> {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioFile)]), 'audio.mp3');
  form.append('model', cfg.transcribeModel);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  assertOpen('openai');
  assertBudget('whisper');
  const res = await fetchWithTimeout('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.openaiKey ?? 'proxy-injected'}` },
    body: form,
  }, TIMEOUTS.whisperMs, 'Whisper');
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const fatal = recordFailure('openai', res.status, body);
    if (fatal) throw fatal;
    log.warn(`whisper ${res.status}: ${body}`); return null;
  }
  recordSuccess('openai');
  recordWhisper((await mediaDuration(audioFile)) ?? 0);
  const j = (await res.json()) as { text: string; words?: Word[]; language?: string };
  const words = (j.words ?? []).filter((w) => w.word.trim());
  const base = { language: j.language ?? null, text: (j.text ?? '').trim(), wordCount: words.length };
  if (words.length === 0 || base.text.length < 2) return { ...base, transcript: null, discarded: 'no_speech' };
  // captions are English-only: any non-English speech is reported to the language gate, never captioned
  // known Whisper hallucinations (subtitle credits, "thanks for watching", repetitions) are not speech in ANY language;
  // only the script check is skipped for non-English, because real foreign speech is what the language gate needs
  const h = isHallucination(j.text, words);
  if (h && h !== 'non_latin_script') { log.info(`transcript discarded as Whisper hallucination (${h}): "${base.text.slice(0, 60)}"`); return { ...base, language: null, wordCount: 0, transcript: null, discarded: h }; }
  if (!isEnglishSpeech(base)) { log.info(`speech in ${base.language}: "${base.text.slice(0, 60)}" (not captioned; language gate decides)`); return { ...base, transcript: null, discarded: 'non_english' }; }
  if (h) { log.info(`transcript discarded as Whisper hallucination (${h}): "${base.text.slice(0, 60)}"`); return { ...base, transcript: null, discarded: h }; }
  return { ...base, transcript: { text: base.text, words }, discarded: null };
}

/** PG channel: swear words are masked in captions (f**k) and muted in the source audio for the word's duration. */
const PROFANITY = /\b(f+u+c*k+\w*|s+h+i+t+\w*|b+i+t+c+h+\w*|a+s+s+h+o+l+e+\w*|d+i+c+k+\w*|c+u+n+t+\w*|m+o+t+h+e+r+f+\w*|n+i+g+g+\w*|f+a+g+g*\w*|r+e+t+a+r+d+\w*)\b/i;

export function isProfane(word: string): boolean { return PROFANITY.test(word.replace(/[^A-Za-z]/g, '')); }

export function maskProfanity(word: string): string {
  if (!isProfane(word)) return word;
  return word.replace(/[A-Za-z]+/g, (m) => (m.length <= 2 ? '*'.repeat(m.length) : m[0] + '*'.repeat(m.length - 2) + m[m.length - 1]));
}

/** Source-time windows (seconds) to silence: every profane word, padded slightly. */
export function muteWindows(words: Word[], pad = 0.05): { from: number; to: number }[] {
  return words.filter((w) => isProfane(w.word)).map((w) => ({ from: Math.max(0, w.start - pad), to: w.end + pad }));
}

/**
 * Whisper invents text on music / noise / silence ("Thanks for watching!", repeated syllables, foreign-script loops).
 * Captions must never show that, so such transcripts are dropped (the short then simply has no captions).
 */
export function isHallucination(text: string, words: Word[]): string | null {
  const t = text.trim();
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return 'no_letters';
  const toks = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (toks.length >= 4 && new Set(toks).size / toks.length < 0.35) return 'repetitive';
  if (/^(thanks? (you )?for watching|thank you|subscribe|like and subscribe|see you (in the )?next|bye[.!]*)[.!\s]*$/i.test(t)) return 'stock_phrase';
  if (/(more videos|our channel|subscribe to|subtitles? by|subt[ií]tulos|untertitel|sous-titres|amara\.org|www\.|\.com\b|\.org\b|copyright|all rights reserved|抖音|字幕)/i.test(t) && toks.length <= 12) return 'stock_phrase';
  const latin = letters.replace(/[^A-Za-z\u00C0-\u024F]/g, '').length;
  if (latin / letters.length < 0.6) return 'non_latin_script';
  const span = words[words.length - 1].end - words[0].start;
  const spoken = words.reduce((a, w) => a + Math.max(0, w.end - w.start), 0);
  if (toks.length >= 6 && span > 3 && spoken / span < 0.08) return 'implausible_timing';
  return null;
}

export interface CaptionStyle {
  fontName: string; fontSize: number; marginV: number; primary: string; secondary: string; outline: string; playResX: number; playResY: number;
  /** 'sweep' (default): karaoke fill; 'word': the spoken word pops in the primary colour, the others stay secondary */
  highlight?: 'sweep' | 'word'; activeScale?: number; outlineWidth?: number; shadow?: number;
}

/**
 * Build an ASS subtitle file with 1-3 word chunks and karaoke (\kf) word highlight.
 * Secondary colour = not-yet-spoken (white), Primary = spoken (brand yellow).
 */
export function buildAss(words: Word[], style: CaptionStyle, opts: { maxWords?: number; maxChunkSec?: number; offsetSec?: number } = {}): string {
  const maxWords = opts.maxWords ?? 3;
  const maxChunk = opts.maxChunkSec ?? 1.8;
  const offset = opts.offsetSec ?? 0;
  const chunks: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    if (cur.length && (cur.length >= maxWords || w.end - cur[0].start > maxChunk || w.start - cur[cur.length - 1].end > 0.6)) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${style.playResX}
PlayResY: ${style.playResY}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Toast,${style.fontName},${style.fontSize},${style.primary},${style.secondary},${style.outline},&H80000000,0,0,0,0,100,100,1,0,1,${style.outlineWidth ?? 6},${style.shadow ?? 3},2,60,60,${style.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  if (style.highlight === 'word') {
    // one event per spoken word: the whole phrase stays on screen, the current word pops (accent colour + scale)
    const sc = Math.round((style.activeScale ?? 1.1) * 100);
    const ev: string[] = [];
    for (const ch of chunks) {
      const chEnd = Math.max(ch[ch.length - 1].end, ch[0].start + 0.35) + 0.08;
      ch.forEach((w, k) => {
        const s0 = w.start + offset;
        const s1 = (k + 1 < ch.length ? ch[k + 1].start : chEnd) + offset;
        if (s1 <= s0) return;
        const text = ch.map((x, j) => (j === k ? `{\\c${style.primary}\\fscx${sc}\\fscy${sc}}${clean(x.word)}{\\c${style.secondary}\\fscx100\\fscy100}` : clean(x.word))).join(' ');
        ev.push(`Dialogue: 0,${ts(s0)},${ts(s1)},Toast,,0,0,0,,{\\c${style.secondary}}${text}`);
      });
    }
    return header + ev.join('\n') + '\n';
  }
  const lines = chunks.map((ch) => {
    const start = ch[0].start + offset;
    const end = Math.max(ch[ch.length - 1].end, start + 0.35) + offset + 0.08;
    const text = ch.map((w) => {
      const cs = Math.max(1, Math.round((w.end - w.start) * 100));
      return `{\\kf${cs}}${clean(w.word)}`;
    }).join(' ');
    return `Dialogue: 0,${ts(start)},${ts(end)},Toast,,0,0,0,,{\\fad(60,60)}${text}`;
  });
  return header + lines.join('\n') + '\n';
}

function clean(w: string): string {
  return w.trim().replace(/[{}]/g, '').toUpperCase();
}
function ts(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60), cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** ASS colours are &HAABBGGRR. */
export function assColor(hex: string, alpha = 0): string {
  const m = hex.replace('#', '');
  const r = m.slice(0, 2), g = m.slice(2, 4), b = m.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase().replace('&H', '&H');
}
