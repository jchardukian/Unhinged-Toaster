import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePost } from '../src/reconcile.js';
import { BufferClient } from '../src/buffer.js';

test('reconcilePost: deleted draft => rejected', () => {
  const r = reconcilePost({ state: 'draft', slot_at: '2026-11-09T17:00:00.000Z' }, null);
  assert.equal(r.rejected, true);
  assert.equal(r.state, 'deleted');
});

test('reconcilePost: draft -> scheduled => approved, reschedule when dueAt differs', () => {
  const r = reconcilePost({ state: 'draft', slot_at: '2026-11-09T17:00:00.000Z' }, { id: 'p', status: 'scheduled', text: '', dueAt: '2026-11-10T03:46:00.000Z' });
  assert.equal(r.approved, true);
  assert.equal(r.needsReschedule, true);
  const r2 = reconcilePost({ state: 'draft', slot_at: '2026-11-09T17:00:00.000Z' }, { id: 'p', status: 'scheduled', text: '', dueAt: '2026-11-09T17:00:00.000Z' });
  assert.equal(r2.needsReschedule, false);
});

test('reconcilePost: sent and error', () => {
  assert.equal(reconcilePost({ state: 'scheduled', slot_at: 'x' }, { id: 'p', status: 'sent', text: '', dueAt: null }).published, true);
  assert.equal(reconcilePost({ state: 'scheduled', slot_at: 'x' }, { id: 'p', status: 'error', text: '', dueAt: null, error: { message: 'boom' } }).error, 'boom');
});

test('BufferClient builds a draft createPost mutation and handles MutationError', async () => {
  const calls: { body: any; headers: any }[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)), headers: init?.headers });
    const vars = calls[calls.length - 1].body.variables;
    if (vars.input.text === 'fail') {
      return new Response(JSON.stringify({ data: { createPost: { __typename: 'InvalidInputError', message: 'bad video' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'abc', status: 'draft', text: vars.input.text, dueAt: vars.input.dueAt } } } }), { status: 200, headers: { 'content-type': 'application/json', ratelimit: 'r=449;t=900' } });
  };
  const c = new BufferClient({ apiKey: 'k', fetchImpl });
  const post = await c.createVideoPost({ channelId: 'c'.repeat(24), text: 'hello', videoUrl: 'https://cdn/x.mp4', dueAt: '2026-11-09T11:00:00-06:00', youtube: { title: 'T', categoryId: '23' } });
  assert.equal(post.id, 'abc');
  const input = calls[0].body.variables.input;
  assert.equal(input.saveToDraft, true, 'defaults to draft');
  assert.equal(input.mode, 'customScheduled');
  assert.equal(input.schedulingType, 'automatic');
  assert.equal(input.assets[0].video.url, 'https://cdn/x.mp4');
  assert.equal(input.metadata.youtube.privacy, 'public');
  assert.equal((calls[0].headers as any).authorization, 'Bearer k');
  assert.equal(c.lastRateLimit, 'r=449;t=900');
  await assert.rejects(() => c.createVideoPost({ channelId: 'c'.repeat(24), text: 'fail', videoUrl: 'https://cdn/x.mp4' }), /bad video/);
});

test('BufferClient.getPosts maps a deleted post (per-alias "not found" error) to null', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({
      data: { p0: { id: 'a'.repeat(24), status: 'scheduled', text: '', dueAt: null }, p1: null },
      errors: [{ message: `Post not found for id: ${'b'.repeat(24)}`, path: ['p1'] }],
    }), { status: 200 });
  const c = new BufferClient({ apiKey: 'k', fetchImpl });
  const m = await c.getPosts(['a'.repeat(24), 'b'.repeat(24)]);
  assert.equal(m.get('a'.repeat(24))?.status, 'scheduled');
  assert.equal(m.get('b'.repeat(24)), null);
});

test('BufferClient retries on 429 using Retry-After', async () => {
  let n = 0;
  const fetchImpl: typeof fetch = async () => {
    n++;
    if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ data: { account: { id: 'a', timezone: 'America/Chicago', organizations: [] } } }), { status: 200 });
  };
  const c = new BufferClient({ apiKey: 'k', fetchImpl });
  const acct = await c.account();
  assert.equal(acct.timezone, 'America/Chicago');
  assert.equal(n, 2);
});
