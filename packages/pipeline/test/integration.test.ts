/**
 * Mocked approval-to-scheduling workflow: a fake Buffer GraphQL server + the real BufferClient, publishWeek and syncBuffer,
 * backed by the JSON store. Exercises: draft creation (always drafts), idempotent re-runs, adoption of posts created by a
 * timed-out request, per-service approval/rejection independence, pinning of approved posts, transient-failure safety,
 * confirmed rejection -> replacement into the same slot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BufferClient, buildWeekPlan, REVIEW_BLOCK_START, type Candidate, type Production } from '@toaster/shared';
import type { Config } from '../src/config.js';
import { JsonStore } from '../src/store.js';
import { publishWeek } from '../src/steps/publish.js';
import { syncBuffer } from '../src/steps/sync.js';
import { readinessReport } from '../src/steps/report.js';

// ---------------------------------------------------------------- fake Buffer
interface FakePost { id: string; status: string; text: string; dueAt: string | null; channelId: string; tagIds?: string[]; error?: { message: string } | null }
class FakeBuffer {
  posts = new Map<string, FakePost>();
  createCalls = 0;
  editCalls: { id: string; dueAt?: string; text?: string }[] = [];
  failNextCreateWithTimeoutButCreate = false;
  down = false;
  private seq = 0;
  fetch: typeof fetch = async (_url, init) => {
    if (this.down) return new Response('bad gateway', { status: 502 });
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> };
    const q = body.query;
    if (q.includes('createPost(')) {
      const input = body.variables.input;
      assert.equal(input.saveToDraft, true, 'pipeline must only create drafts');
      assert.equal(input.mode, 'customScheduled');
      this.createCalls++;
      const id = (++this.seq).toString(16).padStart(24, '0');
      const dueAt = new Date(input.dueAt).toISOString();
      this.posts.set(id, { id, status: 'draft', text: input.text, dueAt, channelId: input.channelId, tagIds: input.tagIds });
      if (this.failNextCreateWithTimeoutButCreate) { this.failNextCreateWithTimeoutButCreate = false; return new Response('gateway timeout', { status: 504 }); }
      return json({ data: { createPost: { __typename: 'PostActionSuccess', post: this.posts.get(id) } } });
    }
    if (q.includes('editPost(')) {
      const { id, dueAt, text } = body.variables.input;
      const p = this.posts.get(id)!;
      if (dueAt !== undefined) p.dueAt = new Date(dueAt).toISOString();
      if (text !== undefined) p.text = text;
      this.editCalls.push({ id, dueAt, text });
      return json({ data: { editPost: { __typename: 'PostActionSuccess', post: p } } });
    }
    if (q.includes('posts(input:')) {
      const f = body.variables.input.filter ?? {};
      const list = [...this.posts.values()].filter((p) => (!f.channelIds || f.channelIds.includes(p.channelId)) && (!f.status || f.status.includes(p.status))
        && (!f.dueAt?.start || (p.dueAt && p.dueAt >= f.dueAt.start)) && (!f.dueAt?.end || (p.dueAt && p.dueAt <= f.dueAt.end)));
      return json({ data: { posts: { edges: list.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (/p\d+: post\(input:/.test(q)) {
      const data: Record<string, FakePost | null> = {};
      const errors: { message: string; path: string[] }[] = [];
      Object.entries(body.variables).forEach(([k, id]) => {
        const alias = 'p' + k.slice(2);
        const p = this.posts.get(id as string);
        if (p) data[alias] = p; else { data[alias] = null; errors.push({ message: `Post not found for id: ${id}`, path: [alias] }); }
      });
      return json(errors.length ? { data, errors } : { data });
    }
    throw new Error('unexpected query ' + q.slice(0, 80));
  };
}
const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------- fixtures
function makeCfg(): Config {
  return {
    llmProvider: 'openai', llmModel: 'x', openaiKey: undefined, anthropicKey: undefined, transcribeModel: 'whisper-1', elevenKey: undefined, elevenVoiceId: undefined, elevenModelId: 'x',
    bufferKey: 'test-key', bufferOrgId: 'o'.repeat(24), bufferYoutubeChannelId: 'y'.repeat(24), bufferTiktokChannelId: 't'.repeat(24), tz: 'America/Chicago', publishSlots: '11:00,15:00,19:00',
    approvalMode: 'draft', bufferTagReviewId: 'r'.repeat(24), bufferTagClearedId: 'k'.repeat(24), contactEmail: 'theunhingedtoaster@gmail.com', commentaryDefault: 'auto', youtubeKey: undefined, enableYoutubeCc: false, sources: undefined, reddit: { userAgent: 'x' }, pexelsKey: undefined, pixabayKey: undefined,
    r2: { bucket: 'b' }, apiUrl: undefined, apiToken: undefined, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'toaster-int-')), assetsDir: '', templateDir: '',
  };
}
function seed(store: JsonStore, n: number, reviewEvery = 0) {
  const cands: Candidate[] = [];
  const prods: Production[] = [];
  for (let i = 0; i < n; i++) {
    const review = reviewEvery > 0 && i % reviewEvery === 0;
    cands.push(review
      ? { id: `C${i}`, source_platform: 'reddit', source_id: `s${i}`, source_url: `https://www.reddit.com/r/funny/comments/s${i}/x/`, author: `u/poster${i}`, title: `viral clip ${i}`, status: 'produced', rights_status: 'transformation_review', rights_basis: null, rights_evidence: null, copyright_risk: 'low', copyright_risk_reasons: '["self-filmed phone footage"]', category: 'people_fails', final_score: 90 - i, updated_at: '', discovered_at: '' } as Candidate
      : { id: `C${i}`, source_platform: 'pixabay', source_id: `s${i}`, source_url: `https://pixabay.com/videos/${i}`, title: `clip ${i}`, status: 'produced', rights_status: 'cleared', rights_basis: 'pixabay_license', rights_evidence: 'x', category: 'funny_animals', final_score: 70 - i, updated_at: '', discovered_at: '' } as Candidate);
    prods.push({ id: `P${i}`, candidate_id: `C${i}`, headline: `Headline ${i}`, commentary: 'c', caption_text: 'cap', hashtags: '["funny"]', voice_id: null, music_track: null, r2_key: `k${i}`, public_url: `https://media.example/${i}.mp4`, thumbnail_url: null, duration_sec: 10, render_log: null, reuse_basis: review ? 'review' : 'cleared', created_at: `2026-11-0${(i % 9) + 1}T00:00:00Z`, updated_at: '' });
  }
  return Promise.all([store.upsertCandidates(cands), ...prods.map((p) => store.upsertProduction(p))]);
}

const T0 = Date.parse('2026-11-08T13:00:00Z'); // Sunday morning Chicago
test('full mocked approval-to-scheduling workflow', async () => {
  const cfg = makeCfg();
  const store = new JsonStore(path.join(cfg.workDir, 'db.json'));
  await seed(store, 23);
  const fake = new FakeBuffer();
  const client = new BufferClient({ apiKey: 'k', fetchImpl: fake.fetch, maxRetries: 0 });
  let clock = T0;
  const now = () => new Date(clock);
  const plan = buildWeekPlan(now(), cfg.tz, cfg.publishSlots);

  // 1. weekly publish: 42 drafts, 21 productions, one per instant for both services
  let r = await publishWeek(cfg, store, { client, now, weeks: ['next'] });
  assert.equal(r.created, 42);
  assert.equal(r.failed, 0);
  assert.equal(fake.createCalls, 42);
  assert.ok([...fake.posts.values()].every((p) => p.status === 'draft'), 'nothing leaves the pipeline as anything but a draft');
  const posts = await store.listPosts({ week: plan.week });
  assert.equal(new Set(posts.map((p) => p.production_id)).size, 21);
  const firstSlot = plan.slots[0].slot_at;
  const yt = posts.find((p) => p.slot_at === firstSlot && p.service === 'youtube')!;
  const tt = posts.find((p) => p.slot_at === firstSlot && p.service === 'tiktok')!;
  assert.equal(yt.production_id, tt.production_id);
  assert.equal(fake.posts.get(yt.buffer_post_id!)!.dueAt, firstSlot, 'draft carries the intended publishing date');

  // 2. idempotent re-run: nothing new is created
  r = await publishWeek(cfg, store, { client, now, weeks: ['next'] });
  assert.equal(r.created + r.adopted, 0);
  assert.equal(fake.createCalls, 42);

  // 3. sync with nothing changed: no approvals/rejections, no edits
  let s = await syncBuffer(cfg, store, { client, now });
  assert.deepEqual([s.approved, s.rejected, s.errors.length], [0, 0, 0]);

  // 4. owner approves YouTube via "Add to queue" (Buffer moves dueAt), deletes the TikTok draft of the same clip
  fake.posts.get(yt.buffer_post_id!)!.status = 'scheduled';
  fake.posts.get(yt.buffer_post_id!)!.dueAt = '2026-11-10T03:46:00.000Z';
  fake.posts.delete(tt.buffer_post_id!);
  clock += 30 * 60_000;
  s = await syncBuffer(cfg, store, { client, now });
  assert.equal(s.approved, 1);
  assert.equal(s.rejected, 0, 'first "not found" is not yet a rejection');
  assert.equal(fake.editCalls.length, 1);
  assert.equal(fake.posts.get(yt.buffer_post_id!)!.dueAt, firstSlot, 'approved post pinned back to the intended date');
  assert.equal((await store.getCandidate(yt.candidate_id))!.status, 'approved');

  // 5. transient outage in between: nothing changes, missing counter does not advance
  fake.down = true;
  clock += 30 * 60_000;
  s = await syncBuffer(cfg, store, { client, now });
  assert.equal(s.errors.length, 1);
  assert.equal((await store.listPosts()).find((p) => p.id === tt.id)!.state, 'draft');
  assert.equal((await store.listPosts()).find((p) => p.id === tt.id)!.missing_count, 1);
  fake.down = false;

  // 6. second confirmed miss -> TikTok rejected, YouTube untouched, replacement drafted into the same TikTok slot from a spare production
  clock += 30 * 60_000;
  s = await syncBuffer(cfg, store, { client, now });
  assert.equal(s.rejected, 1);
  assert.equal(s.replacements_needed, 1);
  const after = await store.listPosts({ week: plan.week });
  const ttRows = after.filter((p) => p.slot_at === firstSlot && p.service === 'tiktok');
  assert.equal(ttRows.filter((p) => p.state === 'deleted').length, 1);
  const replacement = ttRows.find((p) => p.state === 'draft')!;
  assert.ok(replacement, 'replacement draft exists');
  assert.notEqual(replacement.production_id, yt.production_id, 'replacement uses a different (spare) production');
  assert.equal(after.find((p) => p.id === yt.id)!.state, 'scheduled', 'YouTube approval survived the TikTok rejection');
  assert.equal((await store.getCandidate(yt.candidate_id))!.status, 'approved');
  assert.equal(fake.createCalls, 43);

  // 7. readiness report
  const { report } = await readinessReport(cfg, store, 'next', now());
  assert.equal(report.videos_ready, 22, '21 original productions + the replacement');
  assert.equal(report.complete, true);
  assert.equal(report.funnel.approved, 1);
  assert.equal(report.funnel.rejected, 1);
});

test('timed-out create is adopted on retry instead of duplicated', async () => {
  const cfg = makeCfg();
  const store = new JsonStore(path.join(cfg.workDir, 'db.json'));
  await seed(store, 1);
  const fake = new FakeBuffer();
  fake.failNextCreateWithTimeoutButCreate = true;
  const client = new BufferClient({ apiKey: 'k', fetchImpl: fake.fetch, maxRetries: 0 });
  const now = () => new Date(T0);
  const r = await publishWeek(cfg, store, { client, now, weeks: ['next'] });
  assert.equal(r.failed, 0);
  assert.equal(r.created + r.adopted, 2);
  assert.equal(r.adopted, 1, 'the post created by the timed-out request was adopted');
  assert.equal(fake.posts.size, 2, 'no duplicate post in Buffer');
});

test('publish refuses productions without a public URL and reports open slots', async () => {
  const cfg = makeCfg();
  const store = new JsonStore(path.join(cfg.workDir, 'db.json'));
  await seed(store, 1);
  await store.upsertProduction({ ...(await store.listProductions())[0], public_url: null });
  const fake = new FakeBuffer();
  const client = new BufferClient({ apiKey: 'k', fetchImpl: fake.fetch, maxRetries: 0 });
  const r = await publishWeek(cfg, store, { client, now: () => new Date(T0), weeks: ['next'] });
  assert.equal(r.created, 0);
  assert.equal(r.openSlots, 42);
  const { report } = await readinessReport(cfg, store, 'next', new Date(T0));
  assert.equal(report.complete, false);
  assert.equal(report.videos_missing, 21);
  assert.ok(report.shortage_reasons['render_ok_but_no_public_url (R2 not configured)'] >= 1);
});

test('transformation-review drafts are labelled, viral-first ordered, and the note is stripped only after the owner approves', async () => {
  const cfg = makeCfg();
  const store = new JsonStore(path.join(cfg.workDir, 'db.json'));
  await seed(store, 4, 2); // C0, C2 review (reddit, higher score); C1, C3 cleared (pixabay)
  const fake = new FakeBuffer();
  const client = new BufferClient({ apiKey: 'k', fetchImpl: fake.fetch, maxRetries: 0 });
  let clock = T0;
  const now = () => new Date(clock);
  const plan = buildWeekPlan(now(), cfg.tz, cfg.publishSlots);
  const r = await publishWeek(cfg, store, { client, now, weeks: ['next'] });
  assert.equal(r.created, 8);
  const posts = await store.listPosts({ week: plan.week });
  const first = posts.filter((p) => p.slot_at === plan.slots[0].slot_at);
  assert.equal(first[0].production_id, 'P0', 'highest-scoring (viral) production fills the first slot');
  const yt = first.find((p) => p.service === 'youtube')!;
  assert.equal(yt.reuse_uncertain, true, 'review status is tracked internally');
  const draft = fake.posts.get(yt.buffer_post_id!)!;
  assert.equal(draft.text.includes(REVIEW_BLOCK_START), false, 'public caption carries no internal review text');
  assert.doesNotMatch(draft.text, /review|copyright risk|fair use/i);
  assert.match(draft.text, /🎬 Original clip: u\/poster0 — https:\/\/www\.reddit\.com\/r\/funny/);
  assert.match(draft.text, /theunhingedtoaster@gmail\.com/);
  assert.equal(draft.tagIds?.[0], 'r'.repeat(24), 'review drafts get the internal REVIEW tag');
  assert.equal(draft.status, 'draft');
  const clearedPost = posts.find((p) => p.production_id === 'P1')!;
  assert.equal(clearedPost.reuse_uncertain, false);
  assert.equal(fake.posts.get(clearedPost.buffer_post_id!)!.tagIds?.[0], 'k'.repeat(24), 'cleared drafts get the CLEARED tag');
  assert.match(fake.posts.get(clearedPost.buffer_post_id!)!.text, /Pixabay/);

  // owner approves the review draft on YouTube
  draft.status = 'scheduled';
  clock += 30 * 60_000;
  const s = await syncBuffer(cfg, store, { client, now });
  assert.equal(s.approved, 1);
  assert.equal(s.errors.length, 0);
  assert.equal(fake.editCalls.filter((e) => e.text !== undefined).length, 0, 'no caption edit needed: captions were clean from the start');
  assert.equal(fake.posts.get(yt.buffer_post_id!)!.text, yt.public_text);
  const cand = (await store.getCandidate('C0'))!;
  assert.equal(cand.rights_status, 'owner_reviewed');
  assert.equal(cand.rights_basis, 'owner_transformative_use');
  assert.match(cand.rights_evidence ?? '', /Owner approved Buffer youtube post/);
  // the TikTok twin is still an unapproved draft (independent)
  const tt = first.find((p) => p.service === 'tiktok')!;
  assert.equal((await store.listPosts()).find((p) => p.id === tt.id)!.state, 'draft');
  const { report, markdown } = await readinessReport(cfg, store, 'next', now());
  assert.equal(report.videos_ready_review, 2);
  assert.equal(report.videos_ready_cleared, 2);
  assert.equal(report.review_items.length, 2, 'internal report lists every review-path video');
  const item = report.review_items.find((i) => i.production_id === 'P0')!;
  assert.equal(item.copyright_risk, 'low');
  assert.deepEqual(item.services.map((x) => x.service).sort(), ['tiktok', 'youtube']);
  assert.match(markdown, /Transformation-review drafts \(2\)/);
  assert.match(markdown, /never appears in a public caption/);
  assert.equal(report.cleared_items.length, 2);
});
