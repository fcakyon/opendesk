-- Message templates of a WhatsApp connection (contracts/whatsapp.md "Templates"): the local
-- copy of what Meta approved, so an agent can send a template outside the 24-hour customer
-- service window. The channel syncs them from the connection's WhatsApp Business account; a
-- send re-reads the row, so a template Meta stopped approving does not go out.
CREATE TABLE whatsapp_templates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    connection_id   uuid NOT NULL REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
    meta_template_id text NOT NULL DEFAULT '',
    name            text NOT NULL,
    language        text NOT NULL,
    category        text NOT NULL DEFAULT '',
    status          text NOT NULL DEFAULT '',
    header_type     text NOT NULL DEFAULT '',
    header_content  text NOT NULL DEFAULT '',
    body_content    text NOT NULL DEFAULT '',
    footer_content  text NOT NULL DEFAULT '',
    buttons         jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, name, language)
);
CREATE INDEX whatsapp_templates_ws_idx ON whatsapp_templates(workspace_id);
