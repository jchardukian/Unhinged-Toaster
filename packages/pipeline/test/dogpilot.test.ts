import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { creditText, initialRights } from '@toaster/shared';
import { assertVideoBudget, setVideoBudget, VideoBudgetExceededError } from '../src/guard.js';
import { currentUsage, recordVideoGen, recordVideoOutcome, costOf } from '../src/usage.js';
import { findGeminiVideo, GeminiProvider, makeProvider, MockProvider, RunwayProvider } from '../src/steps/aivideo.js';
import { commonsCandidate } from '../src/steps/discover.js';
import { buildPrompt, DOG_PREMISES } from '../src/steps/dogprompts.js';
import { judge, QUALITY_BAR } from '../src/steps/dogquality.js';
import { segmentSeconds, RANKING_MAX_SEC } from '../src/steps/ranking.js';
import { ensureSfxLibrary, planSfx, SFX_LIBRARY } from '../src/steps/sfx.js';
import type { Config } from '../src/config.js';

const cfg = {} as Config;

test('AI video budget is a hard cap checked with the next attempt included', () => {
  setVideoBudget(25);
  assert.doesNotThrow(() => assertVideoBudget(1.0));
  recordVideoGen('gemini', 12, 24.5, 'pending');
  assert.throws(() => assertVideoBudget(1.0), VideoBudgetExceededError, '24.5 + 1.0 > 25 must stop');
  assert.doesNotThrow(() => assertVideoBudget(0.4));
  recordVideoOutcome('gemini', 'rejected');
  const u = currentUsage();
  assert.equal(u.video_gen.gemini.attempts, 1); assert.equal(u.video_gen.gemini.rejected, 1); assert.equal(u.video_gen.gemini.usd, 24.5);
  assert.match(costOf(u).lines.join('\n'), /AI video gemini: 1 attempts \(0 accepted, 1 rejected\)/);
  setVideoBudget(1000);
});

test('published provider rates: Gemini ≈ $0.07/s; Runway kling_4_flash 9.4 cr/s with a 29-credit minimum; gen4.5 12 cr/s; mock is free', () => {
  const g = new GeminiProvider(cfg, 'gemini-omni-1.2-flash');
  assert.ok(Math.abs(g.estimateUsd(10) - 0.695) < 0.01);
  const k = new RunwayProvider(cfg, 'kling_4_flash');
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  assert.ok(close(k.estimateUsd(2), 0.29), 'minimum 29 credits');
  assert.ok(close(k.estimateUsd(5), 0.47), 'docs example: 5 s = 47 credits');
  assert.ok(close(new RunwayProvider(cfg, 'gen4.5').estimateUsd(10), 1.2));
  assert.equal(new MockProvider().estimateUsd(), 0);
});

