/**
 * Minimal Buffer GraphQL client (https://api.buffer.com).
 * Verified against Buffer's developer docs on 2026-11-02:
 *   - POST https://api.buffer.com, JSON body { query, variables }
 *   - Authorization: Bearer <API key from Settings > API>
 *   - createPost(input: CreatePostInput!) with mode addToQueue|customScheduled|shareNow|shareNext,
 *     schedulingType automatic|notification, saveToDraft, needsApproval (Team plan), dueAt, assets, metadata
 *   - posts(input:{organizationId, filter:{status, channelIds, dueAt, createdAt}}, first, after)
 *   - post statuses: draft, needs_approval, scheduled, sending, sent, error
 *   - No webhooks: state changes are detected by polling.
 *   - Rate limits (Essentials): 450 / 15 min, 1 800 / 24 h, 3 000 per channel / 30 d.
 * Runs in Node 22 and Cloudflare Workers (fetch only).
 */

export interface BufferClientOptions {
  apiKey: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

export interface BufferPost {
  id: string;
  status: string;
  text: string | null;
  dueAt: string | null;
  sentAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  channelId?: string;
  channel?: { id: string; service: string } | null;
  allowedActions?: string[] | null;
  error?: { message?: string | null } | null;
  assets?: { id?: string; mimeType?: string | null }[] | null;
  metrics?: { type: string; value: number | null }[] | null;
  metricsUpdatedAt?: string | null;
  externalLink?: string | null;
}

export type BufferMode = 'addToQueue' | 'customScheduled' | 'shareNow' | 'shareNext';

export interface CreateVideoPostInput {
  channelId: string;
  text: string;
  videoUrl: string;
  dueAt?: string;              // required when mode = customScheduled
  mode?: BufferMode;
  saveToDraft?: boolean;
  needsApproval?: boolean;     // Team plan only
  youtube?: { title: string; categoryId: string; privacy?: 'public' | 'private' | 'unlisted'; madeForKids?: boolean; notifySubscribers?: boolean; license?: 'youtube' | 'creativeCommon'; isAiGenerated?: boolean };
  tiktok?: { title?: string; isAiGenerated?: boolean };
  tagIds?: string[];
  videoTitle?: string;
}

export class BufferApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterSec?: number, public readonly body?: unknown) {
    super(message);
  }
}

export class BufferClient {
  private readonly endpoint: string;
  private readonly f: typeof fetch;
  private readonly maxRetries: number;
  public lastRateLimit: string | null = null;

  constructor(private readonly opts: BufferClientOptions) {
    this.endpoint = opts.endpoint ?? 'https://api.buffer.com';
    this.f = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async gql<T>(query: string, variables: Record<string, unknown> = {}, opts: { allowPartial?: boolean } = {}): Promise<T> {
    let attempt = 0;
    for (;;) {
      const res = await this.f(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({ query, variables }),
      });
      this.lastRateLimit = res.headers.get('ratelimit');
      if (res.status === 429 && attempt < this.maxRetries) {
        const retry = Number(res.headers.get('retry-after') ?? '5');
        await sleep(Math.min(retry, 60) * 1000);
        attempt++;
        continue;
      }
      const json = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
      if (!res.ok) {
        throw new BufferApiError(`Buffer HTTP ${res.status}: ${json?.errors?.map((e) => e.message).join('; ') ?? res.statusText}`, res.status, undefined, json);
      }
      if (json?.errors?.length && !(opts.allowPartial && json.data)) throw new BufferApiError(`Buffer GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`, res.status, undefined, json);
      if (!json?.data) throw new BufferApiError('Buffer returned no data', res.status, undefined, json);
      return json.data;
    }
  }

  async account(): Promise<{ id: string; timezone: string; organizations: { id: string; name: string }[] }> {
    const d = await this.gql<{ account: { id: string; timezone: string; organizations: { id: string; name: string }[] } }>(
      `query { account { id timezone organizations { id name } } }`,
    );
    return d.account;
  }

  async channels(organizationId: string): Promise<{ id: string; name: string; service: string; timezone?: string }[]> {
    const d = await this.gql<{ channels: { id: string; name: string; service: string; timezone?: string }[] }>(
      `query($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id name service timezone } }`,
      { organizationId },
    );
    return d.channels;
  }

  /** Create a video post. Defaults to a DRAFT (saveToDraft: true) — nothing is published without approval. */
  async createVideoPost(input: CreateVideoPostInput): Promise<BufferPost> {
    const metadata: Record<string, unknown> = {};
    if (input.youtube) metadata.youtube = { privacy: 'public', madeForKids: false, notifySubscribers: true, ...input.youtube };
    if (input.tiktok) metadata.tiktok = input.tiktok;
    const gqlInput: Record<string, unknown> = {
      channelId: input.channelId,
      text: input.text,
      schedulingType: 'automatic',
      mode: input.mode ?? (input.dueAt ? 'customScheduled' : 'addToQueue'),
      saveToDraft: input.saveToDraft ?? true,
      assets: [{ video: { url: input.videoUrl, metadata: input.videoTitle ? { title: input.videoTitle } : undefined } }],
      metadata,
    };
    if (input.dueAt) gqlInput.dueAt = input.dueAt;
    if (input.needsApproval) gqlInput.needsApproval = true;
    if (input.tagIds?.length) gqlInput.tagIds = input.tagIds;

    const d = await this.gql<{ createPost: { __typename: string; message?: string; post?: BufferPost } }>(
      `mutation($input: CreatePostInput!) {
         createPost(input: $input) {
           __typename
           ... on PostActionSuccess { post { ${POST_FIELDS} } }
           ... on MutationError { message }
         }
       }`,
      { input: gqlInput },
    );
    if (!d.createPost.post) throw new BufferApiError(`createPost failed: ${d.createPost.message ?? d.createPost.__typename}`, 200, undefined, d);
    return d.createPost.post;
  }

