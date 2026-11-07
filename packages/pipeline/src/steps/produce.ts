import fs from 'node:fs';
import path from 'node:path';
import { broadcastRisk, creditText, findDuplicate, planEdit, productionBasis, qualityTier, ulid, type Candidate, type CommentaryMode, type Production, type RightsPolicy } from '@toaster/shared';
import { analyzeClip } from './analyze.js';
import { contactSheet, readWatermark, sheetBase64, sheetPathFor } from './frames.js';
import { log, type Config } from '../config.js';
import type { Store } from '../store.js';
import { transcribe } from './captions.js';
import { writeCopy } from './copy.js';
import { downloadMedia, extractAudio, ffprobe, mediaDuration, videoPhash } from './media.js';
import { loadTemplate, pickMusic, renderShort } from './render.js';
import { scoreCandidate } from './score.js';
import { planSfx } from './sfx.js';
import { synthesiseCommentary } from './tts.js';
import { uploadPublic } from './upload.js';
import { withRetry } from '../retry.js';
import { costOf, currentUsage, recordRender, recordUpload } from '../usage.js';
import { assertBudget, isFatal, TIMEOUTS, withTimeout } from '../guard.js';

/**
 * Turn ONE cleared, scored candidate into a finished Production:
 * download -> perceptual dedupe -> rights gate -> transcript -> copy -> TTS -> render -> upload.
 * Any failure marks the candidate 'failed' with a reason and returns null.
 */
export function rightsPolicy(cfg: Config): RightsPolicy {
  return { transformationReview: cfg.transformationReview, maxCopyrightRisk: cfg.maxCopyrightRisk };
}

/** Longest source we turn into a Short: the template limit plus a few seconds the edit plan can absorb. */
export function maxSourceSec(cfg: Config): number { return loadTemplate(cfg).limits.maxDurationSec + 6; }

export async function produceCandidate(cfg: Config, store: Store, cIn: Candidate, opts: { allowOkTier?: boolean } = {}): Promise<Production | null> {
  assertBudget(`produce ${cIn.id}`);
  try {
    return await withTimeout(produceCandidateInner(cfg, store, cIn, opts), TIMEOUTS.produceMs, `produce ${cIn.id}`);
  } catch (e) {
    if (isFatal(e)) { await store.patchCandidate(cIn.id, { status: 'scored', status_reason: `run aborted: ${(e as Error).message.slice(0, 160)}` }); throw e; }
    await store.patchCandidate(cIn.id, { status: 'failed', status_reason: (e as Error).message.split('\n')[0].slice(0, 300) });
    log.error(`produce ${cIn.id} failed: ${(e as Error).message.split('\n')[0].slice(0, 300)}`);
    return null;
  }
}

