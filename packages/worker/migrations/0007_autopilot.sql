-- Unattended publishing: QC verdicts on productions, control-plane settings (pause / emergency stop), decision log
ALTER TABLE productions ADD COLUMN qc_score REAL;      -- 0-10 editorial score from the automated QC pass
ALTER TABLE productions ADD COLUMN qc_json TEXT;       -- full QC result (checks, severities, details)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                                   -- JSON
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                                    -- schedule | skip | hold | pause | resume | unschedule | stop
  production_id TEXT,
  candidate_id TEXT,
  service TEXT,
  slot_at TEXT,
  buffer_post_id TEXT,
  reasons TEXT NOT NULL,                                 -- JSON array
  detail TEXT                                            -- JSON
);
CREATE INDEX IF NOT EXISTS decisions_at ON decisions(at);
