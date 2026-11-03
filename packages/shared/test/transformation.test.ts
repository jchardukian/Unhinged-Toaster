import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canProduce, isCleared, productionBasis, ownerReviewedRights, reviewBlock, stripReviewBlock, hasReviewBlock, initialRights, REVIEW_BLOCK_START } from '../src/rights.js';
import { planEdit, detectPeak } from '../src/editplan.js';
import { runSync, type SyncStore } from '../src/sync.js';
import type { Candidate, ScheduledPost } from '../src/types.js';
import type { PostLookup, BufferPost } from '../src/buffer.js';

test('rights policy: transformation review is a separate, labelled path; never "cleared"', () => {
  const reddit = { ...initialRights('reddit', {}), copyright_risk: 'low' as const };
  assert.equal(reddit.rights_status, 'transformation_review');
  assert.equal(isCleared(reddit), false);
  assert.equal(productionBasis(reddit), 'review');
  assert.equal(productionBasis(reddit, { transformationReview: false }), null, 'policy can switch the path off');
  assert.equal(productionBasis({ ...reddit, copyright_risk: 'high' }), null, 'high copyright risk is never produced');
  assert.equal(productionBasis({ ...reddit, copyright_risk: 'medium' }, { transformationReview: true, maxCopyrightRisk: 'low' }), null);
  assert.equal(productionBasis({ ...reddit, copyright_risk: null }), 'review', 'unknown risk is treated as medium');
  assert.equal(canProduce({ rights_status: 'unknown', rights_basis: null, rights_evidence: null, copyright_risk: 'low' }), false);
  assert.equal(productionBasis({ rights_status: 'cleared', rights_basis: 'pixabay_license', rights_evidence: 'x', copyright_risk: null }), 'cleared');
  const reviewed = ownerReviewedRights({ rights_status: 'transformation_review' }, 'Owner approved Buffer youtube post abc at 2026-11-08T13:00:00Z');
  assert.equal(reviewed?.rights_status, 'owner_reviewed');
  assert.equal(reviewed?.rights_basis, 'owner_transformative_use');
  assert.equal(isCleared({ ...reviewed!, }), false, 'owner review is recorded but is not a license');
  assert.equal(ownerReviewedRights({ rights_status: 'cleared' }, 'x'), null);
});

test('review block is explicit and strips cleanly', () => {
  const c = { author: 'u/someone', source_url: 'https://reddit.com/r/x/comments/abc', source_platform: 'reddit', copyright_risk: 'medium', copyright_risk_reasons: JSON.stringify(['poster may not be the filmer']), rights_notes: null } as Candidate;
  const block = reviewBlock(c);
  assert.ok(block.startsWith(REVIEW_BLOCK_START));
  assert.match(block, /NONE on file/);
  assert.match(block, /not a license/);
  assert.match(block, /poster may not be the filmer/);
  const text = `${block}\n\nPublic caption here.\n\n#funny`;
  assert.equal(hasReviewBlock(text), true);
  assert.equal(stripReviewBlock(text), 'Public caption here.\n\n#funny');
  assert.equal(hasReviewBlock(stripReviewBlock(text)), false);
  assert.equal(stripReviewBlock('no block'), 'no block');
});

test('planEdit builds freeze / punch-in / replay / sticker around the peak and respects the limit', () => {
  const tl = planEdit({ sourceDuration: 12, peak: 7.4, maxTotal: 55, style: 'full', stickerText: 'NOPE.', freezeText: 'WAIT FOR IT…', hasSpeech: false });
  assert.deepEqual(tl.beats.freeze, { at: 6.4, duration: 0.7, text: 'WAIT FOR IT…' });
  assert.equal(tl.beats.punchIn?.at, 7.3);
  assert.deepEqual(tl.beats.replay, { from: 6.6, to: 8.2, speed: 0.5, zoom: 1.15 });
  assert.equal(tl.beats.sticker?.text, 'NOPE.');
  assert.equal(tl.editedDuration, 15.9);
  assert.equal(tl.map(3), 3);
  assert.equal(tl.map(8), 8.7, 'captions after the freeze shift by the freeze duration');
  assert.equal(tl.replayStart, 12.7);

  const speech = planEdit({ sourceDuration: 12, peak: 7.4, maxTotal: 55, style: 'full', stickerText: 'NOPE.', freezeText: 'WAIT', hasSpeech: true });
  assert.equal(speech.beats.freeze, null, 'no freeze inside dialogue');
  assert.ok(speech.dropped.includes('freeze:speech'));

  const light = planEdit({ sourceDuration: 12, peak: 7.4, maxTotal: 55, style: 'light', stickerText: 'NOPE.', freezeText: 'WAIT' });
  assert.equal(light.beats.freeze, null);
  assert.equal(light.beats.replay, null);
  assert.ok(light.beats.punchIn, 'light keeps the punch-in');

  const long = planEdit({ sourceDuration: 54, peak: 30, maxTotal: 55.8, style: 'full', stickerText: 'X', freezeText: 'Y' });
  assert.equal(long.beats.replay, null, 'replay dropped when over the limit');
  assert.ok(long.beats.freeze, 'freeze still fits');
  assert.ok(long.editedDuration <= 55.8);
  const longer = planEdit({ sourceDuration: 55.5, peak: 30, maxTotal: 55.8, style: 'full', stickerText: 'X', freezeText: 'Y' });
  assert.equal(longer.beats.freeze, null, 'freeze dropped when still over the limit');
  assert.ok(longer.dropped.includes('freeze:over_limit'));

  const noPeak = planEdit({ sourceDuration: 10, peak: null, maxTotal: 55, style: 'full', stickerText: 'X', freezeText: 'Y' });
  assert.equal(noPeak.beats.punchIn?.at, 6.1, 'falls back to ~62% of the clip');
});

