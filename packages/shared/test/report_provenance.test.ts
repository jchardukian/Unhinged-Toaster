import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadinessReport, formatReadinessMarkdown } from '../src/report.js';
import { broadcastRisk, ccProvenanceRisk } from '../src/provenance.js';
import { buildWeekPlan } from '../src/schedule.js';
import { initialRights } from '../src/rights.js';
import type { Candidate, Production, ScheduledPost } from '../src/types.js';

const plan = buildWeekPlan(new Date('2026-11-02T20:00:00Z'), 'America/Chicago', '11:00,15:00,19:00');

function cand(id: string, status: Candidate['status'], rights: Candidate['rights_status'] = 'cleared', reason: string | null = null): Candidate {
  return { id, status, rights_status: rights, status_reason: reason, rights_basis: rights === 'cleared' ? 'pixabay_license' : null, rights_evidence: 'x', source_platform: 'pixabay', source_id: id, source_url: `https://p/${id}`, title: id } as Candidate;
}
function prod(id: string, cid: string, url: string | null = 'https://cdn/x.mp4'): Production {
  return { id, candidate_id: cid, public_url: url, headline: 'h', commentary: 'c', caption_text: '', hashtags: '[]', created_at: '', updated_at: '' } as Production;
}
function post(prodId: string, slot: string, service: 'youtube' | 'tiktok', state: ScheduledPost['state'] = 'draft'): ScheduledPost {
  return { id: `${prodId}-${service}`, production_id: prodId, candidate_id: 'c', service, buffer_channel_id: 'ch', buffer_post_id: 'b', slot_at: slot, batch_week: plan.week, state } as ScheduledPost;
}

test('readiness report counts the funnel and names shortages honestly', () => {
  const ytSlots = plan.slots.filter((s) => s.service === 'youtube').map((s) => s.slot_at);
  const posts: ScheduledPost[] = [];
  for (let i = 0; i < 5; i++) { posts.push(post(`p${i}`, ytSlots[i], 'youtube', i === 0 ? 'scheduled' : 'draft')); posts.push(post(`p${i}`, ytSlots[i], 'tiktok', i === 1 ? 'deleted' : 'draft')); }
  const r = buildReadinessReport({
    plan,
    candidates: [cand('a', 'drafted'), cand('b', 'blocked_rights', 'unknown'), cand('c', 'rejected_score'), cand('d', 'failed', 'cleared', 'clip too short (2.0s)'), cand('e', 'scored', 'unknown')],
    productions: [prod('p0', 'a'), prod('p1', 'a'), prod('p2', 'a'), prod('p3', 'a'), prod('p4', 'a'), prod('p5', 'a'), prod('p6', 'a', null)],
    posts,
  });
  assert.equal(r.target_videos, 21);
  assert.equal(r.videos_ready, 5);
  assert.equal(r.videos_missing, 16);
  assert.equal(r.complete, false);
  assert.equal(r.funnel.drafts_created, 9);
  assert.equal(r.funnel.approved, 1);
  assert.equal(r.funnel.rejected, 1);
  assert.equal(r.missing_slots.length, 42 - 9);
  assert.equal(r.shortage_reasons['rights:unknown'], 2);
  assert.equal(r.shortage_reasons['score_below_threshold'], 1);
  assert.ok(Object.keys(r.shortage_reasons).some((k) => k.startsWith('render_failed:clip too short')));
  assert.ok(r.blockers.some((b) => /not yet drafted/.test(b)), r.blockers.join('|'));
  const md = formatReadinessMarkdown(r);
  assert.match(md, /INCOMPLETE \(16 of 21 videos missing\)/);
});

test('readiness report is complete only when every slot has a live draft', () => {
  const posts = plan.slots.map((s, i) => post(`p${Math.floor(i / 2)}`, s.slot_at, s.service));
  const r = buildReadinessReport({ plan, candidates: [], productions: Array.from({ length: 21 }, (_, i) => prod(`p${i}`, 'c')), posts });
  assert.equal(r.complete, true);
  assert.equal(r.videos_ready, 21);
});

test('provenance: CC label alone does not clear compilation-style uploads', () => {
  assert.equal(ccProvenanceRisk({ title: 'My dog refuses to get out of the bath', description: 'filmed at home', channelTitle: 'Jess & Biscuit' }).risk, 'low');
  assert.equal(ccProvenanceRisk({ title: 'TRY NOT TO LAUGH – Funny Fails Compilation #shorts', channelTitle: 'Daily Dose Of Fails' }).risk, 'high');
  assert.equal(ccProvenanceRisk({ title: 'cat jumps', description: 'credit to @someone on tiktok' }).risk, 'high');
  assert.equal(ccProvenanceRisk({ title: 'Epic moment at the beach' }).risk, 'medium');
  const r = initialRights('youtube', { license: 'creativeCommon', provenanceRisk: 'high', provenanceReasons: ['text:compilation'] });
  assert.equal(r.rights_status, 'unknown');
  assert.equal(initialRights('youtube', { license: 'creativeCommon', provenanceRisk: 'low' }).rights_status, 'cleared');
  assert.equal(initialRights('internet_archive', { license: 'http://creativecommons.org/publicdomain/zero/1.0/' }).rights_basis, 'cc0');
  assert.equal(initialRights('internet_archive', { license: 'http://creativecommons.org/licenses/by-nc/3.0/' }).rights_status, 'unknown');
});

test('broadcast / pro-sports / TV footage is flagged high risk by keyword backstop', () => {
  assert.equal(broadcastRisk('Sir Patrick Stewart drank champagne out of F1 driver Daniel Ricciardo\'s boot on the podium').high, true);
  assert.equal(broadcastRisk('Argentinian reporter pauses live broadcast to save a dog').high, true);
  assert.equal(broadcastRisk('Tiny kitten decided this giant leaf was the ultimate hiding spot').high, false);
  assert.equal(broadcastRisk('Down 30-25 with 3.8 seconds to go. Whitesboro with the win').high, false); // fan-filmed high-school game stays eligible
});
