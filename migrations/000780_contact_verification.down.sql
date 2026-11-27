DROP TABLE IF EXISTS contact_email_verifications;
ALTER TABLE contacts
    DROP COLUMN IF EXISTS verified_at,
    DROP COLUMN IF EXISTS verified_email,
    DROP COLUMN IF EXISTS verified_via;
