/** Dependency-free ULID (Crockford base32, 48-bit time + 80-bit randomness). Works in Node and Workers. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function ulid(now: number = Date.now()): string {
  let time = now;
  let timeChars = '';
  for (let i = 0; i < 10; i++) {
    timeChars = ENCODING[time % 32] + timeChars;
    time = Math.floor(time / 32);
  }
  const rnd = randomBytes(16);
  let randChars = '';
  for (let i = 0; i < 16; i++) randChars += ENCODING[rnd[i] % 32];
  return timeChars + randChars;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
