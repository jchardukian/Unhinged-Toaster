/**
 * The Unhinged Toaster control plane (Cloudflare Worker + D1 + R2).
 *  - REST API used by the pipeline runner (GitHub Actions) to persist candidates / productions / posts
 *  - Cron: poll Buffer for approvals & rejections (Buffer has no webhooks), pull metrics, dispatch weekly batch
 *  - Serves rendered media from R2 at /media/<key> (if no public bucket domain is configured)
 */
import {
  BufferClient, normaliseMetrics, reconcilePost, toBufferDueAt, updateCategoryWeights, buildWeekPlan,
  type Candidate, type CategoryWeight, type ContentCategory, type Production, type ScheduledPost, type SyncResult, type WeekStatus,
} from '@toaster/shared';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  API_TOKEN: string;
  BUFFER_API_KEY?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO: string;
  BUFFER_ORGANIZATION_ID: string;
  BUFFER_YOUTUBE_CHANNEL_ID: string;
  BUFFER_TIKTOK_CHANNEL_ID: string;
  BUFFER_TIMEZONE: string;
  PUBLISH_SLOTS: string;
}

const CANDIDATE_COLS = ['id', 'source_platform', 'source_id', 'source_url', 'media_url', 'author', 'author_url', 'title', 'description', 'category', 'duration_sec', 'width', 'height', 'published_at', 'discovered_at', 'views', 'likes', 'comments', 'shares', 'engagement_velocity', 'heuristic_score', 'llm_score', 'final_score', 'llm_rationale', 'safety_flags', 'phash', 'duplicate_of', 'rights_status', 'rights_basis', 'rights_evidence', 'rights_notes', 'attribution_text', 'status', 'status_reason', 'updated_at'] as const;
const PRODUCTION_COLS = ['id', 'candidate_id', 'headline', 'commentary', 'caption_text', 'hashtags', 'voice_id', 'music_track', 'r2_key', 'public_url', 'thumbnail_url', 'duration_sec', 'render_log', 'created_at', 'updated_at'] as const;
const POST_COLS = ['id', 'production_id', 'candidate_id', 'service', 'buffer_channel_id', 'buffer_post_id', 'slot_at', 'batch_week', 'state', 'last_synced_at', 'buffer_error', 'views', 'likes', 'comments', 'shares', 'metrics_updated_at', 'created_at', 'updated_at'] as const;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/health') return json({ ok: true, at: new Date().toISOString() });
      if (url.pathname.startsWith('/media/')) return serveMedia(env, url.pathname.slice('/media/'.length), req);
      if (!authorised(req, env)) return json({ error: 'unauthorised' }, 401);
      return await route(req, env, url, ctx);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '*/30 * * * *') ctx.waitUntil(syncBuffer(env).then((r) => logEvent(env, 'sync', null, r)));
    else if (event.cron === '0 3 * * *') ctx.waitUntil(learn(env).then((r) => logEvent(env, 'learn', null, r)));
    else if (event.cron === '0 14 * * 0') ctx.waitUntil(dispatchWorkflow(env, 'weekly-batch.yml').then((r) => logEvent(env, 'dispatch', 'weekly-batch', r)));
  },
};

function authorised(req: Request, env: Env): boolean {
  const h = req.headers.get('authorization') ?? '';
  return !!env.API_TOKEN && h === `Bearer ${env.API_TOKEN}`;
}

