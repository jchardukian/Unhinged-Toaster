-- The Unhinged Toaster control-plane schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  source_platform TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  media_url TEXT,
  author TEXT,
  author_url TEXT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  duration_sec REAL,
  width INTEGER,
  height INTEGER,
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  engagement_velocity REAL,
  heuristic_score REAL,
  llm_score REAL,
  final_score REAL,
  llm_rationale TEXT,
  safety_flags TEXT,
  phash TEXT,
  duplicate_of TEXT,
  rights_status TEXT NOT NULL DEFAULT 'unknown',
  rights_basis TEXT,
  rights_evidence TEXT,
  rights_notes TEXT,
  attribution_text TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
  status_reason TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (source_platform, source_id)
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_score ON candidates(final_score DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_rights ON candidates(rights_status);

CREATE TABLE IF NOT EXISTS productions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  headline TEXT NOT NULL,
  commentary TEXT NOT NULL,
  caption_text TEXT NOT NULL,
  hashtags TEXT NOT NULL,
  voice_id TEXT,
  music_track TEXT,
  r2_key TEXT,
  public_url TEXT,
  thumbnail_url TEXT,
  duration_sec REAL,
  render_log TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_productions_candidate ON productions(candidate_id);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id),
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  service TEXT NOT NULL,
  buffer_channel_id TEXT NOT NULL,
  buffer_post_id TEXT,
  slot_at TEXT NOT NULL,
  batch_week TEXT NOT NULL,
  state TEXT NOT NULL,
  last_synced_at TEXT,
  buffer_error TEXT,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  metrics_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_state ON posts(state);
CREATE INDEX IF NOT EXISTS idx_posts_week ON posts(batch_week);
CREATE INDEX IF NOT EXISTS idx_posts_buffer ON posts(buffer_post_id);

CREATE TABLE IF NOT EXISTS category_weights (
  category TEXT PRIMARY KEY,
  weight REAL NOT NULL DEFAULT 1,
  samples INTEGER NOT NULL DEFAULT 0,
  avg_views REAL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO category_weights (category, weight, samples, avg_views, updated_at) VALUES
  ('people_fails', 1, 0, NULL, '2026-01-01T00:00:00Z'),
  ('funny_animals', 1, 0, NULL, '2026-01-01T00:00:00Z'),
  ('unbelievable', 1, 0, NULL, '2026-01-01T00:00:00Z'),
  ('wholesome_reactions', 1, 0, NULL, '2026-01-01T00:00:00Z');

-- audit trail of every automated action (sync decisions, dispatches, errors)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT,
  detail TEXT
);
