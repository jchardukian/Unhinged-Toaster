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
  /** Drafts whose footage has NO explicit reuse basis: the owner's copyright judgement is needed per draft. */
  review_items: ReviewItem[];
  /** Drafts with an explicit basis, for completeness. */
  cleared_items: { headline: string; basis: string; source_url: string }[];
  shortage_reasons: Record<string, number>;
  blockers: string[];
  complete: boolean;
}

export interface ReviewItem {
  headline: string;
  production_id: string;
  services: { service: string; buffer_post_id: string | null; state: string; slot_at: string }[];
  source_platform: string;
  source_url: string;
  author: string | null;
  copyright_risk: string | null;
  copyright_risk_reasons: string[];
  rights_status: string;
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
  const candById = new Map(candidates.map((c) => [c.id, c]));
  const prodById = new Map(productions.map((p) => [p.id, p]));
  const review_items: ReviewItem[] = [...reviewProdIds].map((pid) => {
    const prod = prodById.get(pid);
    const c = prod ? candById.get(prod.candidate_id) : undefined;
    let reasons: string[] = [];
    try { reasons = JSON.parse(c?.copyright_risk_reasons ?? '[]'); } catch { /* ignore */ }
    return {
      headline: prod?.headline ?? pid, production_id: pid,
      services: live.filter((p) => p.production_id === pid).map((p) => ({ service: p.service, buffer_post_id: p.buffer_post_id, state: p.state, slot_at: p.slot_at })),
      source_platform: c?.source_platform ?? 'unknown', source_url: c?.source_url ?? '', author: c?.author ?? null,
      copyright_risk: c?.copyright_risk ?? null, copyright_risk_reasons: reasons, rights_status: c?.rights_status ?? 'unknown',
    };
  }).sort((a, b) => a.services[0]?.slot_at.localeCompare(b.services[0]?.slot_at ?? '') ?? 0);
  const cleared_items = [...readyProdIds].filter((pid) => !reviewProdIds.has(pid)).map((pid) => {
    const prod = prodById.get(pid); const c = prod ? candById.get(prod.candidate_id) : undefined;
    return { headline: prod?.headline ?? pid, basis: c?.rights_basis ?? 'unknown', source_url: c?.source_url ?? '' };
  });

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
    review_items,
    cleared_items,
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
  if (r.review_items.length > 0) {
    lines.push('', `### ⚠️ Transformation-review drafts (${r.review_items.length}) – your copyright judgement is needed before approving`,
      'These videos use footage with NO reuse license on file. They are transformed (edits, captions, commentary) and credited, but transformation is not a license and nothing here claims fair use. Approving in Buffer records your decision; deleting rejects. This note is internal and never appears in a public caption.', '',
      '| Slot (UTC) | Headline | Source | Creator | Copyright risk | Buffer post ids |', '|---|---|---|---|---|---|');
    for (const it of r.review_items) {
      lines.push(`| ${it.services[0]?.slot_at ?? ''} | ${it.headline} | ${it.source_platform} ${it.source_url} | ${it.author ?? '–'} | ${it.copyright_risk ?? 'unknown'}${it.copyright_risk_reasons.length ? ` (${it.copyright_risk_reasons.slice(0, 2).join('; ')})` : ''} | ${it.services.map((s) => `${s.service}:${s.buffer_post_id ?? '-'}`).join(' ')} |`);
    }
  }
  if (r.cleared_items.length > 0) {
    lines.push('', `### ✅ Drafts with an explicit reuse basis (${r.cleared_items.length})`);
    for (const it of r.cleared_items.slice(0, 30)) lines.push(`- ${it.headline} — ${it.basis} — ${it.source_url}`);
  }
  if (r.missing_slots.length) {
    lines.push('', `**Unfilled slots** (first ${Math.min(10, r.missing_slots.length)})`);
    for (const s of r.missing_slots.slice(0, 10)) lines.push(`- ${s.slot_at} ${s.service}`);
  }
  return lines.join('\n');
}
