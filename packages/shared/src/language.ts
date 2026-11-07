/**
 * English-language / U.S.-audience gate (owner decision 2026-11-07: an English-language channel for U.S. viewers).
 * Uses observable signals only: the language Whisper hears, how much is said, on-screen text the vision model reads,
 * and whether the joke depends on words or cultural context. Never nationality, appearance, ethnicity or accent;
 * footage filmed abroad passes when the gag is universal.
 */
export interface LanguageSignals {
  speechLanguage: string | null;      // Whisper language ("english", "hindi", ...) or null when silent
  speechWords: number;                // words heard
  dialogueDependent?: boolean | null; // model: the joke needs the spoken words understood
  onscreenTextLanguage?: string | null; // model: 'none' | 'english' | 'other'
  onscreenTextEssential?: boolean | null; // model: the joke needs the on-screen text read
  culturalContextNeeded?: boolean | null; // model: the payoff needs regional/cultural knowledge an American viewer lacks
  worksMuted?: number | null;         // model 0-10: entertaining with the original audio muted
}

export const LANGUAGE_RULES = { substantialSpeechWords: 6, minWorksMutedWhenForeignSpeech: 6 } as const;

const isEnglish = (l: string | null | undefined) => !l || /^(en|english|none)$/i.test(l);

/** Pure: reasons to reject (empty = accepted). */
export function languageGate(s: LanguageSignals): string[] {
  const r: string[] = [];
  const foreignSpeech = !isEnglish(s.speechLanguage) && s.speechWords >= LANGUAGE_RULES.substantialSpeechWords;
  if (foreignSpeech && s.dialogueDependent) r.push(`joke depends on non-English dialogue (${s.speechLanguage}, ${s.speechWords} words)`);
  if (foreignSpeech && !s.dialogueDependent && s.worksMuted != null && s.worksMuted < LANGUAGE_RULES.minWorksMutedWhenForeignSpeech) r.push(`${s.speechLanguage} dialogue and the clip does not work muted (${s.worksMuted}/10)`);
  if (s.onscreenTextLanguage && !isEnglish(s.onscreenTextLanguage) && s.onscreenTextEssential) r.push('the joke is carried by non-English on-screen text');
  if (s.culturalContextNeeded) r.push('the payoff needs cultural or regional context an American viewer would not have');
  return r;
}

/** American-English copy: common British spellings repaired, British slang rejected. */
const UK_SPELLINGS: [RegExp, string][] = [
  [/\bcolour/gi, 'color'], [/\bfavourite/gi, 'favorite'], [/\bhumour/gi, 'humor'], [/\bbehaviour/gi, 'behavior'], [/\bneighbour/gi, 'neighbor'],
  [/\bflavour/gi, 'flavor'], [/\bhonour/gi, 'honor'], [/\brumour/gi, 'rumor'], [/\bcentre\b/gi, 'center'], [/\btheatre\b/gi, 'theater'],
  [/\borganis(e|ed|ing)\b/gi, 'organiz$1'], [/\brealis(e|ed|ing)\b/gi, 'realiz$1'], [/\bapologis(e|ed|ing)\b/gi, 'apologiz$1'], [/\bpyjamas\b/gi, 'pajamas'],
  [/\bmum\b/gi, 'mom'], [/\btyre/gi, 'tire'], [/\baluminium\b/gi, 'aluminum'], [/\bgrey\b/gi, 'gray'], [/\btravell(ed|ing|er)\b/gi, 'travel$1'],
];
export const UK_SLANG = /\b(bloody|bloke|blokes|innit|cheeky|knackered|gobsmacked|chuffed|arse|bollocks|quid|lorry|loo|cuppa|brekkie|telly|mate|mates|cheers|proper (mad|funny)|bin lorry|trainers)\b/i;

export function americanize(text: string): string {
  let t = text;
  for (const [re, rep] of UK_SPELLINGS) t = t.replace(re, (m, g1) => matchCase(m, rep.replace('$1', g1 ?? '')));
  return t;
}
function matchCase(src: string, rep: string): string {
  if (src === src.toUpperCase()) return rep.toUpperCase();
  if (src[0] === src[0].toUpperCase()) return rep[0].toUpperCase() + rep.slice(1);
  return rep;
}