async function produceCandidateInner(cfg: Config, store: Store, cIn: Candidate, opts: { allowOkTier?: boolean } = {}): Promise<Production | null> {
  let c = cIn;
  const costAtStart = costOf(currentUsage()).total_usd;
  const dir = path.join(cfg.workDir, 'jobs', c.id);
  fs.mkdirSync(dir, { recursive: true });
  const now = () => new Date().toISOString();
  try {
    const basis = productionBasis(c, rightsPolicy(cfg));
    if (!basis) {
      await store.patchCandidate(c.id, { status: 'blocked_rights', status_reason: `rights ${c.rights_status}/${c.rights_basis ?? 'none'}${c.copyright_risk ? ` risk ${c.copyright_risk}` : ''}` });
      return null;
    }
    await store.patchCandidate(c.id, { status: 'producing' });

    const src = await withRetry(`download ${c.id}`, () => downloadMedia(c, dir), { attempts: 3, baseMs: 3000 });
    const probe = await ffprobe(src);
    if (probe.duration < 3) throw new Error(`clip too short (${probe.duration.toFixed(1)}s)`);
    if (probe.duration > maxSourceSec(cfg)) {
      // No automatic sub-clipping: cutting a 2-minute clip at 59 s loses the payoff. Reddit feeds carry no duration, so this is where it shows up.
      await store.patchCandidate(c.id, { status: 'rejected_quality', duration_sec: probe.duration, width: probe.width, height: probe.height, status_reason: `too long for a Short (${probe.duration.toFixed(0)}s > ${maxSourceSec(cfg)}s; no auto-trim)` });
      log.info(`rejected ${c.id}: ${probe.duration.toFixed(0)}s is longer than a Short`);
      return null;
    }
    const tier = qualityTier(probe.width, probe.height);
    if (tier === 'low' && !cfg.allowLowQuality) {
      await store.patchCandidate(c.id, { status: 'rejected_quality', quality_tier: tier, width: probe.width, height: probe.height, status_reason: `source ${probe.width}x${probe.height} below 720p-class` });
      log.info(`rejected ${c.id}: quality ${probe.width}x${probe.height} (${tier})`);
      return null;
    }
    if (tier === 'ok' && opts.allowOkTier === false) {
      await store.patchCandidate(c.id, { status: 'scored', quality_tier: tier, width: probe.width, height: probe.height, status_reason: 'held: 720p-class, used only when 1080p stock runs out' });
      log.info(`held ${c.id}: ${probe.width}x${probe.height} is 720p-class; preferring 1080p sources`);
      return null;
    }
    await store.patchCandidate(c.id, { quality_tier: tier });

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

    // vision pass: contact sheet -> re-score with frames (detects watermarks / real creator, grounds the copy in what happens)
    const sheet = await contactSheet(src, sheetPathFor(dir)).catch(() => null);
    const frames = sheet ? sheetBase64(sheet) : undefined;
    if (frames) {
      const rescored = await scoreCandidate(cfg, { ...c, status: 'discovered' }, await store.weights(), transcript?.text, frames);
      if (rescored.status === 'rejected_safety' || rescored.status === 'blocked_rights' || rescored.status === 'rejected_score') {
        await store.patchCandidate(c.id, { status: rescored.status, status_reason: `vision pass: ${rescored.status_reason}`, copyright_risk: rescored.copyright_risk, copyright_risk_reasons: rescored.copyright_risk_reasons, detected_handle: rescored.detected_handle ?? null, detected_platform: rescored.detected_platform ?? null, visual_summary: rescored.visual_summary ?? null });
        log.info(`vision pass stopped ${c.id}: ${rescored.status} (${rescored.status_reason})`);
        return null;
      }
      c = { ...c, llm_score: rescored.llm_score, final_score: rescored.final_score, llm_rationale: rescored.llm_rationale, safety_flags: rescored.safety_flags, copyright_risk: rescored.copyright_risk, copyright_risk_reasons: rescored.copyright_risk_reasons, detected_handle: rescored.detected_handle ?? null, detected_platform: rescored.detected_platform ?? null, visual_summary: rescored.visual_summary ?? null };
      await store.patchCandidate(c.id, { llm_score: c.llm_score, final_score: c.final_score, llm_rationale: c.llm_rationale, safety_flags: c.safety_flags, copyright_risk: c.copyright_risk, copyright_risk_reasons: c.copyright_risk_reasons, detected_handle: c.detected_handle, detected_platform: c.detected_platform, visual_summary: c.visual_summary });
      // hard backstop: broadcast / pro-sports / TV footage seen by the vision pass or heard in the transcript is never produced
      const b = broadcastRisk(`${c.title}\n${c.description ?? ''}\n${c.visual_summary ?? ''}\n${transcript?.text.slice(0, 400) ?? ''}`);
      if (b.high && c.rights_status !== 'cleared') {
        await store.patchCandidate(c.id, { status: 'blocked_rights', copyright_risk: 'high', copyright_risk_reasons: JSON.stringify(b.reasons), status_reason: `broadcast/pro footage: ${b.reasons.join(', ').slice(0, 160)}` });
        log.info(`blocked ${c.id}: broadcast/pro footage (${b.reasons[0]})`);
        return null;
      }
      // the scorer only flags that a watermark exists; the exact handle comes from the two-frame reader (or stays null)
      const wm = await readWatermark(cfg, src, dir);
      c = { ...c, detected_handle: wm?.handle ?? null, detected_platform: wm?.platform ?? c.detected_platform ?? null };
      await store.patchCandidate(c.id, { detected_handle: c.detected_handle, detected_platform: c.detected_platform });
      if (c.detected_handle) log.info(`vision: footage credits @${c.detected_handle}${c.detected_platform ? ` (${c.detected_platform})` : ''}; crediting them`);
      else if (c.detected_platform) log.info(`vision: ${c.detected_platform} watermark seen but handle not readable with confidence; not credited by name`);
    }

    // copy + edit direction
    const copy = await writeCopy(cfg, c, transcript?.text, frames);
    const commentaryMode: CommentaryMode = cfg.commentaryDefault === 'never' ? 'none' : cfg.commentaryDefault === 'always' ? 'outro_voice' : (copy.commentary_mode ?? 'outro_voice');
    const vo = commentaryMode === 'outro_voice' ? await synthesiseCommentary(cfg, copy.commentary, path.join(dir, 'vo.mp3')) : null;

    // clip-specific edit plan: detected peak moment -> freeze / punch-in / replay / sticker
    const template = loadTemplate(cfg);
    const analysis = await analyzeClip(src);
    const flags = (JSON.parse(c.safety_flags ?? '[]') as string[]);
    const muteSource = flags.includes('copyrighted_music');
    const voDur = vo ? (await mediaDuration(vo)) ?? 3 : 0;
    const outroSec = commentaryMode === 'none' || template.commentary.position === 'intro' ? 0 : Math.max(template.commentary.outroSeconds, voDur + 0.5);
    const timeline = planEdit({
      sourceDuration: Math.min(probe.duration, template.limits.maxDurationSec - outroSec),
      peak: analysis.peak?.t ?? null,
      maxTotal: template.limits.maxDurationSec - outroSec,
      style: copy.edit_style ?? 'full',
      stickerText: cfg.stickers ? copy.sticker ?? null : null,
      freezeText: copy.freeze_text ?? null,
      muteSource,
      hasSpeech: (transcript?.words.length ?? 0) >= 6,
    });
    log.info(`edit plan ${c.id}: ${describeBeats(timeline.beats)}${timeline.dropped.length ? ` (dropped: ${timeline.dropped.join(', ')})` : ''}`);

    // render
    const outPath = path.join(dir, `${c.id}.final.mp4`);
    const renderStart = Date.now();
    // comedic sound effects on the edit beats (freeze -> record scratch, punch-in -> boing/thud, replay -> whoosh); only
    // when the real library exists (SFX_PROVIDER=elevenlabs built it) or placeholders were explicitly chosen (synth)
    const sfx = planSfx(cfg, timeline.beats, timeline.map, { category: c.category });
    const r = await withRetry(`render ${c.id}`, () => renderShort(cfg, template, {
      clipPath: src, headline: copy.headline, commentary: copy.commentary, commentaryMode, voPath: vo, words: transcript?.words ?? null,
      musicPath: cfg.musicDefault === 'never' ? null : (copy.music === 'none' && cfg.musicDefault !== 'always') ? null : pickMusic(cfg, c.category), outPath, workDir: dir, timeline, sfx,
    }), { attempts: 2, baseMs: 1000 });
    recordRender((Date.now() - renderStart) / 1000);
    recordUpload(fs.statSync(outPath).size + (fs.existsSync(r.thumbnailPath) ? fs.statSync(r.thumbnailPath).size : 0));

    // upload
    const key = `renders/${c.id}/${path.basename(outPath)}`;
    const up = await withRetry(`upload ${c.id}`, () => uploadPublic(cfg, outPath, key, 'video/mp4'), { attempts: 3, baseMs: 2000 });
    const thumb = await withRetry(`upload thumb ${c.id}`, () => uploadPublic(cfg, r.thumbnailPath, key.replace(/\.mp4$/, '.jpg'), 'image/jpeg'), { attempts: 3, baseMs: 2000 });

    const attribution = creditText(c, { contactEmail: cfg.contactEmail });
    const prod: Production = {
      id: ulid(), candidate_id: c.id, headline: copy.headline, commentary: copy.commentary,
      caption_text: copy.caption,
      hashtags: JSON.stringify(copy.hashtags), voice_id: vo ? cfg.elevenVoiceId ?? 'auto' : null,
      music_track: null, r2_key: up.uploaded ? key : null, public_url: up.uploaded ? up.url : null,
      thumbnail_url: thumb.uploaded ? thumb.url : null, duration_sec: r.durationSec,
      render_log: JSON.stringify({ transcriptWords: transcript?.words.length ?? 0, vo: !!vo, commentaryMode, peak: analysis.peak, dropped: timeline.dropped, sfx: sfx.map((s) => `${path.basename(s.path)}@${s.at.toFixed(2)}`), cmd: r.command.slice(0, 12) }),
      reuse_basis: basis,
      edit_plan: JSON.stringify(timeline.beats),
      content_format: c.content_format ?? 'general_viral',
      production_cost_usd: Math.round((costOf(currentUsage()).total_usd - costAtStart) * 10000) / 10000,
      created_at: now(), updated_at: now(),
    };
    await store.upsertProduction(prod);
    await store.patchCandidate(c.id, { status: 'produced', attribution_text: attribution, status_reason: up.uploaded ? (basis === 'review' ? 'transformation_review' : null) : 'local_only_no_r2' });
    log.info(`produced ${c.id} [${basis}]: "${copy.headline}" (${r.durationSec.toFixed(1)}s)`);
    return prod;
  } catch (e) {
    if (isFatal(e)) throw e; // budget / breaker: handled by the wrapper, aborts the run
    const msg = (e as Error).message.split('\n')[0].slice(0, 300);
    log.error(`produce ${c.id} failed: ${msg}`);
    await store.patchCandidate(c.id, { status: 'failed', status_reason: msg });
    return null;
  }
}

