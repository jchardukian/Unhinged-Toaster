/**
 * Clip-specific comedic edit planning (pure math; signal analysis lives in the pipeline).
 *
 * Timeline produced for a source clip of duration D with a detected "peak" moment P:
 *   [A: 0 → tf] [FREEZE f s, "WAIT FOR IT…"] [B: tf → D, punch-in zoom around P] [REPLAY r s, slow-mo of P±0.8 s] [OUTRO, commentary]
 * Every beat is optional and is dropped (replay first, then freeze) when the total would exceed the platform limit.
 */
export interface EditBeats {
  freeze: { at: number; duration: number; text: string } | null;   // `at` in SOURCE time
  punchIn: { at: number; zoom: number; rampIn: number; hold: number; rampOut: number } | null; // `at` in source time
  replay: { from: number; to: number; speed: number; zoom: number } | null; // source window
  sticker: { at: number; duration: number; text: string } | null; // source time
  muteSource: boolean;
}

export interface EditTimeline {
  beats: EditBeats;
  sourceDuration: number;
  /** Duration of the edited clip (before outro). */
  editedDuration: number;
  replayDuration: number;
  freezeDuration: number;
  /** Map a source timestamp to the edited timeline (for captions / overlays). */
  map: (sourceT: number) => number;
  /** Where the replay segment starts on the edited timeline, or null. */
  replayStart: number | null;
  dropped: string[];
}

export interface PlanInput {
  sourceDuration: number;
  peak: number | null;          // detected moment of interest (source time)
  maxTotal: number;             // e.g. 59 - outro
  style: 'full' | 'light';
  stickerText?: string | null;
  freezeText?: string | null;
  muteSource?: boolean;
  hasSpeech?: boolean;          // dialogue-driven clips get no freeze (it breaks sentences)
}

export const DEFAULTS = { freeze: 0.7, replayWindow: 0.8, replaySpeed: 0.5, punchZoom: 1.28, stickerDuration: 1.3 };

export function planEdit(i: PlanInput): EditTimeline {
  const D = i.sourceDuration;
  const dropped: string[] = [];
  const peak = i.peak != null && i.peak > 0.5 && i.peak < D - 0.3 ? i.peak : Math.min(D - 0.5, Math.max(0.5, D * 0.62));
  const light = i.style === 'light' || D < 5;

  let freeze: EditBeats['freeze'] = null;
  if (!light && !i.hasSpeech && peak - 1.0 >= 1.0 && i.freezeText) freeze = { at: round2(peak - 1.0), duration: DEFAULTS.freeze, text: i.freezeText };
  else if (light) dropped.push('freeze:light');
  else if (i.hasSpeech) dropped.push('freeze:speech');
  else if (!(peak - 1.0 >= 1.0)) dropped.push('freeze:peak_too_early');

  const punchIn: EditBeats['punchIn'] = { at: round2(Math.max(0, peak - 0.1)), zoom: DEFAULTS.punchZoom, rampIn: 0.25, hold: light ? 0.6 : 1.0, rampOut: 0.35 };

  let replay: EditBeats['replay'] = null;
  if (!light && D >= 6) {
    const from = round2(Math.max(0, peak - DEFAULTS.replayWindow));
    const to = round2(Math.min(D, peak + DEFAULTS.replayWindow));
    if (to - from >= 0.8) replay = { from, to, speed: DEFAULTS.replaySpeed, zoom: 1.15 };
  } else dropped.push(light ? 'replay:light' : 'replay:too_short');

  const sticker: EditBeats['sticker'] = i.stickerText ? { at: round2(Math.max(0, peak + 0.05)), duration: DEFAULTS.stickerDuration, text: i.stickerText } : null;

  const total = () => D + (freeze?.duration ?? 0) + (replay ? (replay.to - replay.from) / replay.speed : 0);
  if (total() > i.maxTotal && replay) { replay = null; dropped.push('replay:over_limit'); }
  if (total() > i.maxTotal && freeze) { freeze = null; dropped.push('freeze:over_limit'); }

  const f = freeze?.duration ?? 0;
  const replayDuration = replay ? round2((replay.to - replay.from) / replay.speed) : 0;
  const editedDuration = round2(D + f + replayDuration);
  const map = (t: number) => (freeze && t >= freeze.at ? t + f : t);
  return {
    beats: { freeze, punchIn, replay, sticker, muteSource: !!i.muteSource },
    sourceDuration: D, editedDuration, replayDuration, freezeDuration: f, map,
    replayStart: replay ? round2(D + f) : null, dropped,
  };
}

/**
 * Pick the moment of interest from per-frame signals.
 * audioRms: dB values sampled at `step` seconds (louder = more interesting; we look for the biggest RISE, i.e. the onset).
 * sceneScores: 0..1 scene-change scores per frame time.
 */
export function detectPeak(input: { audioRms?: { t: number; db: number }[]; sceneScores?: { t: number; score: number }[]; duration: number }): { t: number; method: string } | null {
  const D = input.duration;
  const a = (input.audioRms ?? []).filter((x) => Number.isFinite(x.db) && x.db > -90);
  if (a.length >= 6) {
    // smooth, then find the largest rise over a 0.5 s window, ignoring the first/last 0.4 s
    let best = { t: 0, rise: -Infinity };
    for (let i = 2; i < a.length - 2; i++) {
      const before = (a[i - 2].db + a[i - 1].db) / 2;
      const after = (a[i].db + a[i + 1].db + a[i + 2].db) / 3;
      const rise = after - before;
      if (a[i].t > 0.4 && a[i].t < D - 0.4 && rise > best.rise) best = { t: a[i].t, rise };
    }
    if (best.rise > 6) return { t: round2(best.t), method: 'audio_onset' };
    // otherwise the loudest moment
    const loud = a.filter((x) => x.t > 0.4 && x.t < D - 0.4).sort((x, y) => y.db - x.db)[0];
    if (loud) return { t: round2(loud.t), method: 'audio_loudest' };
  }
  const s = (input.sceneScores ?? []).filter((x) => x.t > 0.4 && x.t < D - 0.4);
  if (s.length) {
    const top = [...s].sort((x, y) => y.score - x.score)[0];
    if (top.score > 0.12) return { t: round2(top.t), method: 'scene_change' };
  }
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
