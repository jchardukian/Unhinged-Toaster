import fs from 'node:fs';
import path from 'node:path';
import type { Candidate, CategoryWeight, DedupeExisting, Production, ScheduledPost } from '@toaster/shared';
import { defaultCategoryWeights } from '@toaster/shared';
import type { Config } from './config.js';

/**
 * Store abstraction. Production uses the Cloudflare Worker (D1) through HTTP;
 * local development and CI smoke tests use a JSON file so the pipeline runs with zero cloud setup.
 */
export interface Store {
  upsertCandidates(cs: Candidate[]): Promise<void>;
  listCandidates(filter?: { status?: Candidate['status'][]; limit?: number }): Promise<Candidate[]>;
  getCandidate(id: string): Promise<Candidate | null>;
  patchCandidate(id: string, patch: Partial<Candidate>): Promise<Candidate>;
  dedupeIndex(): Promise<DedupeExisting[]>;
  upsertProduction(p: Production): Promise<void>;
  listProductions(filter?: { candidate_id?: string }): Promise<Production[]>;
  upsertPost(p: ScheduledPost): Promise<void>;
  listPosts(filter?: { state?: ScheduledPost['state'][]; week?: string }): Promise<ScheduledPost[]>;
  weights(): Promise<CategoryWeight[]>;
  saveWeights(w: CategoryWeight[]): Promise<void>;
}

export function makeStore(cfg: Config): Store {
  if (cfg.apiUrl && cfg.apiToken) return new ApiStore(cfg.apiUrl, cfg.apiToken);
  return new JsonStore(path.join(cfg.workDir, 'db.json'));
}

interface Db { candidates: Candidate[]; productions: Production[]; posts: ScheduledPost[]; weights: CategoryWeight[] }

export class JsonStore implements Store {
  private db: Db;
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Db)
      : { candidates: [], productions: [], posts: [], weights: defaultCategoryWeights(new Date().toISOString()) };
  }
  private save() { fs.writeFileSync(this.file, JSON.stringify(this.db, null, 2)); }

  async upsertCandidates(cs: Candidate[]) {
    for (const c of cs) {
      const i = this.db.candidates.findIndex((x) => x.id === c.id || (x.source_platform === c.source_platform && x.source_id === c.source_id));
      if (i >= 0) this.db.candidates[i] = { ...this.db.candidates[i], ...c, id: this.db.candidates[i].id };
      else this.db.candidates.push(c);
    }
    this.save();
  }
  async listCandidates(filter: { status?: Candidate['status'][]; limit?: number } = {}) {
    let out = this.db.candidates;
    if (filter.status) out = out.filter((c) => filter.status!.includes(c.status));
    out = [...out].sort((a, b) => (b.final_score ?? -1) - (a.final_score ?? -1));
    return filter.limit ? out.slice(0, filter.limit) : out;
  }
  async getCandidate(id: string) { return this.db.candidates.find((c) => c.id === id) ?? null; }
  async patchCandidate(id: string, patch: Partial<Candidate>) {
    const c = this.db.candidates.find((x) => x.id === id);
    if (!c) throw new Error(`candidate ${id} not found`);
    Object.assign(c, patch, { updated_at: new Date().toISOString() });
    this.save();
    return c;
  }
  async dedupeIndex() { return this.db.candidates.map((c) => ({ id: c.id, source_url: c.source_url, phash: c.phash, title: c.title, duration_sec: c.duration_sec })); }
  async upsertProduction(p: Production) {
    const i = this.db.productions.findIndex((x) => x.id === p.id);
    if (i >= 0) this.db.productions[i] = p; else this.db.productions.push(p);
    this.save();
  }
  async listProductions(filter: { candidate_id?: string } = {}) {
    return this.db.productions.filter((p) => !filter.candidate_id || p.candidate_id === filter.candidate_id);
  }
  async upsertPost(p: ScheduledPost) {
    const i = this.db.posts.findIndex((x) => x.id === p.id);
    if (i >= 0) this.db.posts[i] = p; else this.db.posts.push(p);
    this.save();
  }
  async listPosts(filter: { state?: ScheduledPost['state'][]; week?: string } = {}) {
    return this.db.posts.filter((p) => (!filter.state || filter.state.includes(p.state)) && (!filter.week || p.batch_week === filter.week));
  }
  async weights() { return this.db.weights; }
  async saveWeights(w: CategoryWeight[]) { this.db.weights = w; this.save(); }
}

export class ApiStore implements Store {
  constructor(private readonly base: string, private readonly token: string) {}
  private async req<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base.replace(/\/$/, '') + route, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API ${method} ${route} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
  upsertCandidates(cs: Candidate[]) { return this.req<void>('POST', '/candidates', cs); }
  listCandidates(filter: { status?: Candidate['status'][]; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status.join(','));
    if (filter.limit) q.set('limit', String(filter.limit));
    return this.req<Candidate[]>('GET', `/candidates?${q}`);
  }
  getCandidate(id: string) { return this.req<Candidate | null>('GET', `/candidates/${id}`); }
  patchCandidate(id: string, patch: Partial<Candidate>) { return this.req<Candidate>('PATCH', `/candidates/${id}`, patch); }
  dedupeIndex() { return this.req<DedupeExisting[]>('GET', '/candidates/dedupe-index'); }
  upsertProduction(p: Production) { return this.req<void>('POST', '/productions', p); }
  listProductions(filter: { candidate_id?: string } = {}) {
    const q = new URLSearchParams();
    if (filter.candidate_id) q.set('candidate_id', filter.candidate_id);
    return this.req<Production[]>('GET', `/productions?${q}`);
  }
  upsertPost(p: ScheduledPost) { return this.req<void>('POST', '/posts', p); }
  listPosts(filter: { state?: ScheduledPost['state'][]; week?: string } = {}) {
    const q = new URLSearchParams();
    if (filter.state) q.set('state', filter.state.join(','));
    if (filter.week) q.set('week', filter.week);
    return this.req<ScheduledPost[]>('GET', `/posts?${q}`);
  }
  weights() { return this.req<CategoryWeight[]>('GET', '/weights'); }
  saveWeights(w: CategoryWeight[]) { return this.req<void>('PUT', '/weights', w); }
}
