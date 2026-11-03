import type { Candidate, Production, ScheduledPost, SlotPlan } from './types.js';

/** Weekly readiness report. Pure function over store snapshots so it is identical in the CLI and the Worker. */
export interface ReadinessReport {
  week: string;
  generated_at: string;
  target_videos: number;          // 21
  target_posts: number;           // 42 (2 services)
  funnel: {
    discovered: number;           // all candidates ever seen
    scored_pass: number;          // passed scoring (any later status beyond rejected_*)
    cleared_for_reuse: number;    // rights cleared (any status)
    rendered: number;             // productions with a public URL
    drafts_created: number;       // live posts (not deleted) with a Buffer id for this week
    awaiting_approval: number;    // draft / needs_approval
    approved: number;             // scheduled / sending
    published: number;            // sent
    rejected: number;             // deleted by the owner
    errored: number;              // state error or create failures
  };
  videos_ready: number;           // distinct productions with a live post this week
  videos_ready_cleared: number;   // ...of which footage has an explicit reuse basis
  videos_ready_review: number;    // ...of which footage is in transformation review (owner decides per draft)
  videos_missing: number;         // target_videos - videos_ready (>= 0)
  missing_slots: { slot_at: string; service: string }[];
  shortage_reasons: Record<string, number>;
  blockers: string[];
  complete: boolean;
}

export function buildReadinessReport(input: {
  plan: SlotPlan;
  candidates: Candidate[];
  productions: Production[];
  posts: ScheduledPost[];        // posts for plan.week
  now?: Date;
}): ReadinessReport {
  const { plan, candidates, productions } = input;
  const posts = input.posts.filter((p) => p.batch_week === plan.week);
  const live = posts.filter((p) => p.state !== 'deleted' && p.state !== 'error' && p.buffer_post_id);
  const taken = new Set(live.map((p) => `${p.slot_at}|${p.service}`));
  const missing_slots = plan.slots.filter((s) => !taken.has(`${s.slot_at}|${s.service}`));
  const readyProdIds = new Set(live.map((p) => p.production_id));
  const videosReady = readyProdIds.size;
  const reviewProdIds = new Set(live.filter((p) => p.reuse_uncertain).map((p) => p.production_id));
  const targetVideos = plan.slots.length / 2;

  const scoredPass = candidates.filter((c) => !['discovered', 'rejected_score', 'rejected_safety', 'rejected_duplicate'].includes(c.status)).length;
  const cleared = candidates.filter((c) => c.rights_status === 'cleared').length;
  const rendered = productions.filter((p) => !!p.public_url).length;

  const reasons: Record<string, number> = {};
  const bump = (k: string) => { reasons[k] = (reasons[k] ?? 0) + 1; };
  for (const c of candidates) {
    switch (c.status) {
      case 'blocked_rights': bump(`rights:${c.rights_status}${c.rights_basis ? '/' + c.rights_basis : ''}`); break;
      case 'rejected_score': bump('score_below_threshold'); break;
      case 'rejected_safety': bump(`safety:${(c.status_reason ?? 'flag').replace(/^safety:/, '')}`); break;
      case 'rejected_duplicate': bump('duplicate'); break;
      case 'failed': bump(`render_failed:${(c.status_reason ?? 'unknown').slice(0, 60)}`); break;
      case 'scored':
      case 'ready':
        if (c.rights_status !== 'cleared' && c.rights_status !== 'transformation_review' && c.rights_status !== 'owner_reviewed') bump(`rights:${c.rights_status}`); break;
      default: break;
    }
  }
  for (const p of productions) if (!p.public_url) bump('render_ok_but_no_public_url (R2 not configured)');
  for (const p of posts) if (p.state === 'error') bump(`buffer_error:${(p.buffer_error ?? 'unknown').slice(0, 60)}`);

  const blockers: string[] = [];
  const videosMissing = Math.max(0, targetVideos - videosReady);
  if (videosMissing > 0) {
    const unposted = productions.filter((p) => p.public_url && !posts.some((x) => x.production_id === p.id && x.state !== 'deleted')).length;
    if (unposted > 0) blockers.push(`${unposted} rendered video(s) not yet drafted into Buffer (publish step did not run or failed)`);
    const clearedUnrendered = candidates.filter((c) => c.rights_status === 'cleared' && ['scored', 'ready'].includes(c.status)).length;
    if (clearedUnrendered > 0) blockers.push(`${clearedUnrendered} cleared candidate(s) waiting to be rendered`);
    const uncleared = candidates.filter((c) => !['cleared', 'denied', 'transformation_review', 'owner_reviewed'].includes(c.rights_status) && ['scored', 'ready'].includes(c.status)).length;
    if (uncleared > 0) blockers.push(`${uncleared} good candidate(s) blocked on footage rights (no automated clearance available for their source)`);
    const highRisk = candidates.filter((c) => c.copyright_risk === 'high').length;
    if (highRisk > 0) blockers.push(`${highRisk} candidate(s) excluded as high copyright risk (broadcast/pro/music content)`);
    if (candidates.length === 0) blockers.push('no candidates discovered: discovery sources are not configured or returned nothing');
    if (videosMissing > 0 && blockers.length === 0) blockers.push('not enough eligible footage from the configured sources');
  }

  return {
    week: plan.week,
    generated_at: (input.now ?? new Date()).toISOString(),
    target_videos: targetVideos,
    target_posts: plan.slots.length,
    funnel: {
      discovered: candidates.length,
      scored_pass: scoredPass,
      cleared_for_reuse: cleared,
      rendered,
      drafts_created: live.length,
      awaiting_approval: live.filter((p) => p.state === 'draft' || p.state === 'needs_approval').length,
      approved: live.filter((p) => p.state === 'scheduled' || p.state === 'sending').length,
      published: live.filter((p) => p.state === 'sent').length,
      rejected: posts.filter((p) => p.state === 'deleted').length,
      errored: posts.filter((p) => p.state === 'error').length,
    },
    videos_ready: videosReady,
    videos_ready_cleared: videosReady - reviewProdIds.size,
    videos_ready_review: reviewProdIds.size,
    videos_missing: videosMissing,
    missing_slots,
    shortage_reasons: reasons,
    blockers,
    complete: videosMissing === 0 && missing_slots.length === 0,
  };
}

