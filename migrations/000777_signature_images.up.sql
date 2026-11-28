-- Signature pictures (POST /v1/signature-images, contracts/api.md): when a saved signature of
-- the workspace first named one. From then on emails may show it, so the image sweep keeps it
-- while its uploader is a member of the workspace; one no saved signature named is removed a
-- day after its upload.
ALTER TABLE images ADD COLUMN in_signature_at timestamptz;
CREATE INDEX images_signature_unclaimed_idx ON images(created_at) WHERE slot = 'signature' AND in_signature_at IS NULL;
