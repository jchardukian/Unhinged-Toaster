import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDogText, REDDIT_DOG_SOURCES, YT_DOG_TAGS } from '../src/steps/discover.js';
import { COMEDY_THRESHOLD, dogCandidateFromMeta, isDuplicateRow, judgeDog, MIN_VERIFIED_VIEWS, rankScore, rightsLabel, velocityScore, type DogRubric } from '../src/steps/dogshortlist.js';

const good: DogRubric = { is_dog_comedy: true, single_clip: true, funny: 8, payoff: 8, clarity: 8, originality: 6, quality: 7, safety_flags: [] };

test('judgeDog accepts a clear single-clip dog payoff and rejects compilations, no payoff, low quality, AI fakes and cruelty', () => {
  const ok = judgeDog(good);
  assert.equal(ok.accepted, true);
  assert.ok(ok.comedy >= COMEDY_THRESHOLD, `comedy ${ok.comedy}`);
  assert.deepEqual(judgeDog({ ...good, single_clip: false }).hard, ['compilation_or_multi_clip']);
  const weak = judgeDog({ ...good, payoff: 2 });
  assert.deepEqual(weak.hard, []); assert.ok(weak.soft.includes('no_clear_payoff'), 'weak payoff is a soft flag: ranked but flagged');
  assert.deepEqual(judgeDog({ ...good, quality: 2 }).hard, ['low_quality_footage']);
  assert.deepEqual(judgeDog({ ...good, ai_generated_suspected: true }).hard, ['ai_generated_suspected']);
  assert.deepEqual(judgeDog({ ...good, is_dog_comedy: false }).hard, ['not_dog_comedy']);
  const cruel = judgeDog({ ...good, safety_flags: ['animal_cruelty'] });
  assert.equal(cruel.comedy, 0); assert.equal(cruel.accepted, false); assert.equal(cruel.hard[0], 'safety:animal_cruelty');
  // cute but no joke: payoff passes the bar yet the blended comedy score falls short (soft)
  const meh = judgeDog({ ...good, funny: 3, payoff: 4, clarity: 5, originality: 3 });
  assert.equal(meh.accepted, false); assert.deepEqual(meh.hard, []); assert.match(meh.soft.join(' '), /comedy \d+(\.\d+)? < 50/);
  // soft flags cost points but do not block
  assert.equal(judgeDog({ ...good, safety_flags: ['copyrighted_music'] }).comedy, judgeDog(good).comedy - 6);
});

test('rank score prefers comedy, then recent momentum; unknown velocity gets no bonus', () => {
  assert.equal(velocityScore(null), 0);
  assert.equal(velocityScore(1), 0);
  assert.equal(velocityScore(100_000), 100);
  assert.ok(velocityScore(1_000) > velocityScore(100));
  assert.ok(rankScore(80, 50_000) > rankScore(80, 500));
  assert.ok(rankScore(90, null) > rankScore(60, 100_000), 'a much funnier clip beats a faster but weaker one');
  assert.equal(rankScore(70, null), 56);
});

test('dogCandidateFromMeta verifies the 1M bar, Shorts length and rights from embedded-player metadata', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  const base = { id: 'abc123def45', title: 'Dog steals the whole pizza 😂', description: 'He waited for this moment', channel: 'Loki & Thor', channel_url: 'https://www.youtube.com/@lokiandthor', view_count: 21_152_618, like_count: 59_852, duration: 15, timestamp: Math.floor(new Date('2026-10-11T12:00:00Z').getTime() / 1000), license: null, age_limit: 0 };
  const ok = dogCandidateFromMeta(base, '#dogs Shorts shelf', now);
  assert.ok(ok.candidate); assert.equal(ok.reason, null);
  assert.equal(ok.candidate!.views, 21_152_618);
  assert.equal(ok.candidate!.rights_status, 'transformation_review');   // standard licence: popularity is not permission
  assert.equal(ok.candidate!.source_url, 'https://www.youtube.com/shorts/abc123def45');
  assert.ok((ok.candidate!.engagement_velocity ?? 0) > 30_000, 'views per hour since upload');
  assert.equal(dogCandidateFromMeta({ ...base, view_count: 999_999 }, 'x', now).reason, 'below_1m_verified');
  assert.equal(dogCandidateFromMeta({ ...base, duration: 61 }, 'x', now).reason, 'too_long_for_short');
  assert.equal(dogCandidateFromMeta({ ...base, duration: 3 }, 'x', now).reason, 'too_short');
  assert.equal(dogCandidateFromMeta({ ...base, view_count: null }, 'x', now).reason, 'no_metadata');
  assert.equal(dogCandidateFromMeta({ ...base, age_limit: 18 }, 'x', now).reason, 'age_limit');
  assert.equal(dogCandidateFromMeta({ ...base, title: '생애 첫 집에 새긴 가장 특별한 흔적' }, 'x', now).reason, 'non_latin_title');
  // upload_date fallback when no timestamp
  const viaDate = dogCandidateFromMeta({ ...base, timestamp: undefined, upload_date: '20261016' }, 'x', now);
  assert.equal(viaDate.candidate!.published_at, '2026-10-16T12:00:00.000Z');
  // compilation / licensing channels are high risk at discovery
  const comp = dogCandidateFromMeta({ ...base, title: 'Funniest dogs compilation 2026 try not to laugh', channel: 'ViralHog' }, 'x', now);
  assert.equal(comp.candidate!.copyright_risk, 'high');
  assert.equal(MIN_VERIFIED_VIEWS, 1_000_000);
});

