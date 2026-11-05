/**
 * Shared domain types for The Unhinged Toaster pipeline.
 * These mirror the D1 schema in packages/worker/migrations.
 */

export type ContentCategory =
  | 'people_fails'
  | 'funny_animals'
  | 'unbelievable'
  | 'wholesome_reactions';

export const CONTENT_CATEGORIES: ContentCategory[] = [
  'people_fails',
  'funny_animals',
  'unbelievable',
  'wholesome_reactions',
];

export type SourcePlatform = 'reddit' | 'youtube' | 'tiktok' | 'pexels' | 'pixabay' | 'internet_archive' | 'manual' | 'licensed_library';
/** Discovery adapter names (a platform can have several adapters). */
export type SourceAdapter = SourcePlatform | 'youtube_trending' | 'youtube_search' | 'youtube_viral' | 'reddit_rss';

/**
 * Rights lifecycle.
 *   unknown               -> discovered, no license information, not eligible for anything
 *   transformation_review -> no explicit reuse license (typical viral UGC). May be rendered into a transformed short and
 *                            drafted for the OWNER's review, clearly labelled. Never auto-classified as licensed/cleared.
 *   owner_reviewed        -> the owner approved a transformation-review draft in Buffer; the approval (post id + time)
 *                            is the recorded basis. Still not "cleared": it is the owner's own transformative-use decision.
 *   outreach_pending      -> permission request drafted / sent to the creator
 *   cleared               -> we hold an explicit usable basis + evidence (license, permission, PD, CC BY with low provenance risk)
 *   denied                -> creator declined, takedown, or source license forbids reuse
 *   expired               -> time-limited license lapsed
 */
export type RightsStatus = 'unknown' | 'transformation_review' | 'owner_reviewed' | 'outreach_pending' | 'cleared' | 'denied' | 'expired';

/** Copyright-risk assessment for footage without an explicit license (LLM + heuristics). `high` is never produced. */
export type CopyrightRisk = 'low' | 'medium' | 'high';

/** Legal basis for reuse. Each requires evidence (URL / file) stored alongside it. */
export type RightsBasis =
  | 'cc_by'              // Creative Commons Attribution (e.g. YouTube "creativeCommon" license)
  | 'cc0'                // public domain dedication
  | 'public_domain'
  | 'pexels_license'
  | 'pixabay_license'
  | 'written_permission' // DM / email from the creator, archived
  | 'licensed'           // paid license (Jukin, ViralHog, Newsflare, Storyful ...)
  | 'owned'              // produced by us
  | 'owner_transformative_use'; // owner approved a labelled transformation-review draft; NOT a license

export const CLEARABLE_BASES: RightsBasis[] = [
  'cc_by', 'cc0', 'public_domain', 'pexels_license', 'pixabay_license', 'written_permission', 'licensed', 'owned',
];

export type CandidateStatus =
  | 'discovered'
  | 'scored'
  | 'rejected_score'
  | 'rejected_duplicate'
  | 'rejected_safety'
  | 'rejected_quality'  // source below 720p-class
  | 'blocked_rights'
  | 'ready'          // cleared + scored, waiting to be produced
  | 'producing'
  | 'produced'       // rendered video exists in R2
  | 'drafted'        // Buffer drafts exist
  | 'approved'       // user approved in Buffer (status moved to scheduled)
  | 'published'
  | 'rejected_user'  // user deleted / rejected the draft in Buffer
  | 'failed';

export interface Candidate {
  id: string;                    // ulid
  source_platform: SourcePlatform;
  source_id: string;             // platform-native id
  source_url: string;            // canonical URL to the original post
  media_url: string | null;      // direct downloadable media URL (may expire)
  author: string | null;
  author_url: string | null;
  title: string;
  description: string | null;
  category: ContentCategory | null;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  published_at: string | null;   // ISO
  discovered_at: string;         // ISO
  // engagement snapshot at discovery
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  engagement_velocity: number | null;  // likes per hour since publish
  // scoring
  heuristic_score: number | null;      // 0-100
  llm_score: number | null;            // 0-100
  final_score: number | null;          // 0-100 (after category weight)
  llm_rationale: string | null;
  safety_flags: string | null;         // JSON array of strings
  // dedupe
  phash: string | null;                // hex, 64-bit per sampled frame joined by ':'
  duplicate_of: string | null;
  // rights
  rights_status: RightsStatus;
  rights_basis: RightsBasis | null;
  rights_evidence: string | null;      // URL / note / archived message id
  rights_notes: string | null;
  copyright_risk: CopyrightRisk | null;        // for transformation_review footage
  quality_tier?: 'hd' | 'ok' | 'low' | null;   // see quality.ts; 'ok' is last-resort only
  detected_handle?: string | null;             // creator handle visible in the footage (watermark), e.g. "davlyat_official"
  detected_platform?: string | null;           // "instagram" | "tiktok" | "youtube" | "snapchat" | ... when a platform watermark is visible
  visual_summary?: string | null;              // what happens in the clip, from the vision pass
  copyright_risk_reasons: string | null;       // JSON array of strings
  attribution_text: string | null;     // what we print in the description
  status: CandidateStatus;
  status_reason: string | null;
  updated_at: string;
}

