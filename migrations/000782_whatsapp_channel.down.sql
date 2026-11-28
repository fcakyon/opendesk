-- Back to the channels before WhatsApp. Fails if a WhatsApp ticket exists: resolve them first.
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_channel_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_channel_check
    CHECK (channel IN ('email', 'chat', 'api', 'portal', 'phone'));
