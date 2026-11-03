import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync, deriveCandidateStatus, type SyncStore } from '../src/sync.js';
import { BufferClient, type BufferPost, type PostLookup } from '../src/buffer.js';
import type { Candidate, ScheduledPost } from '../src/types.js';

const SLOT = '2026-11-09T17:00:00.000Z';
function post(over: Partial<ScheduledPost>): ScheduledPost {
  return {
    id: over.id ?? 'p1', production_id: over.production_id ?? 'prod1', candidate_id: over.candidate_id ?? 'c1', service: over.service ?? 'youtube',
    buffer_channel_id: 'ch', buffer_post_id: over.buffer_post_id ?? 'b1', slot_at: over.slot_at ?? SLOT, batch_week: '2026-W46', state: over.state ?? 'draft',
    last_synced_at: null, buffer_error: null, views: null, likes: null, comments: null, shares: null, metrics_updated_at: null,
    created_at: '', updated_at: '', ...over,
  };
}

class MemStore implements SyncStore {
  posts: ScheduledPost[];
  candidatePatches: { id: string; patch: Partial<Candidate> }[] = [];
  events: { kind: string; ref: string | null }[] = [];
  constructor(posts: ScheduledPost[]) { this.posts = posts.map((p) => ({ ...p })); }
  async listPendingPosts() { return this.posts.filter((p) => ['draft', 'needs_approval', 'scheduled', 'sending'].includes(p.state)); }
  async savePost(p: ScheduledPost) { const i = this.posts.findIndex((x) => x.id === p.id); this.posts[i] = { ...p }; }
  async listPostsForCandidate(id: string) { return this.posts.filter((p) => p.candidate_id === id); }
  async patchCandidate(id: string, patch: Partial<Candidate>) { this.candidatePatches.push({ id, patch }); }
  async logEvent(kind: string, ref: string | null) { this.events.push({ kind, ref }); }
}

function fakeClient(lookup: Record<string, PostLookup> | Error, reschedule?: (id: string, dueAt: string) => BufferPost) {
  const calls: { id: string; dueAt: string }[] = [];
  return {
    calls,
    client: {
      async lookupPosts(ids: string[]) {
        if (lookup instanceof Error) throw lookup;
        return new Map(ids.map((id) => [id, lookup[id] ?? { status: 'error', message: 'unmapped' } as PostLookup]));
      },
      async reschedulePost(id: string, dueAt: string) {
        calls.push({ id, dueAt });
        return reschedule ? reschedule(id, dueAt) : { id, status: 'scheduled', text: '', dueAt: SLOT };
      },
    },
  };
}

const tz = 'America/Chicago';
let clock = Date.parse('2026-11-08T12:00:00Z');
const now = () => new Date(clock);

test('approval: draft -> scheduled on YouTube only; TikTok stays draft; candidate becomes approved', async () => {
  const store = new MemStore([post({ id: 'y', service: 'youtube', buffer_post_id: 'by' }), post({ id: 't', service: 'tiktok', buffer_post_id: 'bt' })]);
  const { client, calls } = fakeClient({
    by: { status: 'found', post: { id: 'by', status: 'scheduled', text: '', dueAt: SLOT } },
    bt: { status: 'found', post: { id: 'bt', status: 'draft', text: '', dueAt: SLOT } },
  });
  const r = await runSync(client, store, { tz, now });
  assert.equal(r.approved, 1);
  assert.equal(r.rejected, 0);
  assert.equal(calls.length, 0, 'dueAt already correct: no reschedule');
  assert.equal(store.posts.find((p) => p.id === 'y')!.state, 'scheduled');
  assert.equal(store.posts.find((p) => p.id === 't')!.state, 'draft');
  assert.equal(store.candidatePatches.at(-1)?.patch.status, 'approved');
});

test('approved post moved by Buffer queue is pinned back to its slot and verified', async () => {
  const store = new MemStore([post({})]);
  const { client, calls } = fakeClient({ b1: { status: 'found', post: { id: 'b1', status: 'scheduled', text: '', dueAt: '2026-11-10T03:46:00.000Z' } } });
  const r = await runSync(client, store, { tz, now });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dueAt, '2026-11-09T11:00:00-06:00');
  assert.equal(r.errors.length, 0);
  assert.equal(store.events.some((e) => e.kind === 'rescheduled'), true);
});

test('reschedule that does not land on the slot is reported, not silently accepted', async () => {
  const store = new MemStore([post({})]);
  const { client } = fakeClient(
    { b1: { status: 'found', post: { id: 'b1', status: 'scheduled', text: '', dueAt: '2026-11-10T03:46:00.000Z' } } },
    (id) => ({ id, status: 'scheduled', text: '', dueAt: '2026-11-10T03:46:00.000Z' }),
  );
  const r = await runSync(client, store, { tz, now });
  assert.match(r.errors[0].error, /verification failed/);
  assert.match(store.posts[0].sync_error ?? '', /verification failed/);
});

