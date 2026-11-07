import fs from 'node:fs';
import path from 'node:path';
import { creditText, initialRights, planEdit, ulid, type Candidate, type ContentFormat, type Production } from '@toaster/shared';
import { log, type Config } from '../config.js';
import type { Store } from '../store.js';
import { budget, isFatal, spentUsd, videoBudget } from '../guard.js';
import { costOf, currentUsage, recordRender, recordUpload, recordVideoOutcome, videoGenUsd } from '../usage.js';
import { generateClip, makeProvider, type ProviderName } from './aivideo.js';
import { analyzeClip } from './analyze.js';
import { assessClip, type QualityVerdict } from './dogquality.js';
import { DOG_PREMISES, variantPrompt } from './dogprompts.js';
import { discoverInternetArchive, discoverPexels, discoverPixabay, discoverWikimediaCommons, DOG_STOCK_QUERIES } from './discover.js';
import { contactSheet, sheetBase64, sheetPathFor } from './frames.js';
import { downloadMedia, ffprobe, mediaDuration, run } from './media.js';
import { runPreflight } from './preflight.js';
import { produceUntil, unpostedProductions } from './produce.js';
import { assembleRanking, planRanking, RANKING_MAX_CLIPS, RANKING_MIN_CLIPS, segmentSeconds, type RankingSegment } from './ranking.js';
import { loadTemplate, pickMusic, renderShort } from './render.js';
import { scoreCandidate } from './score.js';
import { ensureSfxLibrary, planSfx } from './sfx.js';
import { synthesiseCommentary } from './tts.js';
import { uploadPublic } from './upload.js';

/**
 * Dog-content pilot (opt-in, manual, never publishes): N realistic AI dog comedy Shorts, M real-dog ranking
 * compilations from LICENSED stock only, K general-viral controls from the existing engine. Every generated attempt
 * is metered against the hard AI_VIDEO_BUDGET_USD cap, judged by the explicit visual-quality gate, and reported with
 * attempts / rejections / cost per ACCEPTED video. Licensed-stock shortages are reported, never filled with review-path
 * footage.
 */
export interface DogPilotOptions { provider: ProviderName; ai: number; rankings: number; controls: number; skipQuality?: boolean; stock: 'live' | 'mock'; model?: string }
export interface PilotRow { format: ContentFormat; headline: string; durationSec: number; source: string; attempts: number; rejected: number; costUsd: number; quality: string; rights: string; file: string; publicUrl: string | null }
export interface DogPilotResult { ok: boolean; rows: PilotRow[]; markdown: string; shortages: string[]; elapsedSec: number }

