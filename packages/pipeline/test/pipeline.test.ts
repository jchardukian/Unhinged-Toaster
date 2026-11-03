import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAss, assColor } from '../src/steps/captions.js';
import { validate, fallback } from '../src/steps/copy.js';
import { isoDurationSec, parseRedditCandidate } from '../src/steps/discover.js';
import { postText } from '../src/steps/publish.js';
import { JsonStore } from '../src/store.js';
import { parseJson } from '../src/llm.js';
import type { Candidate, Production } from '@toaster/shared';

test('buildAss chunks words and emits karaoke tags', () => {
  const words = [
    { word: 'Okay', start: 0.1, end: 0.4 }, { word: 'watch', start: 0.45, end: 0.7 }, { word: 'this', start: 0.72, end: 0.9 },
    { word: 'the', start: 1.3, end: 1.4 }, { word: 'dog', start: 1.45, end: 1.8 },
  ];
  const ass = buildAss(words, { fontName: 'Bangers', fontSize: 66, marginV: 700, primary: assColor('#FFD400'), secondary: assColor('#FFFFFF'), outline: assColor('#111111'), playResX: 1080, playResY: 1920 });
  const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\{\\kf30\}OKAY \{\\kf25\}WATCH \{\\kf18\}THIS/);
  assert.match(lines[0], /^Dialogue: 0,0:00:00\.10,0:00:00\.98,Toast/);
  assert.match(ass, /PrimaryColour.*\n.*&H0000D4FF/);
});

test('assColor converts RGB hex to ASS BGR', () => {
  assert.equal(assColor('#FFD400'), '&H0000D4FF');
  assert.equal(assColor('#111111', 0x80), '&H80111111');
});

test('copy validation enforces limits and falls back', () => {
  assert.equal(validate({ headline: 'x'.repeat(61), commentary: 'ok.', caption: '', hashtags: [] }), null);
  assert.equal(validate({ headline: 'Fine', commentary: 'Two. Sentences.', caption: '', hashtags: [] }), null);
  const ok = validate({ headline: '"Wait" for it', commentary: 'This dog just robbed a pizzeria and I respect it!', caption: 'c', hashtags: ['#Funny', 'dogs'] });
  assert.equal(ok?.headline, 'Wait for it');
  assert.deepEqual(ok?.hashtags, ['Funny', 'dogs']);
  const fb = fallback({ category: 'funny_animals' } as Candidate);
  assert.ok(fb.headline.length <= 60 && fb.commentary.length <= 110);
});

test('isoDurationSec and reddit parsing', () => {
  assert.equal(isoDurationSec('PT1M5S'), 65);
  assert.equal(isoDurationSec('PT45S'), 45);
  const rv = { fallback_url: 'https://v.redd.it/abc/DASH_720.mp4?source=fallback', duration: 12, width: 720, height: 1280 };
  const post = { id: 'x1', title: 'Cat vs cucumber', author: 'someone', permalink: '/r/funny/comments/x1/cat_vs_cucumber/', url: '', created_utc: 1762000000, score: 5400, upvote_ratio: 0.97, num_comments: 120, over_18: false, is_video: true, subreddit: 'funny' } as any;
  const c = parseRedditCandidate(post, post, rv, 'funny_animals', '2026-11-02T00:00:00Z');
  assert.equal(c.rights_status, 'unknown');
  assert.equal(c.source_url, 'https://www.reddit.com/r/funny/comments/x1/cat_vs_cucumber/');
  assert.equal(c.likes, 5400);
  assert.equal(c.status, 'discovered');
});

test('postText adds hashtags, attribution and AI disclosure within limits', () => {
  const p: Production = { id: 'p', candidate_id: 'c', headline: 'H', commentary: 'C', caption_text: 'Caption.\n\nOriginal video by @x (https://y), used under CC BY.', hashtags: JSON.stringify(['funny', 'dogs']), voice_id: null, music_track: null, r2_key: null, public_url: null, thumbnail_url: null, duration_sec: 10, render_log: null, created_at: '', updated_at: '' };
  const t = postText(p, 'tiktok', true);
  assert.match(t, /#funny #dogs/);
  assert.match(t, /CC BY/);
  assert.match(t, /AI-generated/);
  assert.ok(t.length <= 2100);
});

test('JsonStore round-trips candidates, patches, posts and weights', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toaster-'));
  const s = new JsonStore(path.join(dir, 'db.json'));
  const c = { id: 'A', source_platform: 'reddit', source_id: 'r1', source_url: 'https://reddit.com/r/x/comments/r1', title: 't', status: 'discovered', rights_status: 'unknown', updated_at: '', discovered_at: '' } as Candidate;
  await s.upsertCandidates([c]);
  await s.upsertCandidates([{ ...c, id: 'B', title: 'renamed' }]); // same source id -> update, keep id
  const all = await s.listCandidates();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'A');
  assert.equal(all[0].title, 'renamed');
  await s.patchCandidate('A', { status: 'scored', final_score: 70 });
  assert.equal((await s.listCandidates({ status: ['scored'] })).length, 1);
  const w = await s.weights();
  assert.equal(w.length, 4);
  const s2 = new JsonStore(path.join(dir, 'db.json'));
  assert.equal((await s2.getCandidate('A'))?.final_score, 70);
});

test('parseJson tolerates code fences and prose', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure! {"a":2} hope that helps'), { a: 2 });
});
