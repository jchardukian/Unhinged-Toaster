import { clampSentence, containsSlur, normaliseHashtags, type Candidate, type CopyResult } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { chatJson } from '../llm.js';

const SYSTEM = `You write on-screen copy for "The Unhinged Toaster", a comedy Shorts channel with an angry toaster mascot.
Voice: loud, deadpan-furious, comic-book energy, wholesome underneath. PG. No slurs, no punching down, no mocking private people's bodies or disabilities.
Output JSON:
{
 "headline": string,     // 3-8 words, ALL CAPS energy not required, max 60 characters, no hashtags, no emojis, no quotes
 "commentary": string,   // exactly ONE sentence the toaster yells about THIS clip, max 110 characters, must reference something specific in the clip
 "caption": string,      // 1-2 sentence post description, max 180 chars, no hashtags
 "hashtags": string[],   // 5-7 tags without '#', mix of broad (funny, fails, shorts) and specific
 "sticker": string,      // 1-3 word comic reaction that pops on screen at the peak moment, e.g. "NOPE.", "WHY.", "OH NO.", "BONK."
 "freeze_text": string,  // 1-4 words shown on a freeze-frame just before the payoff, e.g. "WAIT FOR IT…", "HE HAS NO IDEA"
 "edit_style": "full" | "light",  // light when the clip is dialogue-driven or the joke needs continuous motion (no freeze, no replay)
 "commentary_mode": "outro_voice" | "text_only" | "none",  // none when the clip's own sound IS the joke (screams, crashes, laughter, dialogue payoff); text_only when a silent on-screen line is funnier than a voice; otherwise outro_voice
 "music": "light" | "none"       // light = quiet comedic bed under the clip; none when the clip's own audio (a scream, a crash, dialogue) must stay clean
}`;

export async function writeCopy(cfg: Config, c: Candidate, transcript?: string | null): Promise<CopyResult> {
  try {
    const r = await chatJson<CopyResult>(cfg, SYSTEM, JSON.stringify({
      original_title: c.title, description: c.description, category: c.category, duration_sec: c.duration_sec, transcript: transcript?.slice(0, 800) ?? null,
    }), { temperature: 0.9, maxTokens: 350 });
    const out = validate(r);
    if (out) return out;
    log.warn(`copy failed validation for ${c.id}, retrying once`);
    const r2 = await chatJson<CopyResult>(cfg, SYSTEM + '\nYour previous attempt violated the limits. Be shorter.', JSON.stringify({ original_title: c.title, category: c.category }), { temperature: 0.6, maxTokens: 300 });
    const out2 = validate(r2);
    if (out2) return out2;
  } catch (e) {
    log.warn(`copywriter LLM failed for ${c.id}: ${(e as Error).message}`);
  }
  return fallback(c);
}

export function validate(r: CopyResult): CopyResult | null {
  if (!r || typeof r.headline !== 'string' || typeof r.commentary !== 'string') return null;
  const headline = r.headline.replace(/["“”#]/g, '').replace(/\s+/g, ' ').trim();
  const commentary = clampSentence(r.commentary.replace(/["“”]/g, ''), 110);
  if (headline.length < 3 || headline.length > 60) return null;
  if (!/[a-z]/i.test(commentary)) return null;
  // single sentence: at most one terminal punctuation run
  if ((commentary.match(/[.!?]+/g) ?? []).length > 1) return null;
  if (containsSlur(headline) || containsSlur(commentary) || containsSlur(r.caption ?? '')) return null;
  const sticker = cleanShort(r.sticker, 14);
  const freeze = cleanShort(r.freeze_text, 22);
  return {
    headline,
    commentary,
    caption: clampSentence(String(r.caption ?? ''), 180),
    hashtags: normaliseHashtags(Array.isArray(r.hashtags) ? r.hashtags : ['funny', 'shorts', 'fails'], 7),
    sticker: sticker || undefined,
    freeze_text: freeze || undefined,
    edit_style: r.edit_style === 'light' ? 'light' : 'full',
    commentary_mode: r.commentary_mode === 'none' || r.commentary_mode === 'text_only' ? r.commentary_mode : 'outro_voice',
    music: r.music === 'none' ? 'none' : 'light',
  };
}

function cleanShort(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const t = v.replace(/["“”#]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!t || t.length > max || containsSlur(t)) return '';
  return t;
}

export function fallback(c: Candidate): CopyResult {
  const byCat: Record<string, { h: string; c: string }> = {
    people_fails: { h: 'That did NOT go to plan', c: 'I have burned toast with more grace than this.' },
    funny_animals: { h: 'This animal has zero chill', c: 'Even my crumb tray is better behaved than that.' },
    unbelievable: { h: 'Wait for it...', c: 'I rewound this five times and I still refuse to believe it.' },
    wholesome_reactions: { h: 'Protect this reaction at all costs', c: 'I am a furious kitchen appliance and even I teared up.' },
  };
  const f = byCat[c.category ?? 'people_fails'] ?? byCat.people_fails;
  return { headline: f.h, commentary: f.c, caption: 'The Unhinged Toaster reacts.', hashtags: ['funny', 'shorts', 'fails', 'viral', 'comedy'], sticker: 'OH NO.', freeze_text: 'WAIT FOR IT…', edit_style: 'full', commentary_mode: 'outro_voice', music: 'light' };
}