test('detectPeak prefers an audio onset, then the loudest moment, then a scene change', () => {
  const quiet = Array.from({ length: 40 }, (_, i) => ({ t: i * 0.1, db: -40 }));
  const onset = quiet.map((x) => (x.t >= 2.0 ? { ...x, db: -18 } : x));
  assert.deepEqual(detectPeak({ audioRms: onset, duration: 4 }), { t: 2, method: 'audio_onset' });
  const gradual = quiet.map((x, i) => ({ ...x, db: -40 + i * 0.3 }));
  assert.equal(detectPeak({ audioRms: gradual, duration: 4 })?.method, 'audio_loudest');
  assert.deepEqual(detectPeak({ sceneScores: [{ t: 0.5, score: 0.05 }, { t: 1.7, score: 0.6 }, { t: 3.9, score: 0.9 }], duration: 4 }), { t: 1.7, method: 'scene_change' });
  assert.equal(detectPeak({ duration: 4 }), null);
});

// ---- approval of a transformation-review draft: owner decision recorded, review note stripped from the public caption
const SLOT = '2026-11-09T17:00:00.000Z';
function post(over: Partial<ScheduledPost>): ScheduledPost {
  return {
    id: 'p1', production_id: 'prod1', candidate_id: 'c1', service: 'youtube', buffer_channel_id: 'ch', buffer_post_id: 'b1', slot_at: SLOT, batch_week: '2026-W46',
    state: 'draft', last_synced_at: null, buffer_error: null, views: null, likes: null, comments: null, shares: null, metrics_updated_at: null, created_at: '', updated_at: '',
    reuse_uncertain: true, public_text: 'Clean caption #funny', review_block_stripped: false, ...over,
  };
}
class MemStore implements SyncStore {
  posts: ScheduledPost[]; patches: { id: string; patch: Partial<Candidate> }[] = []; events: string[] = [];
  constructor(posts: ScheduledPost[]) { this.posts = posts; }
  async listPendingPosts() { return this.posts.filter((p) => ['draft', 'needs_approval', 'scheduled', 'sending'].includes(p.state)); }
  async savePost(p: ScheduledPost) { this.posts[this.posts.findIndex((x) => x.id === p.id)] = { ...p }; }
  async listPostsForCandidate(id: string) { return this.posts.filter((p) => p.candidate_id === id); }
  async patchCandidate(id: string, patch: Partial<Candidate>) { this.patches.push({ id, patch }); }
  async getCandidate() { return { rights_status: 'transformation_review' as const }; }
  async logEvent(kind: string) { this.events.push(kind); }
}

test('approving a review draft records owner_reviewed and strips the note; failure to strip is reported and retried', async () => {
  const draftText = `${REVIEW_BLOCK_START}\nstuff\n— end of review note —\n\nClean caption #funny`;
  const buffer: Record<string, BufferPost> = { b1: { id: 'b1', status: 'scheduled', text: draftText, dueAt: SLOT } };
  let editFails = true;
  const edits: { id: string; text?: string; dueAt?: string }[] = [];
  const client = {
    async lookupPosts(ids: string[]) { return new Map(ids.map((id) => [id, { status: 'found', post: buffer[id] } as PostLookup])); },
    async reschedulePost(id: string, dueAt: string) { edits.push({ id, dueAt }); return buffer[id]; },
    async editPost(id: string, ch: { text?: string; dueAt?: string }) { edits.push({ id, ...ch }); if (editFails) throw new Error('503'); buffer[id] = { ...buffer[id], text: ch.text ?? buffer[id].text }; return buffer[id]; },
  };
  const store = new MemStore([post({})]);
  let r = await runSync(client, store, { tz: 'America/Chicago' });
  assert.equal(r.approved, 1);
  const rights = store.patches.find((p) => p.patch.rights_status);
  assert.equal(rights?.patch.rights_status, 'owner_reviewed');
  assert.equal(rights?.patch.rights_basis, 'owner_transformative_use');
  assert.match(rights?.patch.rights_evidence ?? '', /Owner approved Buffer youtube post b1/);
  assert.equal(store.posts[0].review_block_stripped, false);
  assert.ok(r.errors.some((e) => /strip review note failed/.test(e.error)), 'strip failure is surfaced');
  assert.equal(store.posts[0].state, 'scheduled', 'approval itself is not lost');

  editFails = false;
  r = await runSync(client, store, { tz: 'America/Chicago' });
  assert.equal(store.posts[0].review_block_stripped, true);
  assert.equal(buffer.b1.text, 'Clean caption #funny');
  assert.equal(r.errors.length, 0);
  assert.equal(store.patches.filter((p) => p.patch.rights_status).length, 1, 'owner decision recorded once');
  assert.ok(store.events.includes('review_block_stripped'));
});

test('cleared footage drafts carry no note and are untouched on approval', async () => {
  const buffer: Record<string, BufferPost> = { b1: { id: 'b1', status: 'scheduled', text: 'Clean', dueAt: SLOT } };
  let edited = 0;
  const client = {
    async lookupPosts(ids: string[]) { return new Map(ids.map((id) => [id, { status: 'found', post: buffer[id] } as PostLookup])); },
    async reschedulePost(id: string) { return buffer[id]; },
    async editPost(id: string) { edited++; return buffer[id]; },
  };
  const store = new MemStore([post({ reuse_uncertain: false, review_block_stripped: true })]);
  const r = await runSync(client, store, { tz: 'America/Chicago' });
  assert.equal(r.approved, 1);
  assert.equal(edited, 0);
  assert.equal(store.patches.some((p) => p.patch.rights_status), false);
});
