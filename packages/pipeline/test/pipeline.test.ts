import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAss, assColor, isHallucination } from '../src/steps/captions.js';
import { validate, fallback } from '../src/steps/copy.js';
import { fmtCount, isoDurationSec, latinRatio, parseRedditCandidate, viewsPerHour, ytViralBucket } from '../src/steps/discover.js';
import { ytdlpCommonArgs } from '../src/steps/media.js';
import { postText } from '../src/steps/publish.js';
import { JsonStore } from '../src/store.js';
import { parseJson } from '../src/llm.js';
import type { Candidate, Production } from '@toaster/shared';

test('buildAss chunks words and emits karaoke tags', () => {
  const words = [
    { word: 'Okay', start: 0.1, end: 0.4 }, { word: 'watch', start: 0.45, end: 0.7 }, { word: 'this', start: 0.72, end: 0.9 },
    { word: 'the', start: 1.3, end: 1.4 }, { word: 'dog', start: 1.45, end: 1.8 },
  ];
  const ass = buildAss(words, { fontName: 'Bangers', fontSize: 66, marginV: 700, primary: assColor('#FFD400'), secondary: assColor('#FFFFFF'), outline: assColor('#111111'), playResX: 1080, playResY: 1920 });
  const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\{\\kf30\}OKAY \{\\kf25\}WATCH \{\\kf18\}THIS/);
  assert.match(lines[0], /^Dialogue: 0,0:00:00\.10,0:00:00\.98,Toast/);
  assert.match(ass, /PrimaryColour.*\n.*&H0000D4FF/);
});

test('assColor converts RGB hex to ASS BGR', () => {
  assert.equal(assColor('#FFD400'), '&H0000D4FF');
  assert.equal(assColor('#111111', 0x80), '&H80111111');
});

test('copy validation enforces limits and falls back', () => {
  assert.equal(validate({ headline: 'x'.repeat(61), commentary: 'ok.', caption: '', hashtags: [] }), null);
  assert.equal(validate({ headline: 'Fine', commentary: 'Two. Sentences.', caption: '', hashtags: [] }), null);
  const ok = validate({ headline: '"Wait" for it', commentary: 'This dog just robbed a pizzeria and I respect it!', caption: 'c', hashtags: ['#Funny', 'dogs'] });
  assert.equal(ok?.headline, 'Wait for it');
  assert.deepEqual(ok?.hashtags, ['Funny', 'dogs']);
  const fb = fallback({ category: 'funny_animals' } as Candidate);
  assert.ok(fb.headline.length <= 60 && fb.commentary.length <= 110);
});

test('isoDurationSec and reddit parsing', () => {
  assert.equal(isoDurationSec('PT1M5S'), 65);
  assert.equal(isoDurationSec('PT45S'), 45);
  const rv = { fallback_url: 'https://v.redd.it/abc/DASH_720.mp4?source=fallback', duration: 12, width: 720, height: 1280 };
  const post = { id: 'x1', title: 'Cat vs cucumber', author: 'someone', permalink: '/r/funny/comments/x1/cat_vs_cucumber/', url: '', created_utc: 1762000000, score: 5400, upvote_ratio: 0.97, num_comments: 120, over_18: false, is_video: true, subreddit: 'funny' } as any;
  const c = parseRedditCandidate(post, post, rv, 'funny_animals', '2026-11-02T00:00:00Z');
  assert.equal(c.rights_status, 'transformation_review', 'reddit footage goes to the labelled review path, never cleared');
  assert.equal(c.rights_basis, null);
  assert.equal(c.source_url, 'https://www.reddit.com/r/funny/comments/x1/cat_vs_cucumber/');
  assert.equal(c.likes, 5400);
  assert.equal(c.status, 'discovered');
});

