import fs from 'node:fs';
import path from 'node:path';
import { attributionText, canProduce, findDuplicate, ulid, type Candidate, type Production } from '@toaster/shared';
import { log, type Config } from '../config.js';
import type { Store } from '../store.js';
import { transcribe } from './captions.js';
import { writeCopy } from './copy.js';
import { downloadMedia, extractAudio, ffprobe, videoPhash } from './media.js';
import { loadTemplate, pickMusic, renderShort } from './render.js';
import { scoreCandidate } from './score.js';
import { synthesiseCommentary } from './tts.js';
import { uploadPublic } from './upload.js';

/**
 * Turn ONE cleared, scored candidate into a finished Production:
 * download -> perceptual dedupe -> rights gate -> transcript -> copy -> TTS -> render -> upload.
 * Any failure marks the candidate 'failed' with a reason and returns null.
 */
export async function produceCandidate(cfg: Config, store: Store, c: Candidate): Promise<Production | null> {
  const dir = path.join(cfg.workDir, 'jobs', c.id);
  fs.mkdirSync(dir, { recursive: true });
  const now = () => new Date().toISOString();
  try {
    if (!canProduce(c)) {
      await store.patchCandidate(c.id, { status: 'blocked_rights', status_reason: `rights ${c.rights_status}/${c.rights_basis ?? 'none'}` });
      return null;
    }
    await store.patchCandidate(c.id, { status: 'producing' });

    const src = await downloadMedia(c, dir);
    const probe = await ffprobe(src);
    if (probe.duration < 3) throw new Error(`clip too short (${probe.duration.toFixed(1)}s)`);

    // perceptual dedupe against everything we know
    const phash = await videoPhash(src);
    const existing = (await store.dedupeIndex()).filter((e) => e.id !== c.id);
    const dup = findDuplicate({ source_url: c.source_url, phash, title: c.title, duration_sec: probe.duration }, existing);
    if (dup) {
      await store.patchCandidate(c.id, { status: 'rejected_duplicate', duplicate_of: dup.id, status_reason: dup.reason, phash });
      log.info(`duplicate ${c.id} of ${dup.id} (${dup.reason})`);
      return null;
    }
    await store.patchCandidate(c.id, { phash, duration_sec: probe.duration, width: probe.width, height: probe.height });

    // transcript (for captions + better copy); fine if absent
    const audio = await extractAudio(src, path.join(dir, 'audio.mp3'));
    const transcript = audio ? await transcribe(cfg, audio) : null;

    // copy
    const copy = await writeCopy(cfg, c, transcript?.text);
    const vo = await synthesiseCommentary(cfg, copy.commentary, path.join(dir, 'vo.mp3'));

    // render
    const template = loadTemplate(cfg);
    const outPath = path.join(dir, `${c.id}.final.mp4`);
    const r = await renderShort(cfg, template, {
      clipPath: src, headline: copy.headline, commentary: copy.commentary, voPath: vo, words: transcript?.words ?? null,
      musicPath: pickMusic(cfg, c.category), outPath, workDir: dir,
    });

    // upload
    const key = `renders/${c.id}/${path.basename(outPath)}`;
    const up = await uploadPublic(cfg, outPath, key, 'video/mp4');
    const thumb = await uploadPublic(cfg, r.thumbnailPath, key.replace(/\.mp4$/, '.jpg'), 'image/jpeg');

    const attribution = attributionText(c);
    const prod: Production = {
      id: ulid(), candidate_id: c.id, headline: copy.headline, commentary: copy.commentary,
      caption_text: [copy.caption, attribution].filter(Boolean).join('\n\n'),
      hashtags: JSON.stringify(copy.hashtags), voice_id: cfg.elevenVoiceId ?? null,
      music_track: null, r2_key: up.uploaded ? key : null, public_url: up.uploaded ? up.url : null,
      thumbnail_url: thumb.uploaded ? thumb.url : null, duration_sec: r.durationSec,
      render_log: JSON.stringify({ transcriptWords: transcript?.words.length ?? 0, vo: !!vo, cmd: r.command.slice(0, 12) }),
      created_at: now(), updated_at: now(),
    };
    await store.upsertProduction(prod);
    await store.patchCandidate(c.id, { status: 'produced', attribution_text: attribution, status_reason: up.uploaded ? null : 'local_only_no_r2' });
    log.info(`produced ${c.id}: "${copy.headline}" (${r.durationSec.toFixed(1)}s)`);
    return prod;
  } catch (e) {
    const msg = (e as Error).message.split('\n')[0].slice(0, 300);
    log.error(`produce ${c.id} failed: ${msg}`);
    await store.patchCandidate(c.id, { status: 'failed', status_reason: msg });
    return null;
  }
}

/** Score all 'discovered' candidates. Returns count that passed. */
export async function scoreAll(cfg: Config, store: Store, limit = 200): Promise<number> {
  const weights = await store.weights();
  const cands = await store.listCandidates({ status: ['discovered'], limit });
  let passed = 0;
  for (const c of cands) {
    const scored = await scoreCandidate(cfg, c, weights);
    await store.upsertCandidates([scored]);
    if (scored.status === 'scored') passed++;
  }
  log.info(`scored ${cands.length} candidates, ${passed} passed`);
  return passed;
}

/** Produce until we have `target` productions not yet attached to a post. */
export async function produceUntil(cfg: Config, store: Store, target: number): Promise<number> {
  const unposted = await unpostedProductions(store);
  let have = unposted.length;
  if (have >= target) return have;
  const ready = (await store.listCandidates({ status: ['scored', 'ready'] })).filter(canProduce);
  log.info(`need ${target - have} more productions; ${ready.length} cleared candidates available`);
  for (const c of ready) {
    if (have >= target) break;
    const p = await produceCandidate(cfg, store, c);
    if (p) have++;
  }
  return have;
}

export async function unpostedProductions(store: Store) {
  const prods = await store.listProductions();
  const posts = await store.listPosts();
  const used = new Set(posts.filter((p) => p.state !== 'deleted').map((p) => p.production_id));
  return prods.filter((p) => !used.has(p.id) && p.public_url).sort((a, b) => a.created_at.localeCompare(b.created_at));
}
