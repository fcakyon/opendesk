DROP INDEX IF EXISTS messages_ws_provider_msgid_uq;
ALTER TABLE messages DROP COLUMN IF EXISTS delivery_meta;
ALTER TABLE messages DROP COLUMN IF EXISTS provider_message_id;

DROP TABLE IF EXISTS whatsapp_tickets;
DROP TABLE IF EXISTS whatsapp_contacts;
DROP TABLE IF EXISTS whatsapp_inbound_events;
DROP TABLE IF EXISTS whatsapp_connections;