test('rightsLabel never upgrades: cleared only for cleared, review-eligible within MAX_COPYRIGHT_RISK, blocked otherwise', () => {
  assert.equal(rightsLabel({ rights_status: 'cleared', rights_basis: 'cc_by', copyright_risk: null }, 'medium'), 'cleared (cc_by)');
  assert.match(rightsLabel({ rights_status: 'transformation_review', rights_basis: null, copyright_risk: 'low' }, 'medium'), /^review-eligible/);
  assert.match(rightsLabel({ rights_status: 'transformation_review', rights_basis: null, copyright_risk: null }, 'medium'), /^review-eligible .*risk medium/);
  assert.equal(rightsLabel({ rights_status: 'transformation_review', rights_basis: null, copyright_risk: 'high' }, 'medium'), 'blocked: copyright risk high');
  assert.match(rightsLabel({ rights_status: 'transformation_review', rights_basis: null, copyright_risk: 'medium' }, 'low'), /^blocked: risk medium/);
  assert.equal(rightsLabel({ rights_status: 'unknown', rights_basis: null, copyright_risk: null }, 'medium'), 'unknown');
});

test('isDuplicateRow catches the same URL, near-identical frames and same title+length', () => {
  const a = { url: 'https://www.youtube.com/shorts/a', title: 'Dog steals pizza', duration_sec: 12, phash: ['ffff0000ffff0000'] };
  assert.equal(isDuplicateRow({ ...a }, [a]), 'same_url');
  assert.match(isDuplicateRow({ url: 'https://www.tiktok.com/@x/video/1', title: 'other', duration_sec: 30, phash: ['ffff0000ffff0001'] }, [a]) ?? '', /^frame_phash_1$/);
  assert.match(isDuplicateRow({ url: 'u2', title: 'Dog steals pizza!', duration_sec: 12.5, phash: [] }, [a]) ?? '', /^title_sim/);
  assert.equal(isDuplicateRow({ url: 'u2', title: 'Dog steals pizza!', duration_sec: 40, phash: [] }, [a]), null, 'same title but a different length is a different clip');
  assert.equal(isDuplicateRow({ url: 'u3', title: 'Cat ignores dog', duration_sec: 12, phash: ['0000ffff0000ffff'] }, [a]), null);
});

test('dog keyword filter and source lists', () => {
  assert.equal(isDogText('My husky refuses to leave the park'), true);
  assert.equal(isDogText('Golden retriever puppy meets snow'), true);
  assert.equal(isDogText('Cat knocks over the Christmas tree'), false);
  assert.equal(isDogText('Parrot sings opera'), false);
  assert.ok(YT_DOG_TAGS.includes('funnydogs') && YT_DOG_TAGS.length >= 15);
  assert.ok(REDDIT_DOG_SOURCES.some((s) => s.sub === 'WhatsWrongWithYourDog'));
  assert.ok(REDDIT_DOG_SOURCES.find((s) => s.sub === 'AnimalsBeingDerps')?.filter, 'mixed-animal subs are keyword-filtered');
});