test('Gemini response parsing finds the video in steps or output_video', () => {
  assert.deepEqual(findGeminiVideo({ steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: 'AAAA' }] }] }), { data: 'AAAA', uri: undefined });
  assert.deepEqual(findGeminiVideo({ output_video: { uri: 'files/abc' } }), { uri: 'files/abc' });
  assert.equal(findGeminiVideo({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text' }] }] }), null);
});

test('dog prompts: 20 premises, every prompt carries the realism constraints and a 3-beat structure, 10–12 s', () => {
  assert.equal(DOG_PREMISES.length, 20);
  for (const p of DOG_PREMISES) {
    const prompt = buildPrompt(p);
    assert.match(prompt, /real dog anatomy/); assert.match(prompt, /no text/); assert.match(prompt, /vertical 9:16/); assert.match(prompt, /no cartoon/);
    assert.ok(prompt.includes(p.hook) && prompt.includes(p.escalation) && prompt.includes(p.payoff));
    assert.ok(p.seconds >= 10 && p.seconds <= 12);
  }
  assert.equal(new Set(DOG_PREMISES.map((p) => p.id)).size, 20);
});

test('quality gate: every realism criterion must clear its bar; non-dogs are rejected with reasons', () => {
  const good = { realistic_anatomy: 9, believable_motion: 8, natural_lighting: 8, no_artifacts: 8, hook_2s: 7, payoff: 8, sfx_fit: 6, is_dog: true, notes: '' };
  assert.equal(judge(good).accepted, true);
  const bad = judge({ ...good, no_artifacts: 5, is_dog: true });
  assert.equal(bad.accepted, false); assert.deepEqual(bad.reasons, [`no_artifacts 5 < ${QUALITY_BAR.no_artifacts}`]);
  const notDog = judge({ ...good, is_dog: false });
  assert.equal(notDog.accepted, false); assert.match(notDog.reasons[0], /no real-looking dog/);
  const nan = judge({ ...good, hook_2s: Number.NaN });
  assert.equal(nan.accepted, false); assert.match(nan.reasons[0], /hook_2s \? </);
});

test('rights and credits: AI footage is cleared with provider evidence and disclosed; rankings credit every licensed clip', () => {
  const r = initialRights('ai_generated', { evidenceSuffix: 'gemini/gemini-omni-1.2-flash job abc on 2026-11-07' });
  assert.equal(r.rights_status, 'cleared'); assert.equal(r.rights_basis, 'ai_generated'); assert.match(r.rights_evidence ?? '', /job abc/);
  const ai = creditText({ author: null, source_url: 'ai://gemini/x', rights_basis: 'ai_generated', source_platform: 'ai_generated' });
  assert.match(ai, /AI-generated/); assert.match(ai, /No real dog was filmed/); assert.match(ai, /theunhingedtoaster@gmail\.com/); assert.doesNotMatch(ai, /Original clip/);
  const ranking = creditText({ author: null, source_url: 'ranking://1', rights_basis: 'licensed', source_platform: 'manual', meta_json: JSON.stringify({ clips: [{ candidate_id: 'a', source_url: 'https://www.pexels.com/video/1/', author: 'Ann', license: 'pexels_license', platform: 'pexels' }, { candidate_id: 'b', source_url: 'https://pixabay.com/videos/2/', author: null, license: 'pixabay_license', platform: 'pixabay' }] }) });
  assert.match(ranking, /Clips in this ranking/); assert.match(ranking, /2\. Ann — https:\/\/www\.pexels\.com\/video\/1\/ \(pexels_license\)/); assert.match(ranking, /1\. https:\/\/pixabay\.com\/videos\/2\//);
});

test('ranking segment length keeps 3–5 clips under 40 s with 4–9 s each', () => {
  assert.equal(segmentSeconds(3), 9); assert.equal(segmentSeconds(5), 7);
  for (const n of [3, 4, 5]) assert.ok(segmentSeconds(n) * n <= RANKING_MAX_SEC);
});

test('sfx: placeholders stay in the work dir and cues land on real beats of the edited timeline', async () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toaster-sfx-'));
  const c = { assetsDir, workDir: path.join(assetsDir, 'work') } as Config;
  process.env.SFX_PROVIDER = 'synth';
  let hasFfmpeg = true;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }
  if (hasFfmpeg) {
    const first = await ensureSfxLibrary(c, 'synth');
    assert.equal(first.created, SFX_LIBRARY.length);
    const second = await ensureSfxLibrary(c, 'synth');
    assert.equal(second.created, 0, 'idempotent');
  } else {
    // CI's unit-test job has no ffmpeg: write the manifest the synthesiser would have written
    const dir = path.join(c.workDir, 'sfx'); fs.mkdirSync(dir, { recursive: true });
    for (const e of SFX_LIBRARY) fs.writeFileSync(path.join(dir, `${e.name}.mp3`), '');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ effects: SFX_LIBRARY.map((e) => ({ name: e.name, file: `${e.name}.mp3`, license: 'synthesised placeholder', source: 'synth' })) }));
  }
  assert.ok(!fs.existsSync(path.join(assetsDir, 'sfx')), 'placeholders never land in assets/');
  assert.ok(fs.existsSync(path.join(c.workDir, 'sfx', 'manifest.json')));
  const cues = planSfx(c, { freeze: { at: 4.0, duration: 0.7, text: 'WAIT' }, punchIn: { at: 4.7, zoom: 1.1, duration: 2 }, replay: { from: 4.2, to: 5.0, speed: 0.5 }, sticker: null, muteSource: false } as never, (t) => t + 0.7, { category: 'funny_animals' });
  const names = cues.map((x) => path.basename(x.path, '.mp3'));
  assert.deepEqual(names, ['record_scratch', 'boing', 'whoosh']);
  assert.ok(cues.every((x) => x.at >= 0));
  assert.equal(planSfx(c, { freeze: null, punchIn: null, replay: null, sticker: null, muteSource: false } as never, (t) => t).length, 0, 'no beats, no effects');
  delete process.env.SFX_PROVIDER;
  assert.equal(planSfx(c, { freeze: { at: 1, duration: 0.7, text: 'X' }, punchIn: null, replay: null, sticker: null, muteSource: false } as never, (t) => t).length, 0, 'without SFX_PROVIDER=synth the placeholders are ignored');
});

test('paid AI generation is paused by default: a paid provider refuses to start at a $0 cap; mock still works', () => {
  setVideoBudget(0);
  assert.throws(() => makeProvider(cfg, 'gemini'), /paused/);
  assert.throws(() => makeProvider(cfg, 'runway'), /paused/);
  assert.doesNotThrow(() => makeProvider(cfg, 'mock'));
  setVideoBudget(1000);
});

test('Wikimedia Commons: only CC0 / public domain / CC BY videos become cleared candidates; SA/NC/ND and non-video are skipped', () => {
  const now = '2026-11-07T00:00:00Z';
  const page = (license: string, mime = 'video/webm', duration = 12) => ({ title: 'File:Dog_jumps_into_leaves.webm', pageid: 42, imageinfo: [{ url: 'https://upload.wikimedia.org/x/Dog_jumps_into_leaves.webm', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Dog_jumps_into_leaves.webm', mime, width: 1280, height: 720, duration, extmetadata: { LicenseShortName: { value: license }, Artist: { value: '<a href="x">Jane Doe</a>' }, ImageDescription: { value: 'A dog <b>jumps</b>' } } }] });
  const by = commonsCandidate(page('CC BY 4.0'), now)!;
  assert.equal(by.rights_status, 'cleared'); assert.equal(by.rights_basis, 'cc_by'); assert.equal(by.author, 'Jane Doe'); assert.equal(by.source_platform, 'wikimedia_commons'); assert.equal(by.title, 'Dog jumps into leaves'); assert.equal(by.duration_sec, 12);
  assert.equal(commonsCandidate(page('CC0'), now)!.rights_basis, 'cc0');
  assert.equal(commonsCandidate(page('Public domain'), now)!.rights_basis, 'public_domain');
  assert.equal(commonsCandidate(page('CC BY-SA 4.0'), now), null, 'share-alike is not used');
  assert.equal(commonsCandidate(page('CC BY-NC 2.0'), now), null);
  assert.equal(commonsCandidate(page('CC BY 4.0', 'image/jpeg'), now), null, 'not a video');
  assert.equal(commonsCandidate(page('CC BY 4.0', 'video/webm', 200), now), null, 'too long');
  const credit = creditText({ author: 'Jane Doe', source_url: by.source_url, rights_basis: 'cc_by', source_platform: 'wikimedia_commons' });
  assert.match(credit, /Jane Doe/); assert.match(credit, /Creative Commons Attribution/);
});
