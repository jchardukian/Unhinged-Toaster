import { americanize, UK_SLANG } from '@toaster/shared';
import { clampSentence, containsSlur, normaliseHashtags, type Candidate, type CopyResult } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { chatJson } from '../llm.js';

const SYSTEM = `You write on-screen copy for "The Unhinged Toaster", a comedy Shorts channel with an angry toaster mascot.
Voice: loud, deadpan-furious, comic-book energy, wholesome underneath. PG. No slurs, no punching down, no mocking private people's bodies or disabilities.
Audience: English-speaking viewers in the United States. Write every field in natural, casual American English the way a funny American creator talks online: American spelling (color, favorite, mom), American terms, no British slang (no "mate", "bloody", "cheeky", "bloke", "innit"), no translated-sounding or stiff AI phrasing (avoid "Watch as…", "Spoiler:", "epic", "hilarious" filler). Never quote or translate non-English dialogue; describe what happens visually. Hashtags in English.
Output JSON:
{
 "headline": string,     // 3-8 words, ALL CAPS energy not required, max 60 characters, no hashtags, no emojis, no quotes
 "commentary": string,   // exactly ONE short punchy sentence the toaster yells about THIS clip, max 85 characters, must reference something specific in the clip
 "caption": string,      // 1-2 sentence post description, max 180 chars, no hashtags
 "hashtags": string[],   // 5-7 tags without '#', mix of broad (funny, fails, shorts) and specific
 "sticker": string,      // 1-3 word comic reaction that pops on screen at the peak moment, e.g. "NOPE.", "WHY.", "OH NO.", "BONK."
 "freeze_text": string,  // 1-4 words shown on a freeze-frame just before the payoff, e.g. "WAIT FOR IT…", "HE HAS NO IDEA"
 "edit_style": "full" | "light",  // light when the clip is dialogue-driven or the joke needs continuous motion (no freeze, no replay)
 "commentary_mode": "outro_voice" | "text_only" | "none",  // none when the clip's own sound IS the joke (screams, crashes, laughter, dialogue payoff); text_only when a silent on-screen line is funnier than a voice; otherwise outro_voice
 "music": "light" | "none"       // light = quiet comedic bed under the clip; none when the clip's own audio (a scream, a crash, dialogue) must stay clean
}`;

/** Hook + storytelling rules: on with the default (clean) presentation; off with TEMPLATE_VARIANT=classic or COPY_STRICT_HOOKS=false. */
const HOOK_RULES = `
Structure every Short as HOOK -> SETUP -> PAYOFF and keep it short:
- "headline" is the HOOK the viewer reads in the first second: a specific funny contradiction, an absurd observation, a question, or a clear setup for the coming disaster about THIS clip (e.g. "HE THINKS THE LEAVES ARE SOFT", "NOBODY TOLD THE CAT ABOUT GRAVITY"). Not a summary label, not hype.
- "commentary" is the toaster's ORIGINAL joke or opinion: something the viewer cannot see for themselves (a comparison, a judgment, a toaster's point of view). Never narrate what is on screen.
- "caption" reads like a person, not an announcer.
Banned anywhere: "Watch as", "Watch this", "Watch how", "You won't believe", "Spoiler", "takes an unexpected turn", "Things take a turn", "Wait for it" (except freeze_text), "pure chaos", "comedy gold", "epic", "hilarious".`;

