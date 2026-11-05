/**
 * Provenance heuristics for "Creative Commons" labelled uploads.
 * A CC label on YouTube (or anywhere) is applied by the uploader and does NOT prove the uploader owns the footage.
 * These checks only lower the chance of laundering a stolen clip through a CC label; they are not proof of ownership.
 * Only `low` risk is eligible for automatic clearance; everything else stays `unknown`.
 */
export type ProvenanceRisk = 'low' | 'medium' | 'high';

const HIGH = [
  /compilation/i, /best of/i, /try not to laugh/i, /top \d+/i, /credit(s)? (to|goes to)/i, /\bnot (my|mine|own)\b/i,
  /original (video|creator|owner|source)/i, /\bvia @/i, /\bsource\s*[:：]/i, /\b(tiktok|instagram|reels?|reddit|twitter|x\.com)\b/i,
  /copyright (disclaimer|notice)/i, /fair use/i, /no copyright (intended|infringement)/i, /all rights (go|belong) to/i,
  /\bdm (me )?for (credit|removal)/i, /\bre-?upload/i, /\bmirror\b/i, /\bclips?\b/i, /\bfunny videos\b/i,
];
const MEDIUM = [/\bfails?\b/i, /\bviral\b/i, /\bmeme/i, /\bshorts?\b/i, /#\w+/, /\bepic\b/i, /\bcaught on camera\b/i];
const CHANNEL_HIGH = [/compilation/i, /fails?/i, /clips?/i, /viral/i, /daily dose/i, /best of/i, /tv$/i, /media$/i];

export interface ProvenanceInput {
  title: string;
  description?: string | null;
  channelTitle?: string | null;
  channelVideoCount?: number | null;
  durationSec?: number | null;
  hasMultipleScenes?: boolean | null; // from the pHash frame spread when available
}

export function ccProvenanceRisk(i: ProvenanceInput): { risk: ProvenanceRisk; reasons: string[] } {
  const reasons: string[] = [];
  const text = `${i.title}\n${i.description ?? ''}`;
  let score = 0;
  for (const re of HIGH) if (re.test(text)) { score += 3; reasons.push(`text:${re.source}`); }
  for (const re of MEDIUM) if (re.test(text)) { score += 1; reasons.push(`text:${re.source}`); }
  if (i.channelTitle) for (const re of CHANNEL_HIGH) if (re.test(i.channelTitle)) { score += 3; reasons.push(`channel:${re.source}`); }
  if (i.channelVideoCount != null && i.channelVideoCount > 2000) { score += 2; reasons.push('channel:very_high_upload_volume'); }
  if (i.hasMultipleScenes) { score += 2; reasons.push('video:multiple_scenes (compilation-like)'); }
  if (i.durationSec != null && i.durationSec > 50) { score += 1; reasons.push('video:long_for_single_clip'); }
  const risk: ProvenanceRisk = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
  return { risk, reasons: [...new Set(reasons)] };
}

/**
 * Broadcast / professional-sports / TV footage is never produced (RIGHTS_POLICY: copyright risk "high"). The LLM rubric
 * is asked to rate it high but rated an F1 podium clip and a TV news rescue "medium" in the 21-video run, so this
 * keyword screen runs on the title, the feed description, the vision summary and the transcript as a hard backstop.
 */
const BROADCAST = [
  /\b(f1|formula ?(1|one)|grand prix|motogp|nascar|indycar)\b/i, /\b(nfl|nba|nhl|mlb|mls|ufc|wwe|pga|atp|wta|fifa|uefa|ncaa)\b/i,
  /\b(premier league|champions league|la liga|bundesliga|serie a|super bowl|world cup|olympics?|olympic)\b/i,
  /\b(espn|fox sports|sky sports|bein|tnt sports|nbc sports|cbs sports|dazn)\b/i,
  /\b(live (tv|broadcast|news)|news (anchor|report|reporter|channel|broadcast)|reporter|breaking news|press conference|telediario|noticias|canal \d+)\b/i,
  /\b(talk show|late show|late night|tonight show|snl|saturday night live|game show|sitcom|episode \d+|season \d+)\b/i,
  /\b(podium|post-?match|post-?game|halftime|commentator|play-by-play)\b/i,
  /\b(trailer|official video|music video|concert footage)\b/i,
];
export function broadcastRisk(text: string): { high: boolean; reasons: string[] } {
  const reasons = BROADCAST.filter((re) => re.test(text)).map((re) => `broadcast:${re.source.slice(0, 40)}`);
  return { high: reasons.length > 0, reasons };
}