export interface Production {
  id: string;                    // ulid
  candidate_id: string;
  headline: string;
  commentary: string;
  caption_text: string;          // post caption/description incl. attribution
  hashtags: string;              // JSON array
  voice_id: string | null;
  music_track: string | null;
  r2_key: string | null;         // rendered mp4
  public_url: string | null;
  thumbnail_url: string | null;
  duration_sec: number | null;
  render_log: string | null;
  reuse_basis?: 'cleared' | 'review' | null;   // basis at render time (see rights.ts productionBasis)
  edit_plan?: string | null;                   // JSON EditBeats actually applied
  created_at: string;
  updated_at: string;
}

export type BufferService = 'youtube' | 'tiktok';

export type BufferPostState =
  | 'draft'
  | 'needs_approval'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'error'
  | 'deleted';

export interface ScheduledPost {
  id: string;                     // ulid
  production_id: string;
  candidate_id: string;
  service: BufferService;
  buffer_channel_id: string;
  buffer_post_id: string | null;
  slot_at: string;                // intended publish time ISO (UTC)
  batch_week: string;             // e.g. 2026-W46
  state: BufferPostState;
  last_synced_at: string | null;
  buffer_error: string | null;
  sync_error?: string | null;          // last transient problem talking to Buffer (state untouched)
  missing_count?: number;              // consecutive "not found" observations
  missing_since?: string | null;       // first "not found" observation
  idempotency_key?: string | null;     // `${batch_week}|${slot_at}|${service}`
  create_attempts?: number;
  reuse_uncertain?: boolean;           // draft carries a REVIEW block; footage has no explicit license
  public_text?: string | null;         // clean caption to write back on approval (review block stripped)
  review_block_stripped?: boolean;
  // performance (filled by metrics sync)
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  metrics_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CategoryWeight {
  category: ContentCategory;
  weight: number;        // multiplier around 1.0, clamped [0.6, 1.6]
  samples: number;
  avg_views: number | null;
  updated_at: string;
}

export interface SlotPlan {
  week: string;
  slots: { slot_at: string; service: BufferService }[];
}

export interface LlmScoreResult {
  entertainment: number;     // 0-10
  surprise: number;          // 0-10
  clarity: number;           // 0-10 (works without context, within 3 seconds)
  brand_fit: number;         // 0-10
  rewatchability: number;    // 0-10
  category: ContentCategory;
  safety_flags: string[];    // e.g. ["minor_visible", "injury", "nsfw", "hate", "copyrighted_music", "private_person_mocking"]
  rationale: string;
}

export interface CopyResult {
  headline: string;      // <= 60 chars, punchy, comic-book energy
  commentary: string;    // ONE sentence, <= 110 chars, spoken by the toaster
  caption: string;       // post description without attribution/hashtags
  hashtags: string[];    // 4-8 tags without '#'
  sticker?: string;      // 1-3 word comic reaction shown at the peak moment ("NOPE.", "WHY.", "OH NO")
  freeze_text?: string;  // short text for the pre-peak freeze frame ("WAIT FOR IT…")
  edit_style?: 'full' | 'light';  // light = fewer beats (clip is already very short or dialogue-driven)
  commentary_mode?: CommentaryMode; // whether the toaster speaks at all: the clip's own sound is often the joke
  music?: 'light' | 'none';        // light background bed, or none when the clip's own audio must stay clean
}

/** outro_voice = spoken + on-screen line after the clip; text_only = on-screen line, no voice; none = let the clip's sound land. */
export type CommentaryMode = 'outro_voice' | 'text_only' | 'none';