/** Generic AI openings that read as automated filler (enforced only with the strict hook rules). */
export const GENERIC_COPY = /\b(watch (as|this|how|what)|you won'?t believe|spoiler( alert)?|takes? an unexpected turn|things take a turn|pure (chaos|joy|comedy)|comedy gold|epic fail|hilarious)\b/i;
export function strictHooksOn(): boolean { return process.env.COPY_STRICT_HOOKS !== 'false' && process.env.TEMPLATE_VARIANT?.trim() !== 'classic'; }

export async function writeCopy(cfg: Config, c: Candidate, transcript?: string | null, framesJpegBase64?: string): Promise<CopyResult> {
  const strict = strictHooksOn();
  const system = SYSTEM + (strict ? HOOK_RULES : '');
  try {
    const r = await chatJson<CopyResult>(cfg, system + (framesJpegBase64 ? '\nA contact sheet of six frames (time order: left-to-right, top-to-bottom) is attached: write about what VISIBLY happens, especially the payoff in the later frames. Never mention watermarks or handles in the copy.' : ''), JSON.stringify({
      original_title: c.title, description: c.description, visual_summary: c.visual_summary ?? null, category: c.category, duration_sec: c.duration_sec, transcript: transcript?.slice(0, 800) ?? null,
    }), { temperature: 0.9, maxTokens: 400, imageJpegBase64: framesJpegBase64 });
    const out = validate(r, { strictHooks: strict });
    if (out) return out;
    log.warn(`copy failed validation for ${c.id} (empty, slur, British, or generic opener), retrying once with the clip context`);
    const r2 = await chatJson<CopyResult>(cfg, system + '\nYour previous attempt was rejected (empty, offensive, not natural American English, or a generic opener like "Watch as"). Keep it clean, American, specific to the clip, and open with a real hook.', JSON.stringify({ original_title: c.title, visual_summary: c.visual_summary ?? null, category: c.category, transcript: transcript?.slice(0, 400) ?? null }), { temperature: 0.6, maxTokens: 350, imageJpegBase64: framesJpegBase64 });
    // a still-generic retry beats the per-category fallback (which is unrelated to the clip), so the retry is judged without the hook rule
    const out2 = validate(r2, { strictHooks: strict }) ?? (strict ? validate(r2) : null);
    if (out2) return out2;
  } catch (e) {
    log.warn(`copywriter LLM failed for ${c.id}: ${(e as Error).message}`);
  }
  return fallback(c);
}

/**
 * Normalise the LLM copy. Length and sentence-count problems are REPAIRED (first sentence, word-boundary cut) rather than
 * rejected: a rejected copy used to fall through to the generic per-category fallback, which produced a Short whose
 * commentary had nothing to do with the clip (1 of 21 in the production test). Only empty text and slurs still reject.
 */
export function validate(r: CopyResult, opts: { strictHooks?: boolean } = {}): CopyResult | null {
  if (!r || typeof r.headline !== 'string' || typeof r.commentary !== 'string') return null;
  let headline = r.headline.replace(/["“”#]/g, '').replace(/\s+/g, ' ').trim();
  if (headline.length > 60) headline = headline.slice(0, 60).replace(/\s+\S*$/, '').replace(/[,:;\-–—]+$/, '').trim();
  let commentary = r.commentary.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  const firstSentence = commentary.match(/^.*?[.!?]+(?=\s|$)/)?.[0];
  if (firstSentence && firstSentence.length >= 12 && (commentary.match(/[.!?]+/g) ?? []).length > 1) commentary = firstSentence.trim();
  commentary = clampSentence(commentary, 100);
  if (headline.length < 3 || !/[a-z]/i.test(commentary)) return null;
  if (containsSlur(headline) || containsSlur(commentary) || containsSlur(r.caption ?? '')) return null;
  const sticker = cleanShort(r.sticker, 14);
  const freeze = cleanShort(r.freeze_text, 22);
  // American English: repair British spellings everywhere; reject British slang (the caller retries once)
  const caption = americanize(clampSentence(String(r.caption ?? ''), 180));
  headline = americanize(headline); commentary = americanize(commentary);
  if (UK_SLANG.test(headline) || UK_SLANG.test(commentary) || UK_SLANG.test(caption)) return null;
  if (opts.strictHooks && (GENERIC_COPY.test(headline) || GENERIC_COPY.test(commentary) || GENERIC_COPY.test(caption))) return null;
  const tags = (Array.isArray(r.hashtags) ? r.hashtags : ['funny', 'shorts', 'fails']).map((t) => americanize(String(t))).filter((t) => /^[#A-Za-z0-9_]+$/.test(t.replace(/\s/g, '')));
  return {
    headline,
    commentary,
    caption,
    hashtags: normaliseHashtags(tags.length ? tags : ['funny', 'shorts', 'fails'], 7),
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
