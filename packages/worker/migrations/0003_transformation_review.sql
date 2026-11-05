-- Transformation-review workflow: copyright risk on candidates, reuse basis + edit plan on productions,
-- review-note bookkeeping on posts.
ALTER TABLE candidates ADD COLUMN copyright_risk TEXT;
ALTER TABLE candidates ADD COLUMN copyright_risk_reasons TEXT;
ALTER TABLE productions ADD COLUMN reuse_basis TEXT;
ALTER TABLE productions ADD COLUMN edit_plan TEXT;
ALTER TABLE posts ADD COLUMN reuse_uncertain INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN public_text TEXT;
ALTER TABLE posts ADD COLUMN review_block_stripped INTEGER NOT NULL DEFAULT 0;
