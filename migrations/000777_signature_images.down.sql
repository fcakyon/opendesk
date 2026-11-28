DROP INDEX IF EXISTS images_signature_unclaimed_idx;
ALTER TABLE images DROP COLUMN IF EXISTS in_signature_at;
