import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTOPILOT_AUTHORIZATION_PHRASE, BufferClient, buildWeekPlan, type Candidate, type Decision, type Production } from '@toaster/shared';
import { captionOverlap, captionTimingIssues, editorialGate, parseIntervals, parseLufs, qcScore, score10 } from '../src/steps/qc.js';
import { calibrationReport, ownerVerdicts } from '../src/steps/calibration.js';
import { openSlotInstants, publishWeek } from '../src/steps/publish.js';
import { JsonStore } from '../src/store.js';
import type { Config } from '../src/config.js';

test('qc parsers: ffmpeg blackdetect / freezedetect / silencedetect / ebur128 output', () => {
  assert.deepEqual(parseIntervals('[blackdetect @ 0x1] black_start:0 black_end:0.52 black_duration:0.52\n', 'black'), [{ start: 0, end: 0.52 }]);
  assert.deepEqual(parseIntervals('[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 3.1\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 6.4\n', 'freeze'), [{ start: 3.1, end: 6.4 }]);
  assert.deepEqual(parseIntervals('[silencedetect @ 0x1] silence_start: 1\n[silencedetect @ 0x1] silence_end: 4.5 | silence_duration: 3.5\n', 'silence'), [{ start: 1, end: 4.5 }]);
  assert.equal(parseLufs('  Integrated loudness:\n    I:         -14.2 LUFS\n'), -14.2);
  assert.equal(parseLufs('nothing'), null);
});

test('qc pure rules: caption overlap, caption timing, editorial gate, score', () => {
  assert.equal(captionOverlap(['Okay', 'watch', 'this!'], ['okay', 'watch', 'this', 'now']), 1);
  assert.equal(captionOverlap(['dog', 'steals', 'pizza'], ['cat', 'sleeps']), 0);
  assert.deepEqual(captionTimingIssues([{ word: 'a', start: 0, end: 0.3 }, { word: 'b', start: 0.4, end: 0.9 }], 10), []);
  assert.match(captionTimingIssues([{ word: 'late', start: 9, end: 11 }], 10)[0], /past the end/);
  assert.match(captionTimingIssues([{ word: 'fuck', start: 0, end: 0.2 }], 10)[0], /profanity/);
  assert.match(captionTimingIssues([{ word: 'b', start: 2, end: 2.2 }, { word: 'a', start: 1, end: 1.2 }], 10)[0], /out of order/);
  const good = { hook: 8, payoff: 8, entertainment: 7, commentary: 7, storytelling: 8, editing: 6, us_fit: 8, works_muted: 7, natural_american_english: true, dialogue_dependent: false, onscreen_text_language: 'none', onscreen_text_essential: false, cultural_context_needed: false, defects: [], brand_visible: true, captions_readable: true, rationale: '' };
  assert.deepEqual(editorialGate(good), []);
  assert.equal(qcScore(good), 7.6);
  assert.equal(qcScore({ ...good, defects: ['cut_off_text'] }), 6.6);
  assert.match(editorialGate({ ...good, commentary: 3 })[0], /commentary adds little/);
  assert.deepEqual(editorialGate({ ...good, commentary: 3 }, 'none'), [], 'no commentary line to judge when the clip\'s own sound carries the ending');
  assert.match(editorialGate({ ...good, storytelling: 4 })[0], /storytelling/);
  assert.match(editorialGate({ ...good, editing: 2 })[0], /editing/);
  assert.match(editorialGate({ ...good, us_fit: 4 })[0], /U\.S\. audience/);
  assert.match(editorialGate({ ...good, natural_american_english: false })[0], /American English/);
  assert.equal(score10(true), -1, 'a boolean is not a score (it used to become 1)'); assert.equal(score10('8'), 8); assert.equal(score10(12), 10);
  assert.match(editorialGate({ ...good, us_fit: -1 })[0], /not scored/);
  assert.equal(editorialGate({ ...good, hook: 4 }).length, 1);
  assert.equal(editorialGate({ ...good, brand_visible: false, captions_readable: false, defects: ['black_frame'] }).length, 3);
  assert.equal(qcScore(null), null);
});

