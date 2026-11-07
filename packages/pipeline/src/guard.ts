import { costOf, currentUsage, videoGenUsd } from './usage.js';

/**
 * Cost and failure controls shared by every paid call:
 *  - metered budget: API_BUDGET_USD (default $2 for diagnostics, set higher by the production workflows); every
 *    LLM / Whisper / TTS call checks the tracked spend first and throws BudgetExceededError when it is used up;
 *  - circuit breaker: two consecutive 400 / 401 / 403 answers from one service trip it, and every later call to that
 *    service fails immediately with FatalApiError instead of burning the whole candidate list on the same mistake
 *    (run 42237222419 made ~320 identical "model parameter" 400s before anyone noticed);
 *  - timeouts: fetchWithTimeout / withTimeout for every stage, so a hung request cannot eat the job's 3 hours.
 */
export class BudgetExceededError extends Error {
  constructor(public readonly spentUsd: number, public readonly budgetUsd: number, label: string) {
    super(`API budget exhausted: $${spentUsd.toFixed(4)} spent of $${budgetUsd.toFixed(2)} (${label}). Raise API_BUDGET_USD only on purpose.`);
    this.name = 'BudgetExceededError';
  }
}
export class FatalApiError extends Error {
  constructor(public readonly service: string, public readonly status: number, detail: string) {
    super(`${service} rejected the request with HTTP ${status} and will keep doing so (${detail}). Fix the configuration; not retrying.`);
    this.name = 'FatalApiError';
  }
}
export class StageTimeoutError extends Error {
  constructor(label: string, ms: number) { super(`${label} exceeded its ${Math.round(ms / 1000)} s time limit`); this.name = 'StageTimeoutError'; }
}
export const isFatal = (e: unknown): boolean => e instanceof BudgetExceededError || e instanceof FatalApiError || (e instanceof Error && e.name === 'VideoBudgetExceededError');

let budgetUsd = Number(process.env.API_BUDGET_USD) > 0 ? Number(process.env.API_BUDGET_USD) : 2;
export function setBudget(usd: number): void { budgetUsd = usd; }
export function budget(): number { return budgetUsd; }
export function spentUsd(): number { return costOf(currentUsage()).total_usd; }
/** Throws when the metered spend has reached the budget. Called BEFORE each paid request. */
export function assertBudget(label: string): void {
  const spent = spentUsd();
  if (spent >= budgetUsd) throw new BudgetExceededError(spent, budgetUsd, label);
}

/**
 * AI video generation has its own HARD cap (AI_VIDEO_BUDGET_USD, default $0 = paused). It is checked with the cost of the
 * NEXT attempt included, is never raised by code, and exhausting it ends the pilot with a report, not a retry.
 */
// Paid AI video generation is PAUSED: the cap defaults to $0, so no paid provider can run unless AI_VIDEO_BUDGET_USD is set on purpose.
let videoBudgetUsd = Number(process.env.AI_VIDEO_BUDGET_USD) > 0 ? Number(process.env.AI_VIDEO_BUDGET_USD) : 0;
export function videoBudget(): number { return videoBudgetUsd; }
export function setVideoBudget(usd: number): void { videoBudgetUsd = usd; }
export class VideoBudgetExceededError extends Error {
  constructor(public readonly spentUsd: number, public readonly nextUsd: number, public readonly budgetUsd: number) {
    super(`AI video budget: $${spentUsd.toFixed(2)} spent, next attempt $${nextUsd.toFixed(2)} would exceed the $${budgetUsd.toFixed(2)} hard cap. Stopping; not raising the cap automatically.`);
    this.name = 'VideoBudgetExceededError';
  }
}
export function assertVideoBudget(nextAttemptUsd: number): void {
  const spent = videoGenUsd();
  if (spent + nextAttemptUsd > videoBudgetUsd) throw new VideoBudgetExceededError(spent, nextAttemptUsd, videoBudgetUsd);
}

const PERSISTENT = new Set([400, 401, 403]);
const consecutive = new Map<string, { count: number; status: number; detail: string }>();
const tripped = new Map<string, FatalApiError>();
export const BREAKER_THRESHOLD = 2;

/** Record a non-OK answer. Returns the fatal error once the breaker trips. */
export function recordFailure(service: string, status: number, detail: string): FatalApiError | null {
  if (!PERSISTENT.has(status)) { consecutive.delete(service); return null; }
  const cur = consecutive.get(service);
  const next = { count: (cur && cur.status === status ? cur.count : 0) + 1, status, detail: detail.slice(0, 200) };
  consecutive.set(service, next);
  if (next.count >= BREAKER_THRESHOLD) {
    const err = new FatalApiError(service, status, next.detail);
    tripped.set(service, err);
    return err;
  }
  return null;
}
export function recordSuccess(service: string): void { consecutive.delete(service); }
/** Throws immediately when the service's breaker has tripped. Called BEFORE each request. */
export function assertOpen(service: string): void { const t = tripped.get(service); if (t) throw t; }
export function breakerState(): Record<string, string> { return Object.fromEntries([...tripped].map(([k, v]) => [k, `tripped: HTTP ${v.status}`])); }
/** Tests only. */
export function resetGuards(): void { consecutive.clear(); tripped.clear(); }

export const TIMEOUTS = {
  llmMs: 90_000, whisperMs: 180_000, ttsMs: 90_000, uploadMs: 300_000, downloadMs: 600_000,
  produceMs: Number(process.env.PRODUCE_TIMEOUT_MIN || 12) * 60_000,
};

export async function fetchWithTimeout(url: string, init: RequestInit, ms: number, label = url): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  catch (e) { if ((e as Error).name === 'AbortError') throw new StageTimeoutError(label, ms); throw e; }
  finally { clearTimeout(t); }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new StageTimeoutError(label, ms)), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (t) clearTimeout(t); }
}
