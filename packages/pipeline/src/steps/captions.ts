import fs from 'node:fs';
import { log, type Config } from '../config.js';

export interface Word { word: string; start: number; end: number }
export interface Transcript { text: string; words: Word[] }

/** Whisper (OpenAI) word-level transcription. Returns null when there is no usable speech. */
export async function transcribe(cfg: Config, audioFile: string): Promise<Transcript | null> {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioFile)]), 'audio.mp3');
  form.append('model', cfg.transcribeModel);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.openaiKey ?? 'proxy-injected'}` },
    body: form,
  });
  if (!res.ok) { log.warn(`whisper ${res.status}: ${(await res.text()).slice(0, 200)}`); return null; }
  const j = (await res.json()) as { text: string; words?: Word[] };
  const words = (j.words ?? []).filter((w) => w.word.trim());
  if (words.length === 0 || j.text.trim().length < 2) return null;
  const h = isHallucination(j.text, words);
  if (h) { log.info(`transcript discarded as Whisper hallucination (${h}): "${j.text.trim().slice(0, 60)}"`); return null; }
  return { text: j.text.trim(), words };
}

/**
 * Whisper invents text on music / noise / silence ("Thanks for watching!", repeated syllables, foreign-script loops).
 * Captions must never show that, so such transcripts are dropped (the short then simply has no captions).
 */
export function isHallucination(text: string, words: Word[]): string | null {
  const t = text.trim();
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return 'no_letters';
  const latin = letters.replace(/[^A-Za-z\u00C0-\u024F]/g, '').length;
  if (latin / letters.length < 0.6) return 'non_latin_script';
  const toks = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (toks.length >= 4 && new Set(toks).size / toks.length < 0.35) return 'repetitive';
  if (/^(thanks? (you )?for watching|thank you|subscribe|like and subscribe|see you (in the )?next|bye[.!]*)[.!\s]*$/i.test(t)) return 'stock_phrase';
  if (/(more videos|our channel|subscribe to|subtitles? by|amara\.org|www\.|\.com\b|copyright|all rights reserved)/i.test(t) && toks.length <= 12) return 'stock_phrase';
  const span = words[words.length - 1].end - words[0].start;
  const spoken = words.reduce((a, w) => a + Math.max(0, w.end - w.start), 0);
  if (toks.length >= 6 && span > 3 && spoken / span < 0.08) return 'implausible_timing';
  return null;
}

export interface CaptionStyle {
  fontName: string; fontSize: number; marginV: number; primary: string; secondary: string; outline: string; playResX: number; playResY: number;
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
Style: Toast,${style.fontName},${style.fontSize},${style.primary},${style.secondary},${style.outline},&H80000000,0,0,0,0,100,100,1,0,1,6,3,2,60,60,${style.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
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