test('postText: creator credit, source URL, edit summary, contact e-mail, hashtags, AI disclosure; never internal review text', () => {
  const p: Production = { id: 'p', candidate_id: 'c', headline: 'H', commentary: 'C', caption_text: 'Caption.', hashtags: JSON.stringify(['funny', 'dogs']), voice_id: 'v', music_track: null, r2_key: null, public_url: null, thumbnail_url: null, duration_sec: 10, render_log: '{"vo":true}', created_at: '', updated_at: '' };
  const review = { author: 'poster1', source_url: 'https://www.reddit.com/r/funny/comments/abc/x/', source_platform: 'reddit', rights_status: 'transformation_review', rights_basis: null, copyright_risk: 'medium', copyright_risk_reasons: '["x"]' } as Candidate;
  const t = postText(p, review, 'tiktok');
  assert.match(t, /🎬 Original clip: u\/poster1 — https:\/\/www\.reddit\.com\/r\/funny\/comments\/abc\/x\//);
  assert.match(t, /✂️ Edited by The Unhinged Toaster: original comedic commentary, cuts, zooms/);
  assert.match(t, /📩 Copyright inquiries, credit corrections or removal requests: theunhingedtoaster@gmail\.com/);
  assert.match(t, /#funny #dogs/);
  assert.match(t, /AI-generated/);
  assert.doesNotMatch(t, /fair use|licen[cs]ed|authori[sz]ed|REVIEW|transformation review|copyright risk/i, 'no authorisation claim and no internal review text');
  assert.ok(t.length <= 2100);
  const cleared = { ...review, rights_status: 'cleared', rights_basis: 'cc_by', source_platform: 'youtube', author: 'Jess & Biscuit' } as Candidate;
  assert.match(postText(p, cleared, 'youtube'), /Creative Commons Attribution/);
  assert.match(postText(p, cleared, 'youtube'), /Original clip: Jess & Biscuit/);
  const noVoice = { ...p, voice_id: null, render_log: '{"vo":false}' };
  assert.doesNotMatch(postText(noVoice, cleared, 'youtube'), /AI-generated/);
  assert.throws(() => postText({ ...p, caption_text: 'x ⚠️ REVIEW BEFORE APPROVING y' }, cleared, 'youtube'), /never reach a public caption/);
});

test('JsonStore round-trips candidates, patches, posts and weights', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toaster-'));
  const s = new JsonStore(path.join(dir, 'db.json'));
  const c = { id: 'A', source_platform: 'reddit', source_id: 'r1', source_url: 'https://reddit.com/r/x/comments/r1', title: 't', status: 'discovered', rights_status: 'unknown', updated_at: '', discovered_at: '' } as Candidate;
  await s.upsertCandidates([c]);
  await s.upsertCandidates([{ ...c, id: 'B', title: 'renamed' }]); // same source id -> update, keep id
  const all = await s.listCandidates();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'A');
  assert.equal(all[0].title, 'renamed');
  await s.patchCandidate('A', { status: 'scored', final_score: 70 });
  assert.equal((await s.listCandidates({ status: ['scored'] })).length, 1);
  const w = await s.weights();
  assert.equal(w.length, 4);
  const s2 = new JsonStore(path.join(dir, 'db.json'));
  assert.equal((await s2.getCandidate('A'))?.final_score, 70);
});

test('parseJson tolerates code fences and prose', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure! {"a":2} hope that helps'), { a: 2 });
});

test('isHallucination drops Whisper artefacts and keeps real speech', () => {
  const w = (n: number) => Array.from({ length: n }, (_, i) => ({ word: 'x', start: i * 0.4, end: i * 0.4 + 0.3 }));
  assert.equal(isHallucination('ぽんぽこ ぽんぽこ ぽんぽこ ぽんぽこ', w(4)), 'non_latin_script');
  assert.equal(isHallucination('Thanks for watching!', w(3)), 'stock_phrase');
  assert.equal(isHallucination('More videos available from our channel.', w(6)), 'stock_phrase');
  assert.equal(isHallucination('no no no no no no no no', w(8)), 'repetitive');
  assert.equal(isHallucination('Okay watch this, the dog is about to steal the pizza', w(10)), null);
});

