DROP INDEX IF EXISTS companies_ws_external_uq;
ALTER TABLE companies DROP COLUMN IF EXISTS external_id;
