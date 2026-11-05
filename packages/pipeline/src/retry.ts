import { log } from './config.js';

/** Retry with exponential backoff. `shouldRetry` can veto (e.g. 4xx client errors). */
export async function withRetry<T>(label: string, fn: (attempt: number) => Promise<T>, opts: { attempts?: number; baseMs?: number; shouldRetry?: (e: Error) => boolean } = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 1500;
  let last: Error | undefined;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e as Error;
      if (i === attempts || (opts.shouldRetry && !opts.shouldRetry(last))) break;
      const wait = base * 2 ** (i - 1);
      log.warn(`${label} attempt ${i}/${attempts} failed: ${last.message.split('\n')[0].slice(0, 200)}; retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last ?? new Error(`${label} failed`);
}

/** 4xx (except 408/429) are not worth retrying. */
export function isTransient(e: Error): boolean {
  const m = e.message.match(/\b(4\d\d|5\d\d)\b/);
  if (!m) return true;
  const code = Number(m[1]);
  return code >= 500 || code === 408 || code === 429;
}
