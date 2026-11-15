-- A member's own unsent reply on a ticket, kept on the server so it follows them to another
-- device and survives a refresh. Private to the member (unlike ticket_drafts, the ticket's
-- shared draft). Its attachments are uploads not yet on a message; the purge of stale
-- uploads leaves the ones a draft holds.
CREATE TABLE ticket_reply_drafts (
    ticket_id      uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    body_html      text NOT NULL,
    body_text      text NOT NULL,
    attachment_ids uuid[] NOT NULL DEFAULT '{}',
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (ticket_id, user_id)
);
CREATE INDEX ticket_reply_drafts_workspace_idx ON ticket_reply_drafts (workspace_id);
CREATE INDEX ticket_reply_drafts_updated_idx ON ticket_reply_drafts (updated_at);