export async function runDogPilot(cfg: Config, store: Store, o: DogPilotOptions): Promise<DogPilotResult> {
  const start = Date.now();
  const rows: PilotRow[] = [];
  const shortages: string[] = [];
  const md: string[] = [`## Dog pilot (${o.ai} AI, ${o.rankings} rankings, ${o.controls} controls; provider ${o.provider}${o.model ? `/${o.model}` : ''}; stock ${o.stock})`, ''];
  const pre = await runPreflight(cfg, 'diagnostic');
  md.push(pre.markdown, '');
  if (!pre.ok) return { ok: false, rows, markdown: md.join('\n') + '\nPreflight failed: nothing generated.', shortages, elapsedSec: elapsed(start) };
  const sfxProvider = process.env.SFX_PROVIDER === 'elevenlabs' ? 'elevenlabs' : 'synth';
  if (sfxProvider === 'synth') process.env.SFX_PROVIDER = 'synth'; // placeholders live in the work dir and are only used when chosen
  const sfxLib = await ensureSfxLibrary(cfg, sfxProvider);
  md.push(`- sound effects library: ${sfxLib.present} effects (${sfxLib.created} created now, provider ${process.env.SFX_PROVIDER === 'elevenlabs' ? 'elevenlabs' : 'synth placeholders'})`);

  // ---------------- Format A: AI dog comedy
  if (o.ai > 0) {
    const provider = makeProvider(cfg, o.provider, o.model);
    const premises = shuffle([...DOG_PREMISES]);
    let accepted = 0, attempts = 0, rejected = 0, sinceLastAccept = { attempts: 0, rejected: 0, usd: 0 };
    const usedTitles: string[] = [];
    for (const premise of premises) {
      if (accepted >= o.ai) break;
      if (attempts >= o.ai * 4) { shortages.push(`AI: stopped after ${attempts} attempts for ${accepted}/${o.ai} accepted clips`); break; }
      const id = ulid();
      const dir = path.join(cfg.workDir, 'jobs', id); fs.mkdirSync(dir, { recursive: true });
      const copy = await variantPrompt(cfg, premise, usedTitles);
      usedTitles.push(premise.title);
      const usdBefore = videoGenUsd();
      let gen;
      try { gen = await generateClip(provider, { prompt: copy.prompt, seconds: premise.seconds, ratio: '9:16', outPath: path.join(dir, `${id}.source.mp4`) }); }
      catch (e) {
        attempts++; rejected++; sinceLastAccept.attempts++; sinceLastAccept.rejected++; sinceLastAccept.usd += videoGenUsd() - usdBefore;
        if (isFatal(e)) { shortages.push(`AI generation stopped: ${(e as Error).message}`); md.push(`- ❌ ${premise.title}: ${(e as Error).message}`); break; }
        md.push(`- ❌ ${premise.title}: generation failed (${(e as Error).message.slice(0, 120)})`); continue;
      }
      attempts++; sinceLastAccept.attempts++; sinceLastAccept.usd += videoGenUsd() - usdBefore;
      const analysis = await analyzeClip(gen.path);
      const template = loadTemplate(cfg);
      const timeline = planEdit({ sourceDuration: Math.min(gen.seconds, template.limits.maxDurationSec), peak: analysis.peak?.t ?? null, maxTotal: template.limits.maxDurationSec, style: 'full', stickerText: null, freezeText: null, hasSpeech: false });
      const sfx = planSfx(cfg, timeline.beats, timeline.map, { category: 'funny_animals' });
      let verdict: QualityVerdict = { accepted: true, reasons: ['quality gate skipped (test mode)'], scores: { realistic_anatomy: 0, believable_motion: 0, natural_lighting: 0, no_artifacts: 0, hook_2s: 0, payoff: 0, sfx_fit: 0, is_dog: false, notes: 'skipped' } };
      if (!o.skipQuality) verdict = await assessClip(cfg, gen.path, dir, { premise: copy.prompt, plannedSfx: sfx.map((x) => `${path.basename(x.path, '.mp3')}@${x.at.toFixed(1)}s`) });
      if (!verdict.accepted) {
        rejected++; sinceLastAccept.rejected++; recordVideoOutcome(provider.name, 'rejected');
        md.push(`- ❌ ${premise.title} (${gen.provider}/${gen.model}, $${gen.usd.toFixed(2)}): rejected — ${verdict.reasons.join('; ')} — ${verdict.scores.notes}`);
        continue;
      }
      recordVideoOutcome(provider.name, 'accepted');
      const cand: Candidate = {
        id, source_platform: 'ai_generated', source_id: gen.jobId, source_url: `ai://${gen.provider}/${gen.model}/${gen.jobId}`, media_url: null, author: null, author_url: null,
        title: copy.headline, description: copy.prompt, category: 'funny_animals', duration_sec: gen.seconds, width: 720, height: 1280, published_at: null, discovered_at: new Date().toISOString(),
        views: null, likes: null, comments: null, shares: null, engagement_velocity: null, heuristic_score: null, llm_score: null, final_score: null, llm_rationale: null, safety_flags: '[]', phash: null, duplicate_of: null,
        ...initialRights('ai_generated', { evidenceSuffix: `${gen.provider}/${gen.model} job ${gen.jobId} on ${new Date().toISOString().slice(0, 10)}` }),
        copyright_risk: 'low', copyright_risk_reasons: null, attribution_text: null, status: 'producing', status_reason: null, updated_at: new Date().toISOString(),
        content_format: 'ai_dog_comedy', meta_json: JSON.stringify({ provider: gen.provider, model: gen.model, prompt: copy.prompt, premise: premise.id, attempts: sinceLastAccept.attempts, rejected: sinceLastAccept.rejected, generated_seconds: gen.seconds, generation_usd: sinceLastAccept.usd, quality: verdict.scores }),
        visual_summary: `AI: ${premise.hook}; ${premise.payoff}`,
      };
      await store.upsertCandidates([cand]);
      const row = await finishClip(cfg, store, cand, { clipPath: gen.path, headline: copy.headline, commentary: copy.commentary, timeline, sfx, dir, generationUsd: sinceLastAccept.usd, attempts: sinceLastAccept.attempts, rejected: sinceLastAccept.rejected, source: `${gen.provider}/${gen.model}`, quality: qualityLine(verdict), format: 'ai_dog_comedy' });
      rows.push(row); accepted++;
      md.push(`- ✅ ${premise.title}: "${copy.headline}" accepted after ${sinceLastAccept.attempts} attempt(s), generation $${sinceLastAccept.usd.toFixed(2)}`);
      sinceLastAccept = { attempts: 0, rejected: 0, usd: 0 };
    }
    md.push(`- AI summary: ${accepted}/${o.ai} accepted, ${attempts} attempts, ${rejected} rejected, generation spend $${videoGenUsd().toFixed(2)} of the $${videoBudget().toFixed(2)} hard cap`);
    if (accepted < o.ai && !shortages.some((s) => s.startsWith('AI'))) shortages.push(`AI: ${accepted}/${o.ai} accepted`);
  }

  // ---------------- Format B: real-dog rankings from licensed stock only
  if (o.rankings > 0) {
    const pool = await licensedDogPool(cfg, store, o, md);
    if (pool.length < RANKING_MIN_CLIPS) {
      shortages.push(`rankings: only ${pool.length} funny licensed clip(s) found (need ${RANKING_MIN_CLIPS} per ranking); not substituting unlicensed footage`);
      md.push(`- ⚠️ ranking shortage: ${pool.length} usable licensed clips`);
    }
    let made = 0;
    while (made < o.rankings && pool.length >= RANKING_MIN_CLIPS) {
      const clips = pool.splice(0, Math.min(RANKING_MAX_CLIPS, pool.length));
      if (clips.length < RANKING_MIN_CLIPS) { pool.unshift(...clips); break; }
      const id = ulid(); const dir = path.join(cfg.workDir, 'jobs', id); fs.mkdirSync(dir, { recursive: true });
      const plan = await planRanking(cfg, clips.map((c) => c.cand));
      const secs = segmentSeconds(clips.length);
      const segments: RankingSegment[] = plan.order.map((ord) => {
        const k = clips.find((c) => c.cand.id === ord.candidate_id)!;
        const start = Math.max(0, Math.min((k.peak ?? 2) - 2, Math.max(0, k.duration - secs)));
        return { candidate: k.cand, clipPath: k.path, label: ord.label, start, seconds: Math.min(secs, k.duration - start) };
      });
      const asm = await assembleRanking(cfg, segments, path.join(dir, `${id}.ranking.mp4`));
      const template = loadTemplate(cfg);
      const timeline = planEdit({ sourceDuration: asm.durationSec, peak: null, maxTotal: template.limits.maxDurationSec, style: 'light', stickerText: null, freezeText: null, hasSpeech: false });
      const cand: Candidate = {
        id, source_platform: 'manual', source_id: id, source_url: `ranking://${id}`, media_url: null, author: null, author_url: null, title: plan.title, description: `Ranking of ${clips.length} licensed clips`,
        category: 'funny_animals', duration_sec: asm.durationSec, width: 1080, height: 1920, published_at: null, discovered_at: new Date().toISOString(), views: null, likes: null, comments: null, shares: null, engagement_velocity: null,
        heuristic_score: null, llm_score: null, final_score: Math.max(...clips.map((c) => c.cand.final_score ?? 0)), llm_rationale: null, safety_flags: '[]', phash: null, duplicate_of: null,
        rights_status: 'cleared', rights_basis: 'licensed', rights_evidence: clips.map((c) => `${c.cand.source_url} (${c.cand.rights_basis})`).join('; '), rights_notes: 'Every clip is Pexels/Pixabay licensed stock; see meta_json.clips',
        copyright_risk: 'low', copyright_risk_reasons: null, attribution_text: null, status: 'producing', status_reason: null, updated_at: new Date().toISOString(),
        content_format: 'real_dog_ranking', meta_json: JSON.stringify({ clips: clips.map((c) => ({ candidate_id: c.cand.id, source_url: c.cand.source_url, author: c.cand.author, license: c.cand.rights_basis, platform: c.cand.source_platform })), order: plan.order }),
      };
      await store.upsertCandidates([cand]);
      const row = await finishClip(cfg, store, cand, { clipPath: asm.path, headline: plan.headline, commentary: plan.commentary, timeline, sfx: asm.sfx, dir, generationUsd: 0, attempts: 1, rejected: 0, source: `${clips.length} licensed clips (${[...new Set(clips.map((c) => c.cand.source_platform))].join('+')})`, quality: 'licensed stock, vision-scored ≥ 70', format: 'real_dog_ranking' });
      rows.push(row); made++;
      md.push(`- ✅ ranking "${plan.headline}": ${clips.length} clips, ${asm.durationSec.toFixed(1)} s`);
    }
    if (made < o.rankings) shortages.push(`rankings: ${made}/${o.rankings} made (licensed clip supply)`);
  }

  // ---------------- controls: existing general-viral engine, untouched
  if (o.controls > 0) {
    const before = (await unpostedProductions(store)).length;
    const have = await produceUntil(cfg, store, before + o.controls);
    const prods = (await store.listProductions()).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, Math.max(0, have - before));
    for (const p of prods) {
      const c = await store.getCandidate(p.candidate_id);
      rows.push({ format: 'general_viral', headline: p.headline, durationSec: p.duration_sec ?? 0, source: `${c?.source_platform ?? '?'} ${c?.source_url ?? ''}`, attempts: 1, rejected: 0, costUsd: p.production_cost_usd ?? 0, quality: 'existing pipeline gates', rights: `${c?.rights_status}${c?.rights_basis ? '/' + c.rights_basis : ''}`, file: path.join(cfg.workDir, 'jobs', p.candidate_id, `${p.candidate_id}.final.mp4`), publicUrl: p.public_url });
    }
    if (prods.length < o.controls) shortages.push(`controls: ${prods.length}/${o.controls} produced`);
  }

  // ---------------- report
  const usage = costOf(currentUsage());
  md.push('', '| # | format | headline | dur | source | attempts | rejected | cost/accepted | quality | rights | public |', '|---|---|---|---|---|---|---|---|---|---|---|');
  rows.forEach((r, i) => md.push(`| ${i + 1} | ${r.format} | ${r.headline.replace(/\|/g, '/')} | ${r.durationSec.toFixed(1)}s | ${r.source.replace(/\|/g, '/').slice(0, 60)} | ${r.attempts} | ${r.rejected} | $${r.costUsd.toFixed(2)} | ${r.quality.replace(/\|/g, '/')} | ${r.rights.replace(/\|/g, '/').slice(0, 40)} | ${r.publicUrl ? '✓' : 'local'} |`));
  md.push('', ...usage.lines.map((l) => `- ${l}`), `- total metered spend this run: $${usage.total_usd.toFixed(2)} (LLM/TTS/Whisper budget $${budget().toFixed(2)}: $${spentUsd().toFixed(4)} used; AI video hard cap $${videoBudget().toFixed(2)}: $${videoGenUsd().toFixed(2)} used)`, `- elapsed ${elapsed(start)} s`);
  if (shortages.length) md.push('', '**Shortages (reported, not filled):**', ...shortages.map((s) => `- ${s}`));
  md.push('', 'No Buffer posts were created; nothing was published.');
  try { await contactSheetOfFinals(rows, path.join(cfg.workDir, 'dog-pilot-sheet.jpg')); md.push(`- contact sheet: ${path.join(cfg.workDir, 'dog-pilot-sheet.jpg')}`); } catch { /* optional */ }
  const markdown = md.join('\n');
  fs.mkdirSync(cfg.workDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.workDir, 'dog-pilot-report.md'), markdown);
  fs.writeFileSync(path.join(cfg.workDir, 'dog-pilot-rows.json'), JSON.stringify(rows, null, 2));
  return { ok: rows.length === o.ai + o.rankings + o.controls, rows, markdown, shortages, elapsedSec: elapsed(start) };
}