/** Score all 'discovered' candidates. Returns count that passed. */
export interface ScoreStats { attempted: number; scored: number; passed: number; errors: number }

/**
 * Score 'discovered' candidates. Candidates whose LLM call failed stay 'discovered' with an llm_error reason and are
 * retried next run; a budget or breaker error aborts the loop (and the command) after storing what was done.
 */
export async function scoreAll(cfg: Config, store: Store, limit = 200): Promise<ScoreStats> {
  const weights = await store.weights();
  const cands = await store.listCandidates({ status: ['discovered'], limit });
  const stats: ScoreStats = { attempted: 0, scored: 0, passed: 0, errors: 0 };
  for (const c of cands) {
    stats.attempted++;
    const scored = await scoreCandidate(cfg, c, weights);
    await store.upsertCandidates([scored]);
    if (scored.status === 'discovered') stats.errors++; else stats.scored++;
    if (scored.status === 'scored') stats.passed++;
    if (stats.errors >= 5 && stats.scored === 0) throw new Error(`scoring: the first ${stats.errors} LLM calls all failed (${scored.status_reason}); stopping before the rest of the list`);
  }
  log.info(`scored ${stats.scored}/${stats.attempted} candidates, ${stats.passed} passed, ${stats.errors} LLM errors (left for the next run)`);
  return stats;
}

