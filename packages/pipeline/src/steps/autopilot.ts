import fs from 'node:fs';
import path from 'node:path';
import { AUTOPILOT_SETTING_KEY, autopilotActive, monitorVerdict, ulid, type AutopilotSetting, type AutopilotVerdict, type Decision, type MonitorInput } from '@toaster/shared';
import { log, type Config } from '../config.js';
import { breakerState, budget, spentUsd } from '../guard.js';
import type { Store } from '../store.js';
import { alert } from '../alerts.js';
import { bufferClient } from './publish.js';

/**
 * Unattended publishing control: authorization check, pause / resume / emergency stop, the monitor that pauses
 * automatically, and the decision log. The scheduling itself happens in publish.ts (publishWeek with unattended: true)
 * and only after `autopilotStatus` says active.
 */
export async function autopilotStatus(cfg: Config, store: Store): Promise<AutopilotVerdict & { setting: AutopilotSetting | null }> {
  const setting = await store.getSetting<AutopilotSetting>(AUTOPILOT_SETTING_KEY).catch((e) => { log.warn(`autopilot setting unreadable: ${(e as Error).message}`); return { paused: true, reason: 'control plane unreachable', by: 'monitor', at: new Date().toISOString() } as AutopilotSetting; });
  const v = autopilotActive({ enabled: cfg.unattended, authorization: cfg.unattendedAuthorization, emergencyStop: cfg.emergencyStop, setting });
  return { ...v, setting };
}

export async function logDecision(store: Store, d: Omit<Decision, 'id' | 'at'> & Partial<Pick<Decision, 'id' | 'at'>>): Promise<Decision> {
  const full: Decision = { id: d.id ?? ulid(), at: d.at ?? new Date().toISOString(), ...d } as Decision;
  await store.logDecision(full);
  const line = JSON.stringify(full);
  try { fs.appendFileSync(path.join(process.env.WORK_DIR ?? 'work', 'publish-decisions.jsonl'), line + '\n'); } catch { /* best effort */ }
  log.info(`decision ${full.kind} ${full.service ?? ''} ${full.slot_at ?? ''} ${full.production_id ?? ''}: ${JSON.parse(full.reasons).join('; ')}`);
  return full;
}

/** Pause unattended publishing; optionally pull every not-yet-published scheduled post back out of Buffer (emergency stop). */
export async function pauseAutopilot(cfg: Config, store: Store, reason: string, by: 'owner' | 'monitor' | 'emergency-stop', opts: { unschedule?: boolean } = {}): Promise<{ unscheduled: number; failed: number }> {
  const setting: AutopilotSetting = { paused: true, reason, by, at: new Date().toISOString() };
  await store.setSetting(AUTOPILOT_SETTING_KEY, setting);
  await logDecision(store, { kind: by === 'emergency-stop' ? 'stop' : 'pause', production_id: null, candidate_id: null, service: null, slot_at: null, buffer_post_id: null, reasons: JSON.stringify([reason]), detail: JSON.stringify({ by }) });
  let unscheduled = 0, failed = 0;
  if (opts.unschedule && cfg.bufferKey) {
    const client = bufferClient(cfg);
    const pending = (await store.listPosts({ state: ['scheduled'] })).filter((p) => p.buffer_post_id && Date.parse(p.slot_at) > Date.now());
    for (const p of pending) {
      try {
        await client.deletePost(p.buffer_post_id!);
        p.state = 'deleted'; p.buffer_error = `unscheduled by ${by}: ${reason}`; p.updated_at = new Date().toISOString();
        await store.upsertPost(p);
        await logDecision(store, { kind: 'unschedule', production_id: p.production_id, candidate_id: p.candidate_id, service: p.service, slot_at: p.slot_at, buffer_post_id: p.buffer_post_id, reasons: JSON.stringify([reason]), detail: JSON.stringify({ by }) });
        unscheduled++;
      } catch (e) { failed++; log.error(`could not unschedule ${p.buffer_post_id}: ${(e as Error).message}`); }
    }
  }
  await alert(by === 'monitor' ? 'error' : 'warn', `Unattended publishing ${by === 'emergency-stop' ? 'STOPPED' : 'paused'} (${by}): ${reason}`, `unscheduled ${unscheduled} pending post(s), ${failed} failed`, { issueKey: 'autopilot paused' });
  return { unscheduled, failed };
}