async function route(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const p = url.pathname.replace(/\/$/, '');
  const m = req.method;

  if (m === 'GET' && p === '/candidates/dedupe-index') {
    const { results } = await env.DB.prepare('SELECT id, source_url, phash, title, duration_sec FROM candidates').all();
    return json(results);
  }
  if (m === 'GET' && p === '/candidates') {
    const status = url.searchParams.get('status')?.split(',').filter(Boolean);
    const limit = Math.min(1000, Number(url.searchParams.get('limit') ?? 500));
    const where = status?.length ? `WHERE status IN (${status.map(() => '?').join(',')})` : '';
    const { results } = await env.DB.prepare(`SELECT * FROM candidates ${where} ORDER BY final_score DESC NULLS LAST, discovered_at DESC LIMIT ?`).bind(...(status ?? []), limit).all();
    return json(results);
  }
  if (m === 'POST' && p === '/candidates') {
    const rows = (await req.json()) as Candidate[];
    const stmts = rows.map((c) => upsertStmt(env, 'candidates', CANDIDATE_COLS, c, 'id', ['id', 'source_platform', 'source_id', 'discovered_at']));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    return json({ upserted: rows.length });
  }
  let mm = p.match(/^\/candidates\/([A-Z0-9]+)$/);
  if (mm && m === 'GET') return json(await env.DB.prepare('SELECT * FROM candidates WHERE id = ?').bind(mm[1]).first());
  if (mm && m === 'PATCH') {
    const patch = (await req.json()) as Partial<Candidate>;
    const cols = Object.keys(patch).filter((k) => (CANDIDATE_COLS as readonly string[]).includes(k) && k !== 'id');
    if (cols.length) {
      await env.DB.prepare(`UPDATE candidates SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .bind(...cols.map((c) => (patch as Record<string, unknown>)[c] ?? null), new Date().toISOString(), mm[1]).run();
    }
    return json(await env.DB.prepare('SELECT * FROM candidates WHERE id = ?').bind(mm[1]).first());
  }

  if (m === 'GET' && p === '/productions') {
    const cid = url.searchParams.get('candidate_id');
    const { results } = cid
      ? await env.DB.prepare('SELECT * FROM productions WHERE candidate_id = ? ORDER BY created_at').bind(cid).all()
      : await env.DB.prepare('SELECT * FROM productions ORDER BY created_at').all();
    return json(results);
  }
  if (m === 'POST' && p === '/productions') {
    await upsertStmt(env, 'productions', PRODUCTION_COLS, (await req.json()) as Production, 'id', ['id', 'created_at']).run();
    return json({ ok: true });
  }

  if (m === 'GET' && p === '/posts') {
    const state = url.searchParams.get('state')?.split(',').filter(Boolean);
    const week = url.searchParams.get('week');
    const conds: string[] = []; const binds: unknown[] = [];
    if (state?.length) { conds.push(`state IN (${state.map(() => '?').join(',')})`); binds.push(...state); }
    if (week) { conds.push('batch_week = ?'); binds.push(week); }
    const { results } = await env.DB.prepare(`SELECT * FROM posts ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY slot_at`).bind(...binds).all();
    return json(results);
  }
  if (m === 'POST' && p === '/posts') {
    await upsertStmt(env, 'posts', POST_COLS, (await req.json()) as ScheduledPost, 'id', ['id', 'created_at']).run();
    return json({ ok: true });
  }

  if (m === 'GET' && p === '/weights') return json((await env.DB.prepare('SELECT * FROM category_weights').all()).results);
  if (m === 'PUT' && p === '/weights') {
    const ws = (await req.json()) as CategoryWeight[];
    await env.DB.batch(ws.map((w) => env.DB.prepare('INSERT INTO category_weights (category, weight, samples, avg_views, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(category) DO UPDATE SET weight=excluded.weight, samples=excluded.samples, avg_views=excluded.avg_views, updated_at=excluded.updated_at').bind(w.category, w.weight, w.samples, w.avg_views, w.updated_at)));
    return json({ ok: true });
  }

  if (m === 'POST' && p === '/sync/buffer') return json(await syncBuffer(env));
  if (m === 'POST' && p === '/sync/metrics') return json(await learn(env));
  if (m === 'POST' && p === '/dispatch/weekly') return json(await dispatchWorkflow(env, 'weekly-batch.yml'));
  if (m === 'POST' && p === '/dispatch/daily') return json(await dispatchWorkflow(env, 'pipeline-daily.yml'));

  mm = p.match(/^\/weeks\/(\d{4}-W\d{2}|next)$/);
  if (mm && m === 'GET') return json(await weekStatus(env, mm[1]));

  if (m === 'GET' && p === '/events') return json((await env.DB.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 200').all()).results);

  // Upload a rendered file straight into R2 through the Worker (alternative to S3 credentials in CI)
  mm = p.match(/^\/upload\/(.+)$/);
  if (mm && m === 'PUT') {
    const key = decodeURIComponent(mm[1]);
    await env.MEDIA.put(key, req.body, { httpMetadata: { contentType: req.headers.get('content-type') ?? 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable' } });
    return json({ key, url: `${url.origin}/media/${key}` });
  }
  void ctx;
  return json({ error: 'not found' }, 404);
}

function upsertStmt(env: Env, table: string, cols: readonly string[], obj: object, key: string, immutable: string[]): D1PreparedStatement {
  const row = obj as Record<string, unknown>;
  const present = cols.filter((c) => row[c] !== undefined);
  const updates = present.filter((c) => !immutable.includes(c)).map((c) => `${c} = excluded.${c}`);
  const conflict = table === 'candidates' ? '(source_platform, source_id)' : `(${key})`;
  return env.DB.prepare(`INSERT INTO ${table} (${present.join(',')}) VALUES (${present.map(() => '?').join(',')}) ON CONFLICT${conflict} DO UPDATE SET ${updates.join(', ')}`)
    .bind(...present.map((c) => (row[c] === undefined ? null : row[c])));
}

async function serveMedia(env: Env, key: string, req: Request): Promise<Response> {
  const obj = await env.MEDIA.get(key, { range: req.headers });
  if (!obj) return new Response('not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  if (obj.range && 'offset' in obj.range) {
    const end = (obj.range.offset ?? 0) + (obj.range.length ?? obj.size) - 1;
    headers.set('content-range', `bytes ${obj.range.offset}-${end}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
}

// ------------------------------------------------------------------ Buffer sync (approval loop)
async function syncBuffer(env: Env): Promise<SyncResult> {
  if (!env.BUFFER_API_KEY) return { checked: 0, approved: 0, rejected: 0, published: 0, errors: [{ post_id: '-', error: 'BUFFER_API_KEY secret missing' }], replacements_needed: 0 };
  const client = new BufferClient({ apiKey: env.BUFFER_API_KEY });
  const { results } = await env.DB.prepare("SELECT * FROM posts WHERE state IN ('draft','needs_approval','scheduled','sending') AND buffer_post_id IS NOT NULL").all<ScheduledPost>();
  const result: SyncResult = { checked: results.length, approved: 0, rejected: 0, published: 0, errors: [], replacements_needed: 0 };
  if (results.length === 0) return result;
  const theirs = await client.getPosts(results.map((p) => p.buffer_post_id!));
  const now = new Date().toISOString();
  for (const p of results) {
    const r = reconcilePost(p, theirs.get(p.buffer_post_id!) ?? null);
    if (r.approved) {
      result.approved++;
      await env.DB.prepare("UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ?").bind(now, p.candidate_id).run();
      if (r.needsReschedule) {
        try { await client.reschedulePost(p.buffer_post_id!, toBufferDueAt(p.slot_at, env.BUFFER_TIMEZONE)); }
        catch (e) { result.errors.push({ post_id: p.buffer_post_id!, error: `reschedule: ${(e as Error).message}` }); }
      }
      await logEvent(env, 'approved', p.id, { service: p.service, slot_at: p.slot_at });
    }
    if (r.rejected) {
      result.rejected++;
      if (Date.parse(p.slot_at) > Date.now() + 3 * 3600_000) result.replacements_needed++;
      await env.DB.prepare("UPDATE candidates SET status = 'rejected_user', status_reason = ?, updated_at = ? WHERE id = ?").bind(`rejected in Buffer (${p.service})`, now, p.candidate_id).run();
      await logEvent(env, 'rejected', p.id, { service: p.service, slot_at: p.slot_at });
    }
    if (r.published) {
      result.published++;
      await env.DB.prepare("UPDATE candidates SET status = 'published', updated_at = ? WHERE id = ?").bind(now, p.candidate_id).run();
    }
    if (r.error) result.errors.push({ post_id: p.buffer_post_id!, error: r.error });
    await env.DB.prepare('UPDATE posts SET state = ?, last_synced_at = ?, buffer_error = ?, updated_at = ? WHERE id = ?').bind(r.state, now, r.error, now, p.id).run();
  }
  // Replacements are rendered by the pipeline runner (needs FFmpeg): kick the workflow.
  if (result.replacements_needed > 0) {
    const d = await dispatchWorkflow(env, 'weekly-batch.yml', { reason: `replace ${result.replacements_needed} rejected post(s)` });
    if (!d.ok) result.errors.push({ post_id: '-', error: `dispatch failed: ${d.detail}` });
  }
  return result;
}

async function learn(env: Env): Promise<{ updated: number; weights: CategoryWeight[] }> {
  const weightsNow = (await env.DB.prepare('SELECT * FROM category_weights').all<CategoryWeight>()).results;
  if (!env.BUFFER_API_KEY) return { updated: 0, weights: weightsNow };
  const client = new BufferClient({ apiKey: env.BUFFER_API_KEY });
  const { results } = await env.DB.prepare("SELECT p.*, c.category AS category FROM posts p JOIN candidates c ON c.id = p.candidate_id WHERE p.state = 'sent' AND p.buffer_post_id IS NOT NULL").all<ScheduledPost & { category: ContentCategory | null }>();
  if (results.length === 0) return { updated: 0, weights: weightsNow };
  const metrics = await client.postMetrics(results.map((p) => p.buffer_post_id!));
  const obs: { category: ContentCategory; views: number }[] = [];
  let updated = 0;
  const now = new Date().toISOString();
  for (const p of results) {
    const m = metrics.get(p.buffer_post_id!);
    if (!m) continue;
    const n = normaliseMetrics(m.metrics);
    await env.DB.prepare('UPDATE posts SET views = ?, likes = ?, comments = ?, shares = ?, metrics_updated_at = ?, updated_at = ? WHERE id = ?')
      .bind(n.views, n.likes, n.comments, n.shares, m.updatedAt ?? now, now, p.id).run();
    updated++;
    if (p.category && n.views != null && Date.parse(p.slot_at) < Date.now() - 48 * 3600_000) obs.push({ category: p.category, views: n.views });
  }
  const weights = updateCategoryWeights(weightsNow, obs, now);
  await env.DB.batch(weights.map((w) => env.DB.prepare('UPDATE category_weights SET weight = ?, samples = ?, avg_views = ?, updated_at = ? WHERE category = ?').bind(w.weight, w.samples, w.avg_views, w.updated_at, w.category)));
  return { updated, weights };
}

async function weekStatus(env: Env, week: string): Promise<WeekStatus> {
  const plan = buildWeekPlan(new Date(), env.BUFFER_TIMEZONE, env.PUBLISH_SLOTS);
  const w = week === 'next' ? plan.week : week;
  const { results } = await env.DB.prepare('SELECT * FROM posts WHERE batch_week = ?').bind(w).all<ScheduledPost>();
  const count = (s: ScheduledPost['state'][]) => results.filter((p) => s.includes(p.state)).length;
  const taken = new Set(results.filter((p) => p.state !== 'deleted').map((p) => `${p.slot_at}|${p.service}`));
  const open = (w === plan.week ? plan.slots : []).filter((s) => !taken.has(`${s.slot_at}|${s.service}`));
  return { week: w, slots_total: 42, drafted: count(['draft', 'needs_approval']), approved: count(['scheduled', 'sending']), scheduled: count(['scheduled']), published: count(['sent']), rejected: count(['deleted']), open_slots: open };
}

async function dispatchWorkflow(env: Env, workflow: string, inputs: Record<string, string> = {}): Promise<{ ok: boolean; detail: string }> {
  if (!env.GITHUB_TOKEN) return { ok: false, detail: 'GITHUB_TOKEN secret missing' };
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'toaster-api', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  return { ok: res.status === 204, detail: res.status === 204 ? 'dispatched' : `${res.status} ${(await res.text()).slice(0, 200)}` };
}

async function logEvent(env: Env, kind: string, refId: string | null, detail: unknown): Promise<void> {
  await env.DB.prepare('INSERT INTO events (at, kind, ref_id, detail) VALUES (?,?,?,?)').bind(new Date().toISOString(), kind, refId, JSON.stringify(detail).slice(0, 4000)).run();
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