/** Give candidates that were never really scored (LLM error, or the old heuristic-only path) another chance. */
export async function rescoreUnscored(store: Store): Promise<number> {
  const all = await store.listCandidates();
  const stale = all.filter((c) => (c.status === 'rejected_score' || c.status === 'scored') && c.llm_score == null && (!c.status_reason || /^(heuristic_only|llm_error)/.test(c.status_reason)));
  for (const c of stale) await store.patchCandidate(c.id, { status: 'discovered', status_reason: 'rescore: previous run had no LLM score' });
  if (stale.length) log.info(`rescore: ${stale.length} candidate(s) returned to 'discovered' (they had no LLM score)`);
  return stale.length;
}

/** Produce until we have `target` productions not yet attached to a post. */
export async function produceUntil(cfg: Config, store: Store, target: number): Promise<number> {
  // a run that died mid-render (timeout, OOM) leaves candidates in 'producing'; they are good candidates, give them back
  for (const stale of await store.listCandidates({ status: ['producing'] })) await store.patchCandidate(stale.id, { status: 'scored', status_reason: 'recovered from an interrupted run' });
  const unposted = await unpostedProductions(store);
  let have = unposted.length;
  if (have >= target) return have;
  const policy = rightsPolicy(cfg);
  const ready = (await store.listCandidates({ status: ['scored', 'ready'] })).filter((c) => productionBasis(c, policy) !== null);
  // 1080p-class sources first (known from discovery metadata or a previous probe); 720p-class only if still short.
  const tierOf = (c: Candidate) => c.quality_tier ?? qualityTier(c.width, c.height);
  const hdOrUnknown = ready.filter((c) => tierOf(c) !== 'ok' && tierOf(c) !== 'low');
  const okOnly = ready.filter((c) => tierOf(c) === 'ok');
  log.info(`need ${target - have} more productions; ${hdOrUnknown.length} 1080p-class/unprobed + ${okOnly.length} 720p-class candidates available`);
  for (const c of hdOrUnknown) {
    if (have >= target) break;
    const p = await produceCandidate(cfg, store, c, { allowOkTier: false });
    if (p) have++;
  }
  if (have < target && okOnly.length) {
    log.warn(`1080p-class stock exhausted; falling back to ${okOnly.length} 720p-class candidate(s)`);
    const held = (await store.listCandidates({ status: ['scored', 'ready'] })).filter((c) => tierOf(c) === 'ok' && productionBasis(c, policy) !== null);
    for (const c of held) {
      if (have >= target) break;
      const p = await produceCandidate(cfg, store, c, { allowOkTier: true });
      if (p) have++;
    }
  }
  return have;
}