test('calibration: owner verdicts from Buffer states and readiness after a 30-video sample', () => {
  const mk = (i: number, ok: boolean, score: number, owner: 'approved' | 'rejected' | 'undecided'): { p: Production; posts: { production_id: string; state: string }[] } => ({
    p: { id: `P${i}`, candidate_id: `C${i}`, headline: `h${i}`, commentary: '', caption_text: '', hashtags: '[]', voice_id: null, music_track: null, r2_key: null, public_url: 'u', thumbnail_url: null, duration_sec: 10, render_log: null, qc_score: score, qc_json: JSON.stringify({ ok, score, checks: [] }), created_at: 't', updated_at: 't' },
    posts: owner === 'undecided' ? [{ production_id: `P${i}`, state: 'draft' }] : owner === 'approved' ? [{ production_id: `P${i}`, state: 'scheduled' }, { production_id: `P${i}`, state: 'sent' }] : [{ production_id: `P${i}`, state: 'deleted' }, { production_id: `P${i}`, state: 'deleted' }],
  });
  const rows: ReturnType<typeof mk>[] = [];
  for (let i = 0; i < 34; i++) rows.push(mk(i, i % 5 !== 0, i % 5 === 0 ? 4 : 7 + (i % 3), i < 30 ? (i % 5 === 0 || i % 11 === 0 ? 'rejected' : 'approved') : 'undecided'));
  const verdicts = ownerVerdicts(rows.flatMap((r) => r.posts) as never);
  assert.equal(verdicts.get('P0'), 'rejected'); assert.equal(verdicts.get('P1'), 'approved'); assert.equal(verdicts.get('P33'), 'undecided');
  const r = calibrationReport(rows.map((x) => x.p), rows.flatMap((x) => x.posts) as never, 7);
  assert.equal(r.decided, 30);
  assert.ok(r.precision != null && r.precision >= 0.85, `precision ${r.precision}`);
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.ok(r.recommendedMinQc != null);
  const small = calibrationReport(rows.slice(0, 10).map((x) => x.p), rows.slice(0, 10).flatMap((x) => x.posts) as never, 7);
  assert.equal(small.ready, false); assert.match(small.reasons[0], /of 30 owner-decided/);
});

// ---------------------------------------------------------------- unattended publishing end to end (fake Buffer)
class FakeBuffer {
  created: { saveToDraft: boolean; autopilot?: unknown; dueAt: string; channelId: string }[] = [];
  fetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> };
    if (body.query.includes('createPost(')) {
      const input = body.variables.input;
      this.created.push({ saveToDraft: input.saveToDraft, dueAt: input.dueAt, channelId: input.channelId });
      return json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: (this.created.length).toString(16).padStart(24, '0'), status: input.saveToDraft ? 'draft' : 'scheduled', dueAt: new Date(input.dueAt).toISOString() } } } });
    }
    if (body.query.includes('posts(')) return json({ data: { posts: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    throw new Error('unexpected ' + body.query.slice(0, 60));
  };
}
const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });

function cfg(): Config {
  return {
    llmProvider: 'openai', llmModel: 'x', visionOcrModel: 'x', openaiKey: undefined, anthropicKey: undefined, transcribeModel: 'w', elevenKey: undefined, elevenVoiceId: undefined, elevenModelId: 'x',
    bufferKey: 'k', bufferOrgId: 'o'.repeat(24), bufferYoutubeChannelId: 'y'.repeat(24), bufferTiktokChannelId: 't'.repeat(24), tz: 'America/Chicago', publishSlots: '11:00,15:00,19:00',
    approvalMode: 'draft', bufferTagReviewId: undefined, bufferTagClearedId: undefined, contactEmail: 'e@x', commentaryDefault: 'auto', allowLowQuality: false, musicDefault: 'auto', stickers: false,
    tiktokAccounts: [], ytdlpCookiesB64: undefined, ytdlpYoutubeClients: '', youtubeViralWindows: [], redditWindows: [], youtubeKey: undefined, enableYoutubeCc: false, enableYoutubeTransform: true,
    transformationReview: true, maxCopyrightRisk: 'medium', sources: undefined, reddit: { userAgent: 'x' }, pexelsKey: undefined, pixabayKey: undefined, r2: { bucket: 'b' }, apiUrl: undefined, apiToken: undefined,
    unattended: true, unattendedAuthorization: AUTOPILOT_AUTHORIZATION_PHRASE, emergencyStop: false, unattendedMinQc: 7, unattendedReviewDrafts: false,
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'toaster-auto-')), assetsDir: '', templateDir: '',
  };
}