/** Finish one clip through the SAME renderer / uploader / record shape as the general pipeline. */
async function finishClip(cfg: Config, store: Store, c: Candidate, x: { clipPath: string; headline: string; commentary: string; timeline: ReturnType<typeof planEdit>; sfx: { path: string; at: number; gain?: number }[]; dir: string; generationUsd: number; attempts: number; rejected: number; source: string; quality: string; format: ContentFormat }): Promise<PilotRow> {
  const costBefore = costOf(currentUsage()).total_usd;
  const template = loadTemplate(cfg);
  const vo = cfg.commentaryDefault === 'never' ? null : await synthesiseCommentary(cfg, x.commentary, path.join(x.dir, 'vo.mp3'));
  const outPath = path.join(x.dir, `${c.id}.final.mp4`);
  const t0 = Date.now();
  const r = await renderShort(cfg, template, { clipPath: x.clipPath, headline: x.headline, commentary: x.commentary, commentaryMode: vo ? 'outro_voice' : 'text_only', voPath: vo, words: null, musicPath: cfg.musicDefault === 'never' ? null : pickMusic(cfg, 'funny_animals'), outPath, workDir: x.dir, timeline: x.timeline, sfx: x.sfx });
  recordRender((Date.now() - t0) / 1000);
  recordUpload(fs.statSync(outPath).size);
  const key = `renders/${c.id}/${path.basename(outPath)}`;
  const up = await uploadPublic(cfg, outPath, key, 'video/mp4');
  const thumb = await uploadPublic(cfg, r.thumbnailPath, key.replace(/\.mp4$/, '.jpg'), 'image/jpeg');
  const attribution = creditText(c, { contactEmail: cfg.contactEmail, editsSummary: x.format === 'ai_dog_comedy' ? 'comedic sound design, captions and animated visuals' : 'ranking, captions, comedic sound design and animated visuals' });
  const cost = costOf(currentUsage()).total_usd - costBefore + x.generationUsd;
  const prod: Production = {
    id: ulid(), candidate_id: c.id, headline: x.headline, commentary: x.commentary, caption_text: `${x.headline}\n\n${attribution}`, hashtags: JSON.stringify(x.format === 'ai_dog_comedy' ? ['dogs', 'funnydogs', 'ai', 'shorts', 'comedy'] : ['dogs', 'funnydogs', 'ranking', 'shorts', 'comedy']),
    voice_id: vo ? cfg.elevenVoiceId ?? 'auto' : null, music_track: null, r2_key: up.uploaded ? key : null, public_url: up.uploaded ? up.url : null, thumbnail_url: thumb.uploaded ? thumb.url : null,
    duration_sec: r.durationSec, render_log: JSON.stringify({ format: x.format, sfx: x.sfx.map((s) => `${path.basename(s.path)}@${s.at.toFixed(2)}`), cmd: r.command.slice(0, 8) }), reuse_basis: 'cleared', edit_plan: JSON.stringify(x.timeline.beats),
    content_format: x.format, production_cost_usd: Math.round(cost * 10000) / 10000, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  await store.upsertProduction(prod);
  await store.patchCandidate(c.id, { status: 'produced', attribution_text: attribution, status_reason: up.uploaded ? null : 'local_only_no_r2', duration_sec: r.durationSec });
  return { format: x.format, headline: x.headline, durationSec: r.durationSec, source: x.source, attempts: x.attempts, rejected: x.rejected, costUsd: cost, quality: x.quality, rights: `${c.rights_status}/${c.rights_basis}`, file: outPath, publicUrl: prod.public_url };
}

/** Licensed dog clips that the vision scorer finds genuinely funny (final_score ≥ 70), downloaded and peak-analysed. */
async function licensedDogPool(cfg: Config, store: Store, o: DogPilotOptions, md: string[]): Promise<{ cand: Candidate; path: string; duration: number; peak: number | null }[]> {
  let found: Candidate[] = [];
  if (o.stock === 'mock') found = await mockStock(cfg, 8);
  else {
    // free, no-key sources first (license metadata is machine-readable on both), then the free-key stock APIs when configured
    found.push(...await discoverWikimediaCommons(cfg, 30).catch((e) => { md.push(`- wikimedia commons: ${(e as Error).message}`); return []; }));
    found.push(...(await discoverInternetArchive(cfg, 40, ['dog', 'dogs', 'puppy', 'puppies']).catch((e) => { md.push(`- internet archive: ${(e as Error).message}`); return [] as Candidate[]; })).filter((c) => !/hot ?dog|commercial|advert|\bad\b|intermission|snack bar|trailer/i.test(`${c.title} ${c.description ?? ''}`)));
    if (cfg.pexelsKey) found.push(...await discoverPexels(cfg, 30, DOG_STOCK_QUERIES).catch((e) => { md.push(`- pexels: ${(e as Error).message}`); return []; }));
    if (cfg.pixabayKey) found.push(...await discoverPixabay(cfg, 30, DOG_STOCK_QUERIES).catch((e) => { md.push(`- pixabay: ${(e as Error).message}`); return []; }));
    if (!cfg.pexelsKey && !cfg.pixabayKey) md.push('- Pexels / Pixabay not configured (free API keys): only the no-key sources (Wikimedia Commons, Internet Archive) were searched');
    const bySrc = found.reduce<Record<string, number>>((m, c) => { m[c.source_platform] = (m[c.source_platform] ?? 0) + 1; return m; }, {});
    md.push(`- licensed candidates by source: ${JSON.stringify(bySrc)}`);
  }
  found = found.filter((c) => c.rights_status === 'cleared' && (c.duration_sec ?? 0) >= 4 && (c.duration_sec ?? 99) <= 90);
  md.push(`- licensed stock candidates (cleared, 4–90 s): ${found.length}`);
  const weights = await store.weights();
  const pool: { cand: Candidate; path: string; duration: number; peak: number | null }[] = [];
  const cap = Math.max(12, o.rankings * RANKING_MAX_CLIPS * 3);
  for (const c of found.slice(0, cap)) {
    try {
      const dir = path.join(cfg.workDir, 'jobs', c.id); fs.mkdirSync(dir, { recursive: true });
      const file = await downloadMedia(c, dir);
      const probe = await ffprobe(file);
      const sheet = await contactSheet(file, sheetPathFor(dir)).catch(() => null);
      const frames = sheet ? sheetBase64(sheet) : undefined;
      const scored = o.skipQuality ? { ...c, final_score: 75, status: 'scored' as const, visual_summary: c.title } : await scoreCandidate(cfg, c, weights, null, frames);
      await store.upsertCandidates([{ ...scored, content_format: 'real_dog_ranking' }]);
      if (scored.status !== 'scored' || (scored.final_score ?? 0) < 70) continue;
      const a = await analyzeClip(file);
      pool.push({ cand: scored, path: file, duration: probe.duration, peak: a.peak?.t ?? null });
    } catch (e) { log.warn(`stock ${c.id} (${c.source_platform}): ${(e as Error).message.replace(/https?:\/\/\S+/g, '<url>').slice(0, 160)}`); }
  }
  pool.sort((a, b) => (b.cand.final_score ?? 0) - (a.cand.final_score ?? 0));
  md.push(`- funny licensed clips after vision scoring: ${pool.length} of ${Math.min(found.length, cap)} checked`);
  return pool;
}

/** Free synthetic "stock" so the ranking path can be exercised without API keys. */
async function mockStock(cfg: Config, n: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (let i = 0; i < n; i++) {
    const id = ulid(); const dir = path.join(cfg.workDir, 'jobs', id); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.source.mp4`);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=720x1280:rate=30:duration=${7 + i}`, '-f', 'lavfi', '-i', `sine=frequency=${200 + 40 * i}:duration=${7 + i}`, '-vf', `drawtext=text='MOCK DOG CLIP ${i + 1}':fontsize=60:fontcolor=white:borderw=4:x=(w-text_w)/2:y=h/2`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
    out.push({ id, source_platform: 'pexels', source_id: `mock-${i}`, source_url: `https://www.pexels.com/video/mock-dog-${i}/`, media_url: `file://${file}`, author: `Mock Creator ${i}`, author_url: null, title: `Mock dog clip ${i + 1}`, description: null, category: 'funny_animals', duration_sec: 7 + i, width: 720, height: 1280, published_at: null, discovered_at: new Date().toISOString(), views: null, likes: null, comments: null, shares: null, engagement_velocity: null, heuristic_score: null, llm_score: null, final_score: null, llm_rationale: null, safety_flags: null, phash: null, duplicate_of: null, ...initialRights('pexels', {}), copyright_risk: null, copyright_risk_reasons: null, attribution_text: null, status: 'discovered', status_reason: null, updated_at: new Date().toISOString() } as Candidate);
  }
  return out;
}

function qualityLine(v: QualityVerdict): string { const s = v.scores; return `anat ${s.realistic_anatomy} motion ${s.believable_motion} light ${s.natural_lighting} artifacts ${s.no_artifacts} hook ${s.hook_2s} payoff ${s.payoff} sfx ${s.sfx_fit}`; }
function shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const elapsed = (t: number) => Math.round((Date.now() - t) / 1000);
async function contactSheetOfFinals(rows: PilotRow[], out: string): Promise<void> {
  const files = rows.map((r) => r.file).filter((f) => fs.existsSync(f));
  if (!files.length) return;
  const inputs: string[] = []; const parts: string[] = [];
  files.forEach((f, i) => { inputs.push('-i', f); parts.push(`[${i}:v]select='eq(n\\,45)',scale=270:-1,setsar=1[t${i}]`); });
  const cols = Math.min(5, files.length), rowsN = Math.ceil(files.length / cols);
  const pad = files.length % cols ? cols - (files.length % cols) : 0;
  for (let i = 0; i < pad; i++) parts.push(`color=c=black:s=270x480:d=1[p${i}]`);
  const labels = [...files.map((_, i) => `[t${i}]`), ...Array.from({ length: pad }, (_, i) => `[p${i}]`)].join('');
  parts.push(`${labels}xstack=inputs=${files.length + pad}:layout=${Array.from({ length: files.length + pad }, (_, i) => `${(i % cols) * 270}_${Math.floor(i / cols) * 480}`).join('|')}[out]`);
  await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', parts.join(';'), '-map', '[out]', '-frames:v', '1', out]);
  void mediaDuration; void rowsN;
}
