-- WhatsApp is a customer channel (contracts/whatsapp.md): a workspace's WhatsApp Business
-- number connects through the Meta Cloud API. Connections, verified deliveries and the
-- per-contact 24-hour window are the channel's own state; messages keep the shared shape.
CREATE TABLE whatsapp_connections (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    brand_id        uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    name            text NOT NULL,
    phone_number_id text NOT NULL,
    waba_id         text NOT NULL,
    display_phone   text NOT NULL DEFAULT '',
    verified_name   text NOT NULL DEFAULT '',
    api_version     text NOT NULL DEFAULT 'v26.0',
    -- The Meta system-user token, the app secret that signs deliveries and the verify token
    -- the webhook handshake echoes, sealed with d.Box (internal/sealed).
    credentials_enc bytea NOT NULL,
    status          text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
    last_error      text NOT NULL DEFAULT '',
    last_event_at   timestamptz,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_connections_ws_idx ON whatsapp_connections(workspace_id);
CREATE UNIQUE INDEX whatsapp_connections_ws_phone_uq ON whatsapp_connections(workspace_id, phone_number_id);

-- One verified Meta delivery, stored before it is processed so a retry is a no-op.
CREATE TABLE whatsapp_inbound_events (
    id                uuid PRIMARY KEY,
    workspace_id      uuid NOT NULL,
    connection_id     uuid NOT NULL REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
    external_event_id text NOT NULL,
    payload           jsonb NOT NULL,
    received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX whatsapp_inbound_events_conn_event_uq ON whatsapp_inbound_events(connection_id, external_event_id);
CREATE INDEX whatsapp_inbound_events_received_idx ON whatsapp_inbound_events(received_at);

-- A wa_id writing to one of the workspace's numbers, the contact it writes as, and Meta's
-- customer service window: free-form replies are allowed for 24 hours after their latest
-- message. Keyed by the number, not the connection, so disconnecting and connecting the
-- same number again keeps the window Meta keeps.
CREATE TABLE whatsapp_contacts (
    workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    phone_number_id text NOT NULL,
    wa_id           text NOT NULL,
    contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    profile_name    text NOT NULL DEFAULT '',
    last_inbound_at timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, phone_number_id, wa_id)
);
CREATE INDEX whatsapp_contacts_contact_idx ON whatsapp_contacts(contact_id);

-- The conversation a WhatsApp ticket carries: the number the customer wrote to and the
-- wa_id they wrote from. Replies go to that wa_id through whichever connection holds the
-- number now.
CREATE TABLE whatsapp_tickets (
    ticket_id       uuid PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
    workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    phone_number_id text NOT NULL,
    wa_id           text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_tickets_thread_idx ON whatsapp_tickets(workspace_id, phone_number_id, wa_id);

-- The provider's own id for a message (Meta's wamid) ties delivery reports to the message
-- they are about. The full lifecycle lives in delivery_meta, not in delivery_status.
ALTER TABLE messages ADD COLUMN provider_message_id text;
ALTER TABLE messages ADD COLUMN delivery_meta jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX messages_ws_provider_msgid_uq ON messages(workspace_id, provider_message_id)
    WHERE provider_message_id IS NOT NULL;