test('unattended publishing schedules only documented-rights + QC-passed productions, drafts nothing else, logs every decision', async () => {
  const c = cfg();
  const store = new JsonStore(path.join(c.workDir, 'db.json'));
  const okQc = JSON.stringify({ ok: true, score: 8, checks: [] });
  const cands: Candidate[] = [
    { id: 'C1', source_platform: 'pixabay', source_id: 's1', source_url: 'https://pixabay.com/videos/1', title: 'cleared + qc ok', status: 'produced', rights_status: 'cleared', rights_basis: 'pixabay_license', rights_evidence: 'https://pixabay.com/service/license-summary/', copyright_risk: null, safety_flags: '[]', category: 'funny_animals', final_score: 80 } as Candidate,
    { id: 'C2', source_platform: 'reddit', source_id: 's2', source_url: 'https://www.reddit.com/r/funny/comments/s2/x/', title: 'viral but review path', status: 'produced', rights_status: 'transformation_review', rights_basis: null, rights_evidence: null, copyright_risk: 'low', safety_flags: '[]', category: 'people_fails', final_score: 95 } as Candidate,
    { id: 'C3', source_platform: 'pexels', source_id: 's3', source_url: 'https://www.pexels.com/video/3', title: 'cleared but qc failed', status: 'produced', rights_status: 'cleared', rights_basis: 'pexels_license', rights_evidence: 'https://www.pexels.com/license/', copyright_risk: null, safety_flags: '[]', category: 'funny_animals', final_score: 70 } as Candidate,
  ];
  await store.upsertCandidates(cands);
  const prod = (i: number, qc: string | null, score: number | null): Production => ({ id: `P${i}`, candidate_id: `C${i}`, headline: `H${i}`, commentary: 'c', caption_text: 'cap', hashtags: '["funny"]', voice_id: null, music_track: null, r2_key: `k${i}`, public_url: `https://media.example/${i}.mp4`, thumbnail_url: null, duration_sec: 10, render_log: null, reuse_basis: 'cleared', qc_json: qc, qc_score: score, created_at: `2026-11-0${i}T00:00:00Z`, updated_at: '' });
  await store.upsertProduction(prod(1, okQc, 8));
  await store.upsertProduction({ ...prod(2, okQc, 9), reuse_basis: 'review' });
  await store.upsertProduction(prod(3, JSON.stringify({ ok: false, score: 8, checks: [{ name: 'no_black_frames', ok: false, severity: 'block' }] }), 8));
  const fake = new FakeBuffer();
  const client = new BufferClient({ apiKey: 'k', fetchImpl: fake.fetch });
  const decisions: Decision[] = [];
  const now = () => new Date('2026-11-08T13:00:00Z');
  const r = await publishWeek(c, store, { client, now, weeks: ['next'], unattended: { active: true, minQc: 7, reviewDrafts: false, decide: async (d) => { const full = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', at: 'now', ...d } as Decision; decisions.push(full); return full; } } });
  assert.equal(fake.created.length, 2, 'the one eligible production is scheduled on YouTube and TikTok');
  assert.ok(fake.created.every((x) => x.saveToDraft === false), 'scheduled, not drafted');
  assert.equal(r.skipped, 2, 'review-path and QC-failed productions are skipped once each, before slot assignment');
  const kinds = decisions.map((d) => d.kind);
  assert.ok(kinds.filter((k) => k === 'schedule').length >= 2 && kinds.filter((k) => k === 'skip').length === 2, kinds.join(','));
  // the ineligible P2 has the highest score but must not burn the first slot: the eligible P1 takes it
  const firstSlot = buildWeekPlan(now(), c.tz, c.publishSlots, ['youtube', 'tiktok'], 1).slots.map((s) => s.slot_at).sort()[0];
  assert.ok((await store.listPosts({ state: ['scheduled'] })).every((p) => p.slot_at === firstSlot), 'eligible production fills the earliest slot');
  const skipReasons = decisions.filter((d) => d.kind === 'skip').map((d) => JSON.parse(d.reasons).join(' '));
  assert.ok(skipReasons.some((s) => /rights not documented/.test(s)) && skipReasons.some((s) => /QC failed/.test(s)));
  const posts = await store.listPosts({ state: ['scheduled'] });
  assert.equal(posts.length, 2); assert.ok(posts.every((p) => p.production_id === 'P1'));
  // without the authorization the same call must not schedule anything
  const fake2 = new FakeBuffer();
  const c2 = { ...c, unattendedAuthorization: 'no', workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'toaster-auto2-')) };
  const store2 = new JsonStore(path.join(c2.workDir, 'db.json'));
  await store2.upsertCandidates([cands[0]]); await store2.upsertProduction(prod(1, okQc, 8));
  const r2 = await publishWeek(c2, store2, { client: new BufferClient({ apiKey: 'k', fetchImpl: fake2.fetch }), now, weeks: ['next'], unattended: { active: true, minQc: 7, reviewDrafts: false, decide: async (d) => ({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', at: 'now', ...d }) as Decision } });
  assert.equal(fake2.created.length, 0, 'publish guard refuses without the phrase');
  assert.ok(r2.failed >= 1);
});

test('openSlotInstants counts open 11/3/7 instants this week and next; a live post closes its slot', async () => {
  const c = cfg();
  const store = new JsonStore(path.join(c.workDir, 'db.json'));
  const now = new Date('2026-11-09T12:00:00Z'); // Monday morning, Chicago
  const all = await openSlotInstants(c, store, { now, minLeadHours: 2 });
  assert.ok(all >= 39 && all <= 42, `two weeks of 3 slots/day minus the ones too close: ${all}`);
  const first = buildWeekPlan(now, c.tz, c.publishSlots, ['youtube', 'tiktok'], 0).slots.map((s) => s.slot_at).filter((t) => Date.parse(t) - now.getTime() >= 2 * 3600_000).sort()[0];
  for (const service of ['youtube', 'tiktok'] as const) {
    await store.upsertPost({ id: `P-${service}`, production_id: 'P1', candidate_id: 'C1', content_format: 'general_viral', service, buffer_channel_id: 'x', buffer_post_id: `b-${service}`, slot_at: first, batch_week: buildWeekPlan(now, c.tz, c.publishSlots, ['youtube', 'tiktok'], 0).week, state: 'scheduled', last_synced_at: null, buffer_error: null, views: null, likes: null, comments: null, shares: null, metrics_updated_at: null, created_at: '', updated_at: '', idempotency_key: `k-${service}`, create_attempts: 0, missing_count: 0, missing_since: null, sync_error: null } as never);
  }
  assert.equal(await openSlotInstants(c, store, { now, minLeadHours: 2 }), all - 1);
});
