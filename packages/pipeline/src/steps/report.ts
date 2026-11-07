import { buildReadinessReport, buildWeekPlan, formatReadinessMarkdown, type ReadinessReport } from '@toaster/shared';
import type { Config } from '../config.js';
import type { Store } from '../store.js';

export async function readinessReport(cfg: Config, store: Store, which: 'current' | 'next' = 'next', now: Date = new Date()): Promise<{ report: ReadinessReport; markdown: string }> {
  const plan = buildWeekPlan(now, cfg.tz, cfg.publishSlots, ['youtube', 'tiktok'], which === 'current' ? 0 : 1);
  const report = buildReadinessReport({
    plan,
    candidates: await store.listCandidates(),
    productions: await store.listProductions(),
    posts: await store.listPosts({ week: plan.week }),
    allPosts: await store.listPosts(),
    now,
  });
  return { report, markdown: formatReadinessMarkdown(report) };
}
