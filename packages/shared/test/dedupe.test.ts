import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseUrl, phashFrame, hamming, videoHashDistance, titleSimilarity, findDuplicate } from '../src/dedupe.js';

function gradient(seed = 0): Uint8Array {
  const px = new Uint8Array(1024);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) px[y * 32 + x] = Math.min(255, Math.floor(((x + seed) * 8 + y * 2) % 256));
  return px;
}
function checker(): Uint8Array {
  const px = new Uint8Array(1024);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) px[y * 32 + x] = ((x >> 2) + (y >> 2)) % 2 ? 255 : 0;
  return px;
}

test('normaliseUrl canonicalises reddit and youtube links', () => {
  assert.equal(normaliseUrl('https://www.reddit.com/r/Unexpected/comments/1abc2d/some_slug/?utm_source=share'), 'https://reddit.com/r/unexpected/comments/1abc2d');
  assert.equal(normaliseUrl('https://old.reddit.com/r/unexpected/comments/1ABC2D/'), 'https://reddit.com/r/unexpected/comments/1abc2d');
  assert.equal(normaliseUrl('https://youtu.be/dQw4w9WgXcQ?si=xyz'), normaliseUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share'));
});

test('phash is stable under small brightness change and far for different images', () => {
  const a = phashFrame(gradient());
  const brighter = gradient().map((v) => Math.min(255, v + 12));
  const b = phashFrame(Uint8Array.from(brighter));
  const c = phashFrame(checker());
  assert.equal(a.length, 16);
  assert.equal(hamming(a, a), 0);
  assert.ok(hamming(a, b) <= 6, `brightness drift distance ${hamming(a, b)}`);
  assert.ok(hamming(a, c) > 16, `different images distance ${hamming(a, c)}`);
});

test('videoHashDistance tolerates one-frame offset', () => {
  const f1 = phashFrame(gradient(0)), f2 = phashFrame(gradient(40)), f3 = phashFrame(checker());
  assert.equal(videoHashDistance(`${f1}:${f2}:${f3}`, `${f1}:${f2}:${f3}`), 0);
  const shifted = videoHashDistance(`${f1}:${f2}:${f3}`, `${f2}:${f3}:${f1}`);
  assert.ok(shifted < videoHashDistance(`${f1}:${f1}:${f1}`, `${f3}:${f3}:${f3}`));
});

test('titleSimilarity and findDuplicate', () => {
  assert.ok(titleSimilarity('Dog steals pizza off counter', 'Dog steals pizza off the counter') > 0.75);
  assert.ok(titleSimilarity('Dog steals pizza', 'Grandma wins lottery') < 0.2);
  const existing = [{ id: 'A', source_url: 'https://www.reddit.com/r/funny/comments/zz9/dog/', phash: phashFrame(gradient()), title: 'Dog steals pizza off counter', duration_sec: 12 }];
  assert.deepEqual(findDuplicate({ source_url: 'https://reddit.com/r/funny/comments/zz9', phash: null, title: 'x', duration_sec: null }, existing)?.id, 'A');
  assert.equal(findDuplicate({ source_url: 'https://youtube.com/watch?v=abc', phash: phashFrame(gradient()), title: 'other', duration_sec: 30 }, existing)?.reason.startsWith('phash'), true);
  assert.equal(findDuplicate({ source_url: 'https://youtube.com/watch?v=abc', phash: phashFrame(checker()), title: 'Dog steals pizza off the counter', duration_sec: 12.5 }, existing)?.reason.startsWith('title_sim'), true);
  assert.equal(findDuplicate({ source_url: 'https://youtube.com/watch?v=abc', phash: phashFrame(checker()), title: 'Cat falls in bath', duration_sec: 8 }, existing), null);
});
