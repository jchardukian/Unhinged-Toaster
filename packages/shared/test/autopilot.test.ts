import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTOPILOT_AUTHORIZATION_PHRASE, autopilotActive, monitorVerdict, unattendedEligible } from '../src/autopilot.js';
import { BufferClient } from '../src/buffer.js';

const okQc = JSON.stringify({ ok: true, score: 8.2, checks: [{ name: 'resolution', ok: true, severity: 'block' }] });
const cleared = { rights_status: 'cleared' as const, rights_basis: 'cc_by' as const, rights_evidence: 'YouTube Data API status.license=creativeCommon; channel UC1', copyright_risk: 'low' as const, safety_flags: '[]', status: 'produced' as const };
const prod = { qc_score: 8.2, qc_json: okQc, public_url: 'https://media.example/x.mp4' };

test('autopilot is off by default and needs the switch, the exact phrase, no stop flag and no pause record', () => {
  assert.equal(autopilotActive({ enabled: false, authorization: undefined, emergencyStop: false, setting: null }).active, false);
  assert.equal(autopilotActive({ enabled: true, authorization: 'yes', emergencyStop: false, setting: null }).active, false);
  assert.equal(autopilotActive({ enabled: true, authorization: AUTOPILOT_AUTHORIZATION_PHRASE, emergencyStop: true, setting: null }).active, false);
  assert.equal(autopilotActive({ enabled: true, authorization: AUTOPILOT_AUTHORIZATION_PHRASE, emergencyStop: false, setting: { paused: true, reason: 'monitor', by: 'monitor' } }).active, false);
  const on = autopilotActive({ enabled: true, authorization: ` ${AUTOPILOT_AUTHORIZATION_PHRASE} `, emergencyStop: false, setting: { paused: false } });
  assert.equal(on.active, true); assert.deepEqual(on.reasons, []);
  const off = autopilotActive({ enabled: false, authorization: undefined, emergencyStop: true, setting: { paused: true, reason: 'x', by: 'owner', at: 't' } });
  assert.equal(off.reasons.length, 4, 'every missing condition is listed');
});

test('unattended eligibility: documented licence + passed QC only; popularity, review paths, attribution never qualify', () => {
  assert.equal(unattendedEligible(cleared, prod).eligible, true);
  const review = unattendedEligible({ ...cleared, rights_status: 'transformation_review', rights_basis: null }, prod);
  assert.equal(review.eligible, false); assert.match(review.reasons.join(' '), /rights not documented/);
  const ownerReviewed = unattendedEligible({ ...cleared, rights_status: 'owner_reviewed', rights_basis: 'owner_transformative_use' }, prod);
  assert.equal(ownerReviewed.eligible, false);
  const ai = unattendedEligible({ ...cleared, rights_basis: 'ai_generated' }, prod);
  assert.equal(ai.eligible, false, 'ai_generated is not in the unattended allow-list (paid generation paused)');
  assert.equal(unattendedEligible({ ...cleared, rights_evidence: '' }, prod).eligible, false);
  assert.equal(unattendedEligible({ ...cleared, copyright_risk: 'high' }, prod).eligible, false);
  assert.equal(unattendedEligible({ ...cleared, safety_flags: '["animal_cruelty"]' }, prod).eligible, false);
  assert.equal(unattendedEligible(cleared, { ...prod, qc_json: null }).eligible, false, 'no QC verdict');
  assert.equal(unattendedEligible(cleared, { ...prod, qc_score: 6.5 }).eligible, false, 'below minimum');
  assert.equal(unattendedEligible(cleared, { ...prod, qc_score: 6.5 }, 6).eligible, true, 'configurable minimum');
  assert.equal(unattendedEligible(cleared, { ...prod, qc_json: JSON.stringify({ ok: false, score: 9, checks: [{ name: 'no_black_frames', ok: false, severity: 'block' }] }) }).eligible, false, 'QC failed even with a high score');
  assert.equal(unattendedEligible(cleared, { ...prod, public_url: null }).eligible, false);
});

test('monitor pauses on publishing errors, QC collapse, run failures, budget, breaker, incidents', () => {
  assert.deepEqual(monitorVerdict({ publishErrors24h: 0, qcVerdicts: [true, true, false, true, true, true], consecutiveRunFailures: 0, budgetExhausted: false, breakerTripped: false, platformIncident: false }), []);
  assert.equal(monitorVerdict({ publishErrors24h: 2, qcVerdicts: [], consecutiveRunFailures: 0, budgetExhausted: false, breakerTripped: false, platformIncident: false }).length, 1);
  assert.match(monitorVerdict({ publishErrors24h: 0, qcVerdicts: [false, false, false, false, true, false, false, false], consecutiveRunFailures: 0, budgetExhausted: false, breakerTripped: false, platformIncident: false })[0], /QC pass rate/);
  assert.deepEqual(monitorVerdict({ publishErrors24h: 0, qcVerdicts: [false, false, false], consecutiveRunFailures: 0, budgetExhausted: false, breakerTripped: false, platformIncident: false }), [], 'too few verdicts to judge');
  assert.equal(monitorVerdict({ publishErrors24h: 0, qcVerdicts: [], consecutiveRunFailures: 2, budgetExhausted: true, breakerTripped: true, platformIncident: true }).length, 4);
});

test('Buffer client: a non-draft post needs the authorized autopilot block with a logged decision id', async () => {
  const client = new BufferClient({ apiKey: 'x', fetchImpl: (async () => new Response(JSON.stringify({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p1', status: 'scheduled' } } } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
  const base = { channelId: 'c', text: 't', videoUrl: 'https://m/x.mp4', dueAt: '2026-11-10T11:00:00-06:00', mode: 'customScheduled' as const, saveToDraft: false };
  await assert.rejects(client.createVideoPost(base), /publish guard/);
  await assert.rejects(client.createVideoPost({ ...base, autopilot: { authorization: 'nope', decisionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } }), /publish guard/);
  await assert.rejects(client.createVideoPost({ ...base, autopilot: { authorization: AUTOPILOT_AUTHORIZATION_PHRASE, decisionId: 'short' } }), /publish guard/);
  const post = await client.createVideoPost({ ...base, autopilot: { authorization: AUTOPILOT_AUTHORIZATION_PHRASE, decisionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } });
  assert.equal(post.status, 'scheduled');
  await assert.rejects(client.createVideoPost({ ...base, mode: 'shareNow', autopilot: { authorization: AUTOPILOT_AUTHORIZATION_PHRASE, decisionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } }), /publish guard/, 'immediate publishing is never allowed');
});
