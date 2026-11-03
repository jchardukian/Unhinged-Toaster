import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWeekPlan, isoWeek, toBufferDueAt, zonedTimeToUtc, parseSlots } from '../src/schedule.js';
import { canProduce, initialRights, attributionText } from '../src/rights.js';
import { wrapText, escapeDrawtext, clampSentence, containsSlur, normaliseHashtags } from '../src/text.js';

test('buildWeekPlan yields 21 slots x 2 services for next week in Chicago time', () => {
  const plan = buildWeekPlan(new Date('2026-11-02T20:00:00Z'), 'America/Chicago', '11:00,15:00,19:00');
  assert.equal(plan.week, '2026-W46');
  assert.equal(plan.slots.length, 42);
  const yt = plan.slots.filter((s) => s.service === 'youtube');
  assert.equal(yt.length, 21);
  // Monday Nov 9 2026 11:00 Chicago (CST, UTC-6) = 17:00Z
  assert.equal(yt[0].slot_at, '2026-11-09T17:00:00.000Z');
  assert.equal(yt[20].slot_at, '2026-11-16T01:00:00.000Z'); // Sunday 19:00 CST
});

test('DST handling in zonedTimeToUtc', () => {
  // 2026-03-08 is DST start in the US; 11:00 CDT = 16:00Z
  assert.equal(zonedTimeToUtc(2026, 3, 9, 11, 0, 'America/Chicago').toISOString(), '2026-03-09T16:00:00.000Z');
  assert.equal(zonedTimeToUtc(2026, 11, 9, 11, 0, 'America/Chicago').toISOString(), '2026-11-09T17:00:00.000Z');
});

test('toBufferDueAt formats with local offset', () => {
  assert.equal(toBufferDueAt('2026-11-09T17:00:00.000Z', 'America/Chicago'), '2026-11-09T11:00:00-06:00');
  assert.equal(isoWeek(new Date('2026-01-01T00:00:00Z')), '2026-W01');
});

test('parseSlots validates', () => {
  assert.throws(() => parseSlots('11:00,15:00'));
  assert.equal(parseSlots('9:00,15:00,19:30')[2].mm, 30);
});

test('rights policy never clears unknown sources', () => {
  const reddit = initialRights('reddit', {});
  assert.equal(reddit.rights_status, 'unknown');
  assert.equal(canProduce({ ...reddit }), false);
  const yt = initialRights('youtube', { license: 'creativeCommon' });
  assert.equal(canProduce({ ...yt }), true);
  assert.equal(canProduce({ rights_status: 'cleared', rights_basis: 'cc_by', rights_evidence: '' }), false, 'evidence required');
  assert.equal(canProduce({ rights_status: 'cleared', rights_basis: null, rights_evidence: 'x' }), false, 'basis required');
  assert.match(attributionText({ author: 'someone', source_url: 'https://x', rights_basis: 'cc_by', source_platform: 'youtube' }), /CC BY/);
});

test('text helpers', () => {
  assert.deepEqual(wrapText('THIS DOG HAS NO CHILL WHATSOEVER TODAY', 14, 3), ['THIS DOG HAS', 'NO CHILL', 'WHATSOEVER…']);
  assert.equal(escapeDrawtext("it's 100%: ok, [x]"), 'it’s 100\\%\\: ok\\, \\[x\\]');
  assert.equal(clampSentence('a'.repeat(50) + ' ' + 'b'.repeat(80), 60).length <= 61, true);
  assert.equal(containsSlur('what a lovely day'), false);
  assert.deepEqual(normaliseHashtags(['#Funny', 'funny', 'fail!!', 'dogs'], 3), ['Funny', 'fail', 'dogs']);
});