/** Finished productions not yet attached to a live post, best candidate score first (viral-first), then oldest. */
export async function unpostedProductions(store: Store) {
  const prods = await store.listProductions();
  const posts = await store.listPosts();
  const used = new Set(posts.filter((p) => p.state !== 'deleted').map((p) => p.production_id));
  const scores = new Map((await store.listCandidates()).map((c) => [c.id, c.final_score ?? 0]));
  // a candidate re-rendered by hand (`produce --id`) has several production rows: only its newest one is offered
  const newestPerCandidate = new Map<string, Production>();
  for (const p of prods) { const cur = newestPerCandidate.get(p.candidate_id); if (!cur || p.created_at > cur.created_at) newestPerCandidate.set(p.candidate_id, p); }
  return prods.filter((p) => !used.has(p.id) && p.public_url && newestPerCandidate.get(p.candidate_id)?.id === p.id)
    .sort((a, b) => (scores.get(b.candidate_id) ?? 0) - (scores.get(a.candidate_id) ?? 0) || a.created_at.localeCompare(b.created_at));
}

function describeBeats(b: import('@toaster/shared').EditBeats): string {
  return [
    b.freeze ? `freeze@${b.freeze.at}s "${b.freeze.text}"` : null,
    b.punchIn ? `punch-in@${b.punchIn.at}s x${b.punchIn.zoom}` : null,
    b.replay ? `replay ${b.replay.from}-${b.replay.to}s @${b.replay.speed}x` : null,
    b.sticker ? `sticker@${b.sticker.at}s "${b.sticker.text}"` : null,
    b.muteSource ? 'mute-source' : null,
  ].filter(Boolean).join(', ') || 'none';
}