export function formatReadinessMarkdown(r: ReadinessReport): string {
  const f = r.funnel;
  const lines = [
    `## Weekly readiness – ${r.week} ${r.complete ? '✅ complete' : `⚠️ INCOMPLETE (${r.videos_missing} of ${r.target_videos} videos missing)`}`,
    '',
    '| Stage | Count |',
    '|---|---|',
    `| Target videos | ${r.target_videos} (${r.target_posts} posts across YouTube + TikTok) |`,
    `| Candidates discovered | ${f.discovered} |`,
    `| Passed scoring | ${f.scored_pass} |`,
    `| Cleared for reuse | ${f.cleared_for_reuse} |`,
    `| Rendered (public URL) | ${f.rendered} |`,
    `| Buffer drafts created (this week) | ${f.drafts_created} |`,
    `| Awaiting approval | ${f.awaiting_approval} |`,
    `| Approved (scheduled) | ${f.approved} |`,
    `| Published | ${f.published} |`,
    `| Rejected by owner | ${f.rejected} |`,
    `| Errors | ${f.errored} |`,
    `| **Videos ready** | **${r.videos_ready} / ${r.target_videos}** (${r.videos_ready_cleared} with explicit reuse basis, ${r.videos_ready_review} transformation-review ⚠️) |`,
    `| Missing slots | ${r.missing_slots.length} |`,
  ];
  if (Object.keys(r.shortage_reasons).length) {
    lines.push('', '**Shortage reasons**');
    for (const [k, v] of Object.entries(r.shortage_reasons).sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${v}`);
  }
  if (r.blockers.length) {
    lines.push('', '**Blockers**');
    for (const b of r.blockers) lines.push(`- ${b}`);
  }
  if (r.videos_ready_review > 0) {
    lines.push('', `⚠️ ${r.videos_ready_review} draft video(s) use footage WITHOUT an explicit reuse license. Each carries a review note in Buffer; approving is your decision and records it. Transformation is not a license.`);
  }
  if (r.missing_slots.length) {
    lines.push('', `**Unfilled slots** (first ${Math.min(10, r.missing_slots.length)})`);
    for (const s of r.missing_slots.slice(0, 10)) lines.push(`- ${s.slot_at} ${s.service}`);
  }
  return lines.join('\n');
}
