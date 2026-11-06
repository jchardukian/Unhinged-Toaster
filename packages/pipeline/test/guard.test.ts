import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBudget, assertOpen, BudgetExceededError, FatalApiError, recordFailure, recordSuccess, resetGuards, setBudget, withTimeout } from '../src/guard.js';
import { recordLlm } from '../src/usage.js';
import { scoreCandidate } from '../src/steps/score.js';
import { runPreflight } from '../src/steps/preflight.js';
import type { Candidate } from '@toaster/shared';
import type { Config } from '../src/config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRootForTest = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const cfg = { llmProvider: 'openai', llmModel: 'gpt-4o-mini', openaiKey: 'k', visionOcrModel: 'gpt-4o', elevenKey: undefined, bufferKey: undefined, bufferOrgId: 'o'.repeat(24), bufferYoutubeChannelId: 'y'.repeat(24), bufferTiktokChannelId: 't'.repeat(24), apiUrl: undefined, apiToken: undefined, assetsDir: path.resolve(repoRootForTest(), 'assets'), templateDir: path.resolve(repoRootForTest(), 'template') } as unknown as Config;
const cand = { id: 'C1', source_platform: 'reddit', source_id: 's', source_url: 'https://www.reddit.com/r/funny/comments/s/x/', title: 'dog steals pizza', category: 'funny_animals', views: null, likes: 10, comments: null, shares: null, rights_status: 'transformation_review', status: 'discovered', discovered_at: new Date().toISOString(), updated_at: '' } as Candidate;

test('circuit breaker: two consecutive 400s trip the service; other statuses and successes reset it', () => {
  resetGuards();
  assert.equal(recordFailure('openai', 500, 'boom'), null);
  assert.equal(recordFailure('openai', 400, 'no model'), null);
  recordSuccess('openai');
  assert.equal(recordFailure('openai', 400, 'no model'), null, 'count restarted after a success');
  const fatal = recordFailure('openai', 400, 'no model');
  assert.ok(fatal instanceof FatalApiError);
  assert.throws(() => assertOpen('openai'), FatalApiError);
  assert.doesNotThrow(() => assertOpen('elevenlabs'));
  resetGuards();
});

test('budget: metered spend above API_BUDGET_USD throws before the next paid call', () => {
  setBudget(0.0001);
  recordLlm('gpt-4o', 100000, 0); // $0.25 at list price
  assert.throws(() => assertBudget('test'), BudgetExceededError);
  setBudget(100);
  assert.doesNotThrow(() => assertBudget('test'));
});

test('scoring: an LLM failure is never a score; the breaker stops the loop on the second persistent 400', async () => {
  resetGuards(); setBudget(100);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'you must provide a model parameter' } }), { status: 400 })) as typeof fetch;
  try {
    const first = await scoreCandidate(cfg, cand, [], null);
    assert.equal(first.status, 'discovered', 'stays discovered, not scored or rejected');
    assert.match(first.status_reason ?? '', /^llm_error: /);
    assert.equal(first.llm_score, null);
    await assert.rejects(() => scoreCandidate(cfg, cand, [], null), FatalApiError, 'second identical 400 aborts the run');
  } finally { globalThis.fetch = realFetch; resetGuards(); }
});

test('withTimeout rejects a stage that overruns', async () => {
  await assert.rejects(() => withTimeout(new Promise((r) => setTimeout(r, 200)), 20, 'slow stage'), /slow stage exceeded/);
  assert.equal(await withTimeout(Promise.resolve(7), 1000, 'fast'), 7);
});

test('preflight: reports each essential check and blocks on a failed scoring call, without printing secrets', async () => {
  resetGuards(); setBudget(100);
  const okScore = async () => ({ ...cand, llm_score: 70, status: 'scored' }) as Candidate;
  const badScore = async () => ({ ...cand, llm_score: null, status: 'discovered', status_reason: 'llm_error: OpenAI 400: no model' }) as Candidate;
  const fetchStub = (async (url: string) => {
    if (url.endsWith('/health')) return new Response('{"ok":true}', { status: 200 });
    if (url.includes('/candidates')) return new Response('[]', { status: 200 });
    if (url.includes('/media/')) return new Response('ok', { status: 200 });
    if (url.includes('elevenlabs')) return new Response('{"voices":[]}', { status: 200 });
    if (url.includes('reddit.com')) return new Response('<feed><entry></entry></feed>', { status: 200 });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  const cfgP = { ...cfg, apiUrl: 'https://toaster-api.example.workers.dev', apiToken: 'super-secret-token', bufferKey: 'buffer-secret-key' } as Config;
  const bufferClient = () => ({ account: async () => ({ id: 'a', timezone: 'America/Chicago', organizations: [{ id: 'o'.repeat(24), name: 'Org' }] }), channels: async () => [{ id: 'y'.repeat(24), name: 'YT', service: 'youtube' }, { id: 't'.repeat(24), name: 'TT', service: 'tiktok' }] });
  const good = await runPreflight(cfgP, 'production', { fetch: fetchStub, score: okScore, bufferClient });
  assert.equal(good.ok, true, good.markdown);
  assert.doesNotMatch(good.markdown, /super-secret-token|buffer-secret-key/);
  assert.match(good.markdown, /Buffer channels \| ✅/);
  const bad = await runPreflight(cfgP, 'production', { fetch: fetchStub, score: badScore, bufferClient });
  assert.equal(bad.ok, false);
  assert.match(bad.markdown, /OpenAI scoring call \| ❌/);
  // missing Buffer key blocks production but not a diagnostic
  const noBuf = { ...cfgP, bufferKey: undefined } as Config;
  assert.equal((await runPreflight(noBuf, 'production', { fetch: fetchStub, score: okScore })).ok, false);
  assert.equal((await runPreflight(noBuf, 'diagnostic', { fetch: fetchStub, score: okScore })).ok, true);
});
