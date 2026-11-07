-- Dog-content pilot: per-format tracking and AI-generation records
ALTER TABLE candidates ADD COLUMN content_format TEXT;   -- general_viral | ai_dog_comedy | real_dog_ranking
ALTER TABLE candidates ADD COLUMN meta_json TEXT;        -- ai_generated: provider/model/prompt/attempts/cost; rankings: clip list
ALTER TABLE productions ADD COLUMN content_format TEXT;
ALTER TABLE productions ADD COLUMN production_cost_usd REAL;
ALTER TABLE posts ADD COLUMN content_format TEXT;
-- metric snapshots at comparable ages (24 h / 72 h / 7 d after the slot) for per-format comparison
CREATE TABLE IF NOT EXISTS post_metrics (
  post_id TEXT NOT NULL REFERENCES posts(id),
  age_hours INTEGER NOT NULL,       -- 24 | 72 | 168
  captured_at TEXT NOT NULL,
  views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER,
  PRIMARY KEY (post_id, age_hours)
);
