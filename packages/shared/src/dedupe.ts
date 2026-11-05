/**
 * Duplicate detection.
 *  1. Exact: normalised source URL / platform id.
 *  2. Perceptual: 64-bit DCT pHash on N sampled grayscale frames (32x32), Hamming distance.
 *  3. Textual: trigram Jaccard on titles (catches re-uploads with the same caption).
 */

export function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'feature', 'si', 'ref', 'share_id'];
    for (const k of drop) u.searchParams.delete(k);
    // youtube: keep only v
    if (/(^|\.)youtube\.com$/.test(u.hostname) && u.searchParams.get('v')) {
      return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
    }
    if (u.hostname === 'youtu.be') return `https://www.youtube.com/watch?v=${u.pathname.slice(1)}`;
    let path = u.pathname.replace(/\/+$/, '');
    // reddit: strip the slug after the post id
    const m = path.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
    if (m) path = `/r/${m[1].toLowerCase()}/comments/${m[2].toLowerCase()}`;
    u.pathname = path;
    u.hostname = u.hostname.replace(/^(www|old|new|m)\./, '');
    return `${u.protocol}//${u.hostname}${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** pHash of a 32x32 grayscale frame (row-major, 1024 bytes). Returns 16 hex chars (64 bits). */
export function phashFrame(gray32: Uint8Array | number[]): string {
  if (gray32.length !== 1024) throw new Error(`expected 1024 gray pixels, got ${gray32.length}`);
  const N = 32;
  // 2D DCT-II, keep top-left 8x8
  const cosTable: number[][] = [];
  for (let u = 0; u < 8; u++) {
    cosTable[u] = [];
    for (let x = 0; x < N; x++) cosTable[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  }
  const rows: number[][] = []; // row DCT for u in 0..7 across each row y
  for (let y = 0; y < N; y++) {
    rows[y] = [];
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += gray32[y * N + x] * cosTable[u][x];
      rows[y][u] = s;
    }
  }
  const dct: number[] = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[y][u] * cosTable[v][y];
      dct.push(s);
    }
  }
  // exclude DC term from the median
  const ac = dct.slice(1);
  const sorted = [...ac].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let bits = '';
  for (let i = 0; i < 64; i++) bits += dct[i] > median ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

export function hamming(aHex: string, bHex: string): number {
  let x = BigInt('0x' + aHex) ^ BigInt('0x' + bHex);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Multi-frame hash string "h1:h2:h3". Compare as the mean of best-aligned per-frame distances. */
export function videoHashDistance(a: string, b: string): number {
  const fa = a.split(':').filter(Boolean);
  const fb = b.split(':').filter(Boolean);
  if (fa.length === 0 || fb.length === 0) return 64;
  // allow slight temporal offset: for each frame in a, best match within ±1 index in b
  let total = 0;
  for (let i = 0; i < fa.length; i++) {
    let best = 64;
    for (let j = Math.max(0, i - 1); j <= Math.min(fb.length - 1, i + 1); j++) best = Math.min(best, hamming(fa[i], fb[j]));
    total += best;
  }
  return total / fa.length;
}

/** Perceptual duplicate threshold (mean Hamming over frames). 64-bit pHash: <=10 is a near-certain match. */
export const PHASH_DUPLICATE_THRESHOLD = 10;

export function trigrams(s: string): Set<string> {
  const t = ` ${s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

export function titleSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export interface DedupeExisting { id: string; source_url: string; phash: string | null; title: string; duration_sec: number | null }

export function findDuplicate(
  cand: { source_url: string; phash: string | null; title: string; duration_sec: number | null },
  existing: DedupeExisting[],
): { id: string; reason: string } | null {
  const url = normaliseUrl(cand.source_url);
  for (const e of existing) {
    if (normaliseUrl(e.source_url) === url) return { id: e.id, reason: 'same_source_url' };
  }
  if (cand.phash) {
    for (const e of existing) {
      if (!e.phash) continue;
      const d = videoHashDistance(cand.phash, e.phash);
      if (d <= PHASH_DUPLICATE_THRESHOLD) return { id: e.id, reason: `phash_distance_${d.toFixed(1)}` };
    }
  }
  for (const e of existing) {
    const sim = titleSimilarity(cand.title, e.title);
    const durClose = cand.duration_sec != null && e.duration_sec != null && Math.abs(cand.duration_sec - e.duration_sec) <= 1.5;
    if (sim >= 0.8 && durClose) return { id: e.id, reason: `title_sim_${sim.toFixed(2)}_same_duration` };
  }
  return null;
}
