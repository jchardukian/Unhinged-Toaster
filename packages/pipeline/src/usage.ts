import fs from 'node:fs';
import path from 'node:path';

/**
 * Measured usage meter: every paid call records what it consumed so the funnel report can state real per-video
 * costs instead of guesses. Counters live in memory for the run and are appended to <WORK_DIR>/usage.jsonl.
 * Prices are public list prices (USD) at the time of writing; override with USAGE_PRICES_JSON if they change.
 */
export interface Usage {
  llm: Record<string, { calls: number; prompt_tokens: number; completion_tokens: number }>;
  whisper_seconds: number;
  tts_chars: number;
  tts_calls: number;
  render_seconds: number;
  renders: number;
  upload_bytes: number;
  started_at: string;
}

const PRICES: Record<string, { in: number; out: number }> = {
  // per 1M tokens
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
  'gpt-4o': { in: 2.50, out: 10.00 },
  'gpt-4.1-mini': { in: 0.40, out: 1.60 },
  'claude-haiku-5-5': { in: 1.00, out: 5.00 },
  'claude-sonnet-5-5': { in: 3.00, out: 15.00 },
};
const WHISPER_PER_MIN = 0.006;
const TTS_PER_1K_CHARS = 0.30; // ElevenLabs Creator plan: $22 for 100k credits ≈ $0.22/1k; Starter $5/30k ≈ $0.17/1k; 0.30 covers overage pricing
const R2_PER_GB_MONTH = 0.015;

const usage: Usage = { llm: {}, whisper_seconds: 0, tts_chars: 0, tts_calls: 0, render_seconds: 0, renders: 0, upload_bytes: 0, started_at: new Date().toISOString() };

export function recordLlm(model: string, promptTokens: number, completionTokens: number): void {
  const m = (usage.llm[model] ??= { calls: 0, prompt_tokens: 0, completion_tokens: 0 });
  m.calls++; m.prompt_tokens += promptTokens; m.completion_tokens += completionTokens;
}
export function recordWhisper(seconds: number): void { usage.whisper_seconds += Math.max(0, seconds); }
export function recordTts(chars: number): void { usage.tts_chars += chars; usage.tts_calls++; }
export function recordRender(seconds: number): void { usage.render_seconds += seconds; usage.renders++; }
export function recordUpload(bytes: number): void { usage.upload_bytes += bytes; }
export function currentUsage(): Usage { return JSON.parse(JSON.stringify(usage)) as Usage; }

function prices(): Record<string, { in: number; out: number }> {
  try { return { ...PRICES, ...(process.env.USAGE_PRICES_JSON ? (JSON.parse(process.env.USAGE_PRICES_JSON) as Record<string, { in: number; out: number }>) : {}) }; } catch { return PRICES; }
}

export function priceFor(model: string): { in: number; out: number } {
  const p = prices();
  return p[model] ?? p[Object.keys(p).find((k) => model.startsWith(k)) ?? ''] ?? { in: 2.5, out: 10 }; // unknown model: price as gpt-4o (conservative)
}

export interface UsageCost { llm_usd: number; whisper_usd: number; tts_usd: number; storage_usd_per_month: number; total_usd: number; lines: string[] }

export function costOf(u: Usage): UsageCost {
  const lines: string[] = [];
  let llm = 0;
  for (const [model, m] of Object.entries(u.llm)) {
    const p = priceFor(model);
    const usd = (m.prompt_tokens * p.in + m.completion_tokens * p.out) / 1e6;
    llm += usd;
    lines.push(`LLM ${model}: ${m.calls} calls, ${m.prompt_tokens} in / ${m.completion_tokens} out tokens = $${usd.toFixed(4)}`);
  }
  const whisper = (u.whisper_seconds / 60) * WHISPER_PER_MIN;
  if (u.whisper_seconds) lines.push(`Whisper: ${(u.whisper_seconds / 60).toFixed(1)} min = $${whisper.toFixed(4)}`);
  const tts = (u.tts_chars / 1000) * TTS_PER_1K_CHARS;
  if (u.tts_calls) lines.push(`ElevenLabs: ${u.tts_calls} lines, ${u.tts_chars} chars ≈ $${tts.toFixed(4)} (plan-dependent; $${TTS_PER_1K_CHARS}/1k assumed)`);
  const storage = (u.upload_bytes / 1e9) * R2_PER_GB_MONTH;
  if (u.renders) lines.push(`Render: ${u.renders} videos, ${(u.render_seconds / 60).toFixed(1)} CPU-min (GitHub Actions minutes; free for public repos, 2 000/month free for private)`);
  if (u.upload_bytes) lines.push(`Storage: ${(u.upload_bytes / 1e6).toFixed(1)} MB uploaded ≈ $${storage.toFixed(4)}/month on R2 (10 GB free)`);
  return { llm_usd: llm, whisper_usd: whisper, tts_usd: tts, storage_usd_per_month: storage, total_usd: llm + whisper + tts, lines };
}

/** Append this run's counters to <workDir>/usage.jsonl (one JSON line per run) and return the summary lines. */
export function flushUsage(workDir: string, label: string): string[] {
  const c = costOf(usage);
  const hasAny = Object.keys(usage.llm).length || usage.whisper_seconds || usage.tts_calls || usage.renders || usage.upload_bytes;
  if (hasAny) {
    try {
      fs.mkdirSync(workDir, { recursive: true });
      fs.appendFileSync(path.join(workDir, 'usage.jsonl'), JSON.stringify({ label, ended_at: new Date().toISOString(), ...usage, cost: { llm_usd: c.llm_usd, whisper_usd: c.whisper_usd, tts_usd: c.tts_usd, total_usd: c.total_usd } }) + '\n');
    } catch { /* usage logging must never break a run */ }
  }
  return [...c.lines, `Total API cost this run: $${c.total_usd.toFixed(4)}`];
}

/** Sum every run recorded in usage.jsonl (for the funnel report). */
export function readUsageLog(workDir: string): Usage[] {
  const f = path.join(workDir, 'usage.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Usage; } catch { return null; } }).filter((x): x is Usage => !!x);
}

export function sumUsage(list: Usage[]): Usage {
  const out: Usage = { llm: {}, whisper_seconds: 0, tts_chars: 0, tts_calls: 0, render_seconds: 0, renders: 0, upload_bytes: 0, started_at: list[0]?.started_at ?? new Date().toISOString() };
  for (const u of list) {
    for (const [m, v] of Object.entries(u.llm ?? {})) { const t = (out.llm[m] ??= { calls: 0, prompt_tokens: 0, completion_tokens: 0 }); t.calls += v.calls; t.prompt_tokens += v.prompt_tokens; t.completion_tokens += v.completion_tokens; }
    out.whisper_seconds += u.whisper_seconds ?? 0; out.tts_chars += u.tts_chars ?? 0; out.tts_calls += u.tts_calls ?? 0;
    out.render_seconds += u.render_seconds ?? 0; out.renders += u.renders ?? 0; out.upload_bytes += u.upload_bytes ?? 0;
  }
  return out;
}
