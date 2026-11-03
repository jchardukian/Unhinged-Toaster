-- Approval-sync reliability: distinguish transient Buffer failures from user deletions; idempotent draft creation.
ALTER TABLE posts ADD COLUMN sync_error TEXT;
ALTER TABLE posts ADD COLUMN missing_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN missing_since TEXT;
ALTER TABLE posts ADD COLUMN idempotency_key TEXT;
ALTER TABLE posts ADD COLUMN create_attempts INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_idempotency ON posts(idempotency_key) WHERE idempotency_key IS NOT NULL AND state != 'deleted';