test('rejection: TikTok deleted (confirmed over two polls) while YouTube approved -> candidate stays approved, replacement for TikTok only', async () => {
  const store = new MemStore([post({ id: 'y', service: 'youtube', buffer_post_id: 'by', state: 'scheduled' }), post({ id: 't', service: 'tiktok', buffer_post_id: 'bt' })]);
  const { client } = fakeClient({ by: { status: 'found', post: { id: 'by', status: 'scheduled', text: '', dueAt: SLOT } }, bt: { status: 'not_found' } });
  let r = await runSync(client, store, { tz, now });
  assert.equal(r.rejected, 0, 'first miss is not a rejection');
  assert.equal(store.posts.find((p) => p.id === 't')!.state, 'draft');
  assert.equal(store.posts.find((p) => p.id === 't')!.missing_count, 1);
  clock += 31 * 60_000;
  r = await runSync(client, store, { tz, now });
  assert.equal(r.rejected, 1);
  assert.equal(r.replacements_needed, 1);
  assert.equal(store.posts.find((p) => p.id === 't')!.state, 'deleted');
  assert.equal(store.posts.find((p) => p.id === 'y')!.state, 'scheduled');
  assert.equal(store.candidatePatches.at(-1)?.patch.status, 'approved', 'YouTube approval survives TikTok rejection');
});

test('two quick misses within the interval do not confirm deletion', async () => {
  const store = new MemStore([post({})]);
  const { client } = fakeClient({ b1: { status: 'not_found' } });
  await runSync(client, store, { tz, now });
  clock += 60_000;
  const r = await runSync(client, store, { tz, now });
  assert.equal(r.rejected, 0);
  assert.equal(store.posts[0].missing_count, 2);
  assert.equal(store.posts[0].state, 'draft');
});

test('transient Buffer failure: state untouched, error recorded', async () => {
  const store = new MemStore([post({}), post({ id: 'p2', buffer_post_id: 'b2' })]);
  const { client } = fakeClient(new Error('HTTP 503'));
  const r = await runSync(client, store, { tz, now });
  assert.equal(r.rejected, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(store.posts[0].state, 'draft');
  assert.match(store.posts[0].sync_error ?? '', /503/);
  const store2 = new MemStore([post({})]);
  const { client: c2 } = fakeClient({ b1: { status: 'error', message: 'Internal error' } });
  const r2 = await runSync(c2, store2, { tz, now });
  assert.equal(store2.posts[0].state, 'draft');
  assert.equal(store2.posts[0].missing_count ?? 0, 0);
  assert.equal(r2.errors[0].error, 'Internal error');
});

test('published and error states', async () => {
  const store = new MemStore([post({ state: 'scheduled' }), post({ id: 'p2', buffer_post_id: 'b2', candidate_id: 'c2', state: 'scheduled' })]);
  const { client } = fakeClient({
    b1: { status: 'found', post: { id: 'b1', status: 'sent', text: '', dueAt: SLOT } },
    b2: { status: 'found', post: { id: 'b2', status: 'error', text: '', dueAt: SLOT, error: { message: 'TikTok rejected the video' } } },
  });
  const r = await runSync(client, store, { tz, now });
  assert.equal(r.published, 1);
  assert.equal(r.errors[0].error, 'TikTok rejected the video');
  assert.equal(store.candidatePatches.find((p) => p.id === 'c1')?.patch.status, 'published');
});

test('deriveCandidateStatus', () => {
  assert.equal(deriveCandidateStatus([post({ state: 'deleted' }), post({ state: 'deleted' })]), 'rejected_user');
  assert.equal(deriveCandidateStatus([post({ state: 'deleted' }), post({ state: 'draft' })]), 'drafted');
  assert.equal(deriveCandidateStatus([post({ state: 'deleted' }), post({ state: 'scheduled' })]), 'approved');
  assert.equal(deriveCandidateStatus([]), null);
});

test('publish guard: BufferClient refuses anything that is not a draft or approval request', async () => {
  const c = new BufferClient({ apiKey: 'k', fetchImpl: async () => { throw new Error('should not be called'); } });
  const base = { channelId: 'c'.repeat(24), text: 'x', videoUrl: 'https://cdn/x.mp4' };
  await assert.rejects(() => c.createVideoPost({ ...base, mode: 'shareNow' }), /publish guard/);
  await assert.rejects(() => c.createVideoPost({ ...base, mode: 'shareNext' }), /publish guard/);
  await assert.rejects(() => c.createVideoPost({ ...base, saveToDraft: false }), /publish guard/);
  await assert.rejects(() => c.createVideoPost({ ...base, saveToDraft: false, mode: 'customScheduled', dueAt: '2026-11-09T11:00:00-06:00' }), /publish guard/);
});

test('lookupPosts classifies found / not_found / error per alias and throws on transport failure', async () => {
  const c = new BufferClient({
    apiKey: 'k',
    maxRetries: 0,
    fetchImpl: async () => new Response(JSON.stringify({
      data: { p0: { id: 'a'.repeat(24), status: 'draft', text: '', dueAt: null }, p1: null, p2: null },
      errors: [{ message: `Post not found for id: ${'b'.repeat(24)}`, path: ['p1'] }, { message: 'Internal server error', path: ['p2'] }],
    }), { status: 200 }),
  });
  const m = await c.lookupPosts(['a'.repeat(24), 'b'.repeat(24), 'c'.repeat(24)]);
  assert.equal(m.get('a'.repeat(24))?.status, 'found');
  assert.equal(m.get('b'.repeat(24))?.status, 'not_found');
  assert.equal(m.get('c'.repeat(24))?.status, 'error');
  const down = new BufferClient({ apiKey: 'k', maxRetries: 0, fetchImpl: async () => new Response('bad gateway', { status: 502 }) });
  await assert.rejects(() => down.lookupPosts(['a'.repeat(24)]), /502/);
});