export async function resumeAutopilot(store: Store, by = 'owner'): Promise<void> {
  await store.setSetting<AutopilotSetting>(AUTOPILOT_SETTING_KEY, { paused: false, reason: null, by, at: new Date().toISOString() });
  await logDecision(store, { kind: 'resume', production_id: null, candidate_id: null, service: null, slot_at: null, buffer_post_id: null, reasons: JSON.stringify([`resumed by ${by}`]), detail: null });
}

/**
 * Health monitor: Buffer publishing errors, QC collapse, breaker / budget, recorded platform incidents. Pauses
 * unattended publishing (and unschedules pending posts) when a rule fires. `platformIncident` comes from the setting
 * `incident` (set by `toaster incident "<text>"` or the owner's issue) because YouTube/TikTok complaints are not
 * visible through Buffer.
 */
export async function monitorAutopilot(cfg: Config, store: Store, opts: { consecutiveRunFailures?: number } = {}): Promise<{ reasons: string[]; paused: boolean }> {
  const since = Date.now() - 24 * 3600_000;
  const posts = await store.listPosts();
  const publishErrors24h = posts.filter((p) => p.state === 'error' && Date.parse(p.updated_at) >= since).length;
  const productions = (await store.listProductions()).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const qcVerdicts = productions.filter((p) => p.qc_json).slice(0, 12).map((p) => { try { return !!(JSON.parse(p.qc_json!) as { ok: boolean }).ok; } catch { return false; } });
  const incident = await store.getSetting<{ text: string; at: string } | null>('incident').catch(() => null);
  const m: MonitorInput = {
    publishErrors24h, qcVerdicts, consecutiveRunFailures: opts.consecutiveRunFailures ?? 0,
    budgetExhausted: spentUsd() >= budget(), breakerTripped: Object.keys(breakerState()).length > 0, platformIncident: !!incident,
  };
  const reasons = monitorVerdict(m);
  const status = await autopilotStatus(cfg, store);
  let paused = false;
  if (reasons.length && cfg.unattended && !status.setting?.paused) {
    await pauseAutopilot(cfg, store, reasons.join('; '), 'monitor', { unschedule: true });
    paused = true;
  }
  log.info(`monitor: ${reasons.length ? `PAUSE (${reasons.join('; ')})` : 'healthy'}; publish errors 24h ${publishErrors24h}, qc ${qcVerdicts.filter(Boolean).length}/${qcVerdicts.length}, incident ${incident ? 'yes' : 'no'}`);
  return { reasons, paused };
}

export function autopilotMarkdown(v: AutopilotVerdict & { setting: AutopilotSetting | null }, cfg: Config): string {
  return [
    `## Unattended publishing: ${v.active ? '🟢 ACTIVE (posts are scheduled without approval)' : '⚪ off (drafts only)'}`,
    ...(v.active ? [`- minimum QC score ${cfg.unattendedMinQc}; rights: documented licence or permission${cfg.unattendedFairUse ? ', or a "supportable" case-specific fair-use assessment (owner policy; uncertain ones are never scheduled)' : ' only'}; other review-path footage ${cfg.unattendedReviewDrafts ? 'is drafted for optional approval' : 'is skipped'}`] : v.reasons.map((r) => `- ${r}`)),
    '- stop at any time: GitHub → Actions → "Emergency stop" → Run workflow (unschedules every pending post), or set the repository variable EMERGENCY_STOP=true',
  ].join('\n');
}
