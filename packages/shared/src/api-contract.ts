/**
 * HTTP contract between the pipeline runner (GitHub Actions) and the control-plane Worker.
 * All routes require `Authorization: Bearer <API_TOKEN>`.
 */
import type { Candidate, CategoryWeight, Production, ScheduledPost } from './types.js';

export const API_ROUTES = {
  health: 'GET /health',
  upsertCandidates: 'POST /candidates',                 // body: Partial<Candidate>[] (insert or update by source_platform+source_id)
  listCandidates: 'GET /candidates?status=..&limit=..',  // -> Candidate[]
  getCandidate: 'GET /candidates/:id',
  patchCandidate: 'PATCH /candidates/:id',               // body: Partial<Candidate>
  dedupeIndex: 'GET /candidates/dedupe-index',           // -> {id, source_url, phash, title, duration_sec}[]
  upsertProduction: 'POST /productions',                 // body: Production
  listProductions: 'GET /productions?candidate_id=..',
  upsertPost: 'POST /posts',                             // body: ScheduledPost
  listPosts: 'GET /posts?state=..&week=..',
  weights: 'GET /weights',                               // -> CategoryWeight[]
  sync: 'POST /sync/buffer',                             // poll Buffer, reconcile states, reschedule approved
  metrics: 'POST /sync/metrics',                         // pull metrics + learn
  weekStatus: 'GET /weeks/:week',                        // -> {week, slots_total, drafted, approved, rejected, open_slots}
} as const;

export interface WeekStatus {
  week: string;
  slots_total: number;
  drafted: number;
  approved: number;
  scheduled: number;
  published: number;
  rejected: number;
  open_slots: { slot_at: string; service: string }[];
}

export interface SyncResult {
  checked: number;
  approved: number;
  rejected: number;
  published: number;
  errors: { post_id: string; error: string }[];
  replacements_needed: number;
}

export type { Candidate, Production, ScheduledPost, CategoryWeight };