test('parseRedditAtom extracts post id, author, permalink and v.redd.it media id from the public feed', async () => {
  const { parseRedditAtom } = await import('../src/steps/discover.js');
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><author><name>/u/someone</name></author>
<content type="html">&lt;a href="https://v.redd.it/abc123xyz"&gt;[link]&lt;/a&gt;</content><id>t3_1xhqbt0</id>
<link href="https://www.reddit.com/r/Unexpected/comments/1xhqbt0/either_way_counts/" /><published>2026-11-01T10:00:00+00:00</published>
<title>Either way counts &amp; more</title></entry><entry><title>Text post</title><link href="https://www.reddit.com/r/x/comments/zzz/t/" /><content type="html">no video</content></entry></feed>`;
  const e = parseRedditAtom(xml);
  assert.equal(e.length, 2);
  assert.equal(e[0].postId, '1xhqbt0');
  assert.equal(e[0].author, 'someone');
  assert.equal(e[0].mediaId, 'abc123xyz');
  assert.equal(e[0].title, 'Either way counts & more');
  assert.equal(e[1].mediaId, null);
});

test('parseRedditMpd picks the highest video rendition and audio from the DASH manifest', async () => {
  const { parseRedditMpd } = await import('../src/steps/media.js');
  const mpd = `<MPD><Period><AdaptationSet><Representation bandwidth="230432" height="390" width="220"><BaseURL>CMAF_220.mp4</BaseURL></Representation>
<Representation bandwidth="1712576" height="1280" width="720"><BaseURL>CMAF_720.mp4</BaseURL></Representation>
<Representation bandwidth="712576" height="638" width="360"><BaseURL>CMAF_360.mp4</BaseURL></Representation></AdaptationSet>
<AdaptationSet><Representation bandwidth="69121"><BaseURL>CMAF_AUDIO_64.mp4</BaseURL></Representation><Representation bandwidth="134591"><BaseURL>CMAF_AUDIO_128.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`;
  const r = parseRedditMpd(mpd);
  assert.equal(r.video[0].file, 'CMAF_720.mp4');
  assert.equal(r.video[0].height, 1280);
  assert.equal(r.audio[0], 'CMAF_AUDIO_128.mp4');
});

test('youtube viral: a clip lands in the freshest window it qualifies for', () => {
  const all: ('today' | 'week' | 'month' | 'alltime')[] = ['today', 'week', 'month', 'alltime'];
  assert.equal(ytViralBucket(all, 10, 25_000), 'today');
  assert.equal(ytViralBucket(all, 10, 5_000), null);          // fresh but not viral yet; alltime needs 1M
  assert.equal(ytViralBucket(all, 5 * 24, 150_000), 'week');
  assert.equal(ytViralBucket(all, 20 * 24, 900_000), 'month');
  assert.equal(ytViralBucket(all, 200 * 24, 40_000_000), 'alltime');
  assert.equal(ytViralBucket(['alltime'], 10, 25_000), null);   // window not requested
  assert.equal(ytViralBucket(['week'], 5 * 24, 2_000_000), 'week');
  assert.equal(ytViralBucket(['today'], null, 2_000_000), null); // no upload date => cannot claim fresh
});

test('youtube viral: non-Latin titles are skipped, velocity is views per hour, counts format', () => {
  assert.ok(latinRatio('He Copied the Door Prank… Instant Karma 😂🚪 #shorts') > 0.9);
  assert.ok(latinRatio('ลำไยทำไมขายแพงกว่าคนอื่น #funny') < 0.6);
  assert.equal(latinRatio('😂😂 #1'), 1);
  const now = new Date('2026-11-04T12:00:00Z');
  assert.equal(viewsPerHour(240000, new Date('2026-11-03T12:00:00Z'), now), 10000);
  assert.equal(viewsPerHour(500, new Date('2026-11-04T11:59:00Z'), now), 500); // never divides by less than an hour
  assert.equal(viewsPerHour(null, now, now), null);
  assert.equal(fmtCount(23475026), '23M'); assert.equal(fmtCount(1_500_000), '1.5M'); assert.equal(fmtCount(2300), '2.3k'); assert.equal(fmtCount(42), '42');
});

test('yt-dlp args: node runtime registered for YouTube, default player clients unless overridden, cookies only when exported', () => {
  const yt = ytdlpCommonArgs(true, {});
  assert.ok(yt.includes('--js-runtimes') && yt[yt.indexOf('--js-runtimes') + 1].startsWith('node:'));
  assert.ok(!yt.some((a) => a.startsWith('youtube:player_client=')));
  assert.ok(yt.includes('youtubetab:approximate_date'));
  const pinned = ytdlpCommonArgs(true, { YTDLP_YOUTUBE_CLIENTS: 'android,web' });
  assert.ok(pinned.includes('youtube:player_client=android,web'));
  assert.deepEqual(ytdlpCommonArgs(false, {}), []);
  assert.deepEqual(ytdlpCommonArgs(true, { YTDLP_JS_RUNTIME: 'none' }).filter((a) => a === '--js-runtimes'), []);
});
