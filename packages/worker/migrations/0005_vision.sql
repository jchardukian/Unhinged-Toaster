-- Vision pass: creator credit visible in the footage, visual summary
ALTER TABLE candidates ADD COLUMN detected_handle TEXT;
ALTER TABLE candidates ADD COLUMN detected_platform TEXT;
ALTER TABLE candidates ADD COLUMN visual_summary TEXT;