  async getPost(id: string): Promise<BufferPost | null> {
    try {
      const d = await this.gql<{ post: BufferPost | null }>(`query($id: PostId!) { post(input: { id: $id }) { ${POST_FIELDS} } }`, { id });
      return d.post;
    } catch (e) {
      if (e instanceof BufferApiError && /not found|NotFound/i.test(e.message)) return null;
      throw e;
    }
  }

  /** Fetch several posts by id in one request using aliases (max 30 aliases per query per Buffer limits). */
  async getPosts(ids: string[]): Promise<Map<string, BufferPost | null>> {
    const out = new Map<string, BufferPost | null>();
    for (let i = 0; i < ids.length; i += 25) {
      const chunk = ids.slice(i, i + 25);
      const vars: Record<string, string> = {};
      const parts = chunk.map((id, k) => {
        vars[`id${k}`] = id;
        return `p${k}: post(input: { id: $id${k} }) { ${POST_FIELDS} }`;
      });
      const varDecl = chunk.map((_, k) => `$id${k}: PostId!`).join(', ');
      // A deleted post yields a per-alias "Post not found for id: X" error with partial data (verified live);
      // null for that alias is exactly what reconcile needs ("user rejected the draft").
      const d = await this.gql<Record<string, BufferPost | null>>(`query(${varDecl}) { ${parts.join('\n')} }`, vars, { allowPartial: true });
      chunk.forEach((id, k) => out.set(id, d[`p${k}`] ?? null));
    }
    return out;
  }

  async listPosts(params: {
    organizationId: string;
    channelIds?: string[];
    status?: string[];
    createdAfter?: string;
    dueAfter?: string;
    dueBefore?: string;
    first?: number;
    after?: string;
  }): Promise<{ posts: BufferPost[]; hasNextPage: boolean; endCursor: string | null }> {
    const filter: Record<string, unknown> = {};
    if (params.channelIds) filter.channelIds = params.channelIds;
    if (params.status) filter.status = params.status;
    if (params.createdAfter) filter.createdAt = { start: params.createdAfter };
    if (params.dueAfter || params.dueBefore) filter.dueAt = { start: params.dueAfter, end: params.dueBefore };
    const d = await this.gql<{ posts: { edges: { node: BufferPost }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      `query($input: PostsInput!, $first: Int, $after: String) {
         posts(input: $input, first: $first, after: $after) {
           edges { node { ${POST_FIELDS} } }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { input: { organizationId: params.organizationId, filter, sort: [{ field: 'dueAt', direction: 'asc' }] }, first: params.first ?? 50, after: params.after },
    );
    return { posts: d.posts.edges.map((e) => e.node), hasNextPage: d.posts.pageInfo.hasNextPage, endCursor: d.posts.pageInfo.endCursor };
  }

  /** Move an approved post to its exact slot (customScheduled). */
  async reschedulePost(id: string, dueAt: string): Promise<BufferPost> {
    const d = await this.gql<{ editPost: { __typename: string; message?: string; post?: BufferPost } }>(
      `mutation($input: EditPostInput!) {
         editPost(input: $input) {
           __typename
           ... on PostActionSuccess { post { ${POST_FIELDS} } }
           ... on MutationError { message }
         }
       }`,
      { input: { id, dueAt, mode: 'customScheduled' } },
    );
    if (!d.editPost.post) throw new BufferApiError(`editPost failed: ${d.editPost.message ?? d.editPost.__typename}`, 200, undefined, d);
    return d.editPost.post;
  }

  async deletePost(id: string): Promise<boolean> {
    const d = await this.gql<{ deletePost: { __typename: string; message?: string } }>(
      `mutation($input: DeletePostInput!) { deletePost(input: $input) { __typename ... on MutationError { message } } }`,
      { input: { id } },
    );
    return !/Error/.test(d.deletePost.__typename);
  }

  async postMetrics(ids: string[]): Promise<Map<string, { metrics: Record<string, number>; updatedAt: string | null }>> {
    const posts = await this.getPosts(ids);
    const out = new Map<string, { metrics: Record<string, number>; updatedAt: string | null }>();
    for (const [id, p] of posts) {
      if (!p) continue;
      const m: Record<string, number> = {};
      for (const x of p.metrics ?? []) if (x.value != null) m[x.type] = x.value;
      out.set(id, { metrics: m, updatedAt: p.metricsUpdatedAt ?? null });
    }
    return out;
  }
}

const POST_FIELDS = `id status text dueAt createdAt updatedAt allowedActions
  channel { id service }
  assets { ... on VideoAsset { id mimeType } ... on ImageAsset { id mimeType } }
  metrics { type value }
  metricsUpdatedAt
  error { message }`;

/** Map Buffer metric types to our columns. */
export function normaliseMetrics(m: Record<string, number>): { views: number | null; likes: number | null; comments: number | null; shares: number | null } {
  return {
    views: pick(m, ['views', 'impressions', 'reach']),
    likes: pick(m, ['reactions', 'likes', 'favorites']),
    comments: pick(m, ['comments', 'replies']),
    shares: pick(m, ['shares', 'reposts', 'retweets']),
  };
}
function pick(m: Record<string, number>, keys: string[]): number | null {
  for (const k of keys) if (m[k] != null) return m[k];
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
