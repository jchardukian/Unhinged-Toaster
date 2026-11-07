import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heuristicScore, llmScore, finalScore, reachScore, updateCategoryWeights, defaultCategoryWeights, MIN_FINAL_SCORE } from '../src/scoring.js';

const now = '2026-11-02T12:00:00Z';

test('heuristicScore rewards fast-moving, well-shaped clips', () => {
  const viral = heuristicScore({ views: 2_000_000, likes: 150_000, comments: 4_000, shares: 9_000, published_at: '2026-11-02T00:00:00Z', discovered_at: now, duration_sec: 14, width: 1080, height: 1920 });
  const dud = heuristicScore({ views: 900, likes: 12, comments: 1, shares: 0, published_at: '2026-10-20T00:00:00Z', discovered_at: now, duration_sec: 95, width: 1920, height: 1080 });
  assert.ok(viral > 75, `viral=${viral}`);
  assert.ok(dud < 30, `dud=${dud}`);
  assert.ok(viral > dud);
});

test('heuristicScore prioritises verified reach: 1M+ views outrank 100k at equal engagement; Reddit (no views) is unchanged', () => {
  const base = { likes: 20_000, comments: 300, shares: 200, published_at: '2026-11-01T00:00:00Z', discovered_at: now, duration_sec: 14, width: 1080, height: 1920 };
  const million = heuristicScore({ ...base, views: 1_500_000 });
  const hundredK = heuristicScore({ ...base, views: 100_000 });
  const tenK = heuristicScore({ ...base, views: 10_000 });
  assert.ok(million > hundredK && hundredK > tenK, `${million} > ${hundredK} > ${tenK}`);
  assert.equal(reachScore(10_000), 0); assert.equal(reachScore(100_000), 50); assert.equal(reachScore(1_000_000), 100); assert.equal(reachScore(50_000_000), 100);
  const reddit = heuristicScore({ ...base, views: null });
  assert.equal(reddit, heuristicScore({ ...base, views: null }), 'deterministic');
  assert.ok(reddit > 0);
});

test('heuristicScore tolerates missing fields', () => {
  const s = heuristicScore({ views: null, likes: null, comments: null, shares: null, published_at: null, discovered_at: now, duration_sec: null, width: null, height: null });
  assert.ok(s >= 0 && s <= 100);
});

test('llmScore hard-blocks unsafe content and penalises soft flags', () => {
  const base = { entertainment: 9, surprise: 8, clarity: 9, brand_fit: 9, rewatchability: 8, category: 'people_fails' as const, rationale: '' };
  assert.equal(llmScore({ ...base, safety_flags: [] }).score, 86.5);
  assert.equal(llmScore({ ...base, safety_flags: ['nsfw'] }).blocked, true);
  assert.equal(llmScore({ ...base, safety_flags: ['copyrighted_music'] }).score, 80.5);
});

test('finalScore applies category weights and threshold is sane', () => {
  const w = [{ category: 'funny_animals' as const, weight: 1.2 }];
  assert.equal(finalScore(70, 70, 'funny_animals', w), 84);
  assert.equal(finalScore(70, 70, 'unbelievable', w), 70);
  assert.ok(MIN_FINAL_SCORE > 50 && MIN_FINAL_SCORE < 80);
});

test('updateCategoryWeights moves toward observed performance and clamps', () => {
  const weights = defaultCategoryWeights(now);
  const next = updateCategoryWeights(weights, [
    { category: 'funny_animals', views: 50_000 },
    { category: 'funny_animals', views: 70_000 },
    { category: 'people_fails', views: 5_000 },
  ], now, 1);
  const animals = next.find((x) => x.category === 'funny_animals')!;
  const fails = next.find((x) => x.category === 'people_fails')!;
  assert.ok(animals.weight > 1 && animals.weight <= 1.6);
  assert.ok(fails.weight < 1 && fails.weight >= 0.6);
  assert.equal(next.find((x) => x.category === 'unbelievable')!.weight, 1);
  assert.equal(animals.samples, 2);
});
