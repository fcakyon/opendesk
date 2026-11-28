-- WhatsApp opens tickets too (contracts/whatsapp.md), and the channel check predates it.
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_channel_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_channel_check
    CHECK (channel IN ('email', 'chat', 'api', 'portal', 'phone', 'whatsapp'));
