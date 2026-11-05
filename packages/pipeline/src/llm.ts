import type { Config } from './config.js';
import { recordLlm } from './usage.js';

/**
 * Tiny JSON-mode chat wrapper for OpenAI or Anthropic. Returns parsed JSON or throws.
 * Both providers are reached with plain fetch so the pipeline has no SDK dependency.
 */
export interface ChatOpts { maxTokens?: number; temperature?: number; imageJpegBase64?: string }

export async function chatJson<T>(cfg: Config, system: string, user: string, opts: ChatOpts = {}): Promise<T> {
  const text = cfg.llmProvider === 'anthropic' ? await anthropic(cfg, system, user, opts) : await openai(cfg, system, user, opts);
  return parseJson<T>(text);
}

async function openai(cfg: Config, system: string, user: string, opts: ChatOpts): Promise<string> {
  const content: unknown = opts.imageJpegBase64
    ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${opts.imageJpegBase64}`, detail: 'high' } }]
    : user;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.openaiKey ?? 'proxy-injected'}` },
    body: JSON.stringify({
      model: cfg.llmModel,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 600,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  recordLlm(cfg.llmModel, j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0);
  return j.choices[0].message.content;
}

async function anthropic(cfg: Config, system: string, user: string, opts: ChatOpts): Promise<string> {
  const userContent: unknown = opts.imageJpegBase64
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: opts.imageJpegBase64 } }, { type: 'text', text: user }]
    : user;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.anthropicKey ?? '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: cfg.llmModel,
      max_tokens: opts.maxTokens ?? 600,
      temperature: opts.temperature ?? 0.7,
      system: `${system}\nRespond with a single JSON object and nothing else.`,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { content: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  recordLlm(cfg.llmModel, j.usage?.input_tokens ?? 0, j.usage?.output_tokens ?? 0);
  return j.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
}

export function parseJson<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
    throw new Error(`LLM did not return JSON: ${trimmed.slice(0, 200)}`);
  }
}
