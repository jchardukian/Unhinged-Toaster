/** Text helpers shared by the copywriter step and the renderer. */

/** Greedy word wrap for drawtext (which does not wrap). Returns at most `maxLines`, truncating with … */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length <= maxChars) cur = (cur + ' ' + w).trim();
    else {
      if (cur) lines.push(cur);
      cur = w.length > maxChars ? w.slice(0, maxChars - 1) + '…' : w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/[.,!?…]*$/, '').slice(0, maxChars - 1) + '…';
    return kept;
  }
  return lines;
}

/** Escape a string for FFmpeg drawtext `text=` (filtergraph level + drawtext level). */
export function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "’") // typographic apostrophe avoids quoting hell
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/;/g, '\\;');
}

export function clampSentence(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:!?]*$/, '') + '…';
}

const BANNED = [/\bretard/i, /\bfag/i, /\bnigg/i, /\btrann/i, /\bkike\b/i, /\bspic\b/i, /\bchink\b/i];
export function containsSlur(s: string): boolean {
  return BANNED.some((re) => re.test(s));
}

export function normaliseHashtags(tags: string[], max = 8): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const clean = t.replace(/^#/, '').replace(/[^A-Za-z0-9_]/g, '');
    if (clean && !out.some((x) => x.toLowerCase() === clean.toLowerCase())) out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}
