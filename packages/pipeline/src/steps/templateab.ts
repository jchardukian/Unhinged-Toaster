import fs from 'node:fs';
import path from 'node:path';
import { creditText, planEdit } from '@toaster/shared';
import { analyzeClip } from './analyze.js';
import { log, type Config } from '../config.js';
import type { Store } from '../store.js';
import { transcribeDetailed } from './captions.js';
import { downloadMedia, extractAudio, ffprobe, run } from './media.js';
import { loadTemplate, renderShort } from './render.js';
import { qualityControl, type QcResult } from './qc.js';
import { uploadPublic } from './upload.js';

/**
 * Presentation-only A/B: render ONE existing production twice from the same source, transcript, edit plan, headline and
 * commentary — A with the live template, B with template.<variant>.json — then run the normal QC on both and publish
 * the previews plus a side-by-side frame sheet under previews/ab/<candidate>/ on the control plane. Nothing is stored
 * as a production and nothing touches Buffer.
 */
export async function templateAb(cfg: Config, store: Store, candidateId: string, variant = 'clean'): Promise<string> {
  const c = await store.getCandidate(candidateId);
  if (!c) throw new Error(`candidate ${candidateId} not found`);
  const prod = (await store.listProductions({ candidate_id: candidateId })).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!prod) throw new Error(`no production for ${candidateId}`);
  const dir = path.join(cfg.workDir, 'ab', candidateId);
  fs.mkdirSync(dir, { recursive: true });

  const src = await downloadMedia(c, dir);
  const probe = await ffprobe(src);
  const audio = await extractAudio(src, path.join(dir, 'audio.mp3'));
  const speech = audio ? await transcribeDetailed(cfg, audio) : null;
  const words = speech?.transcript?.words ?? null;
  const analysis = await analyzeClip(src);
  const base = loadTemplate(cfg, null);
  const timeline = planEdit({ sourceDuration: Math.min(probe.duration, base.limits.maxDurationSec), peak: analysis.peak?.t ?? null, maxTotal: base.limits.maxDurationSec, style: 'full', hasSpeech: (words?.length ?? 0) >= 6 });

  const out: Record<string, { file: string; renderSec: number; qc: QcResult; url?: string }> = {};
  for (const [label, v] of [['A', null], ['B', variant]] as const) {
    const t = loadTemplate(cfg, v);
    const jobDir = path.join(dir, label);
    fs.mkdirSync(jobDir, { recursive: true });
    const file = path.join(dir, `${candidateId}.${label}.mp4`);
    const t0 = Date.now();
    await renderShort(cfg, t, { clipPath: src, headline: prod.headline, commentary: prod.commentary, commentaryMode: 'text_only', voPath: null, words, musicPath: null, outPath: file, workDir: jobDir, timeline });
    const renderSec = (Date.now() - t0) / 1000;
    const qc = await qualityControl(cfg, {
      file, candidate: c, headline: prod.headline, caption: prod.caption_text, hashtags: JSON.parse(prod.hashtags || '[]'), commentaryMode: 'text_only', commentary: prod.commentary,
      edits: { freeze: !!timeline.beats.freeze, punchIn: !!timeline.beats.punchIn, replay: !!timeline.beats.replay, captions: (words?.length ?? 0) >= 6 },
      publicText: [prod.caption_text, creditText(c, { contactEmail: cfg.contactEmail })].join('\n\n'),
      words: words ? words.map((w) => ({ word: w.word, start: timeline.map(w.start), end: timeline.map(w.end) })) : null,
      siblingProductions: 1, sourceSpeech: speech && speech.wordCount > 0 ? { language: speech.language, words: speech.wordCount, excerpt: speech.text.slice(0, 300) } : null,
    });
    out[label] = { file, renderSec, qc };
    log.info(`AB ${label}: render ${renderSec.toFixed(1)} s, QC ${qc.ok ? 'PASS' : 'FAIL'} ${qc.score ?? '-'}`);
  }

  // side-by-side frame sheet at the same instants (hook, early, peak, payoff/end)
  const dur = timeline.editedDuration;
  const peakT = timeline.beats.punchIn ? timeline.map(timeline.beats.punchIn.at) : dur * 0.6;
  const times = [0.6, Math.min(2.5, dur * 0.25), Math.max(0, Math.min(dur - 0.5, peakT + 0.2)), Math.max(0, dur - 1.0)];
  const sheet = path.join(dir, `${candidateId}.ab_sheet.jpg`);
  const ins: string[] = [];
  for (const tt of times) for (const label of ['A', 'B']) ins.push('-ss', tt.toFixed(2), '-i', out[label].file);
  const n = ins.length / 4;
  const cells = Array.from({ length: n }, (_, i) => `[${i}:v]scale=432:768,setsar=1[f${i}]`);
  const rows = times.map((_, r) => `[f${2 * r}][f${2 * r + 1}]hstack=2[r${r}]`);
  const graph = [...cells, ...rows, `${times.map((_, r) => `[r${r}]`).join('')}vstack=${times.length}[o]`].join(';');
  await run('ffmpeg', ['-y', '-v', 'error', ...ins, '-filter_complex', graph, '-map', '[o]', '-frames:v', '1', '-q:v', '3', sheet]);

  const summary = {
    candidate: candidateId, title: c.title, source: c.source_url, source_res: `${probe.width}x${probe.height}`, headline: prod.headline, commentary: prod.commentary,
    edit: { freeze: !!timeline.beats.freeze, punchIn: !!timeline.beats.punchIn, replay: !!timeline.beats.replay, editedSec: +dur.toFixed(1) }, sheet_times: times.map((x) => +x.toFixed(2)),
    A: { renderSec: +out.A.renderSec.toFixed(1), ok: out.A.qc.ok, score: out.A.qc.score, editorial: out.A.qc.editorial, failed: out.A.qc.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`) },
    B: { renderSec: +out.B.renderSec.toFixed(1), ok: out.B.qc.ok, score: out.B.qc.score, editorial: out.B.qc.editorial, failed: out.B.qc.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`) },
    urls: {} as Record<string, string>,
  };
  const prefix = `previews/ab/${candidateId}`;
  for (const [k, f, ct] of [['A', out.A.file, 'video/mp4'], ['B', out.B.file, 'video/mp4'], ['sheet', sheet, 'image/jpeg']] as const) {
    const up = await uploadPublic(cfg, f, `${prefix}/${path.basename(f)}`, ct).catch((e) => { log.warn(`upload ${k} failed: ${(e as Error).message}`); return null; });
    if (up?.uploaded) summary.urls[k] = up.url;
  }
  const json = path.join(dir, `${candidateId}.ab.json`);
  fs.writeFileSync(json, JSON.stringify(summary, null, 2));
  const upj = await uploadPublic(cfg, json, `${prefix}/${path.basename(json)}`, 'application/json').catch(() => null);
  if (upj?.uploaded) summary.urls.json = upj.url;
  const md = `### Template A/B: ${prod.headline}\n\n| | A (live) | B (${variant}) |\n|---|---|---|\n| render | ${summary.A.renderSec} s | ${summary.B.renderSec} s |\n| QC | ${summary.A.ok ? 'PASS' : 'FAIL'} ${summary.A.score ?? '-'} | ${summary.B.ok ? 'PASS' : 'FAIL'} ${summary.B.score ?? '-'} |\n\n${Object.entries(summary.urls).map(([k, u]) => `- ${k}: ${u}`).join('\n')}\n`;
  log.info(`AB summary ${JSON.stringify(summary)}`);
  return md;
}
