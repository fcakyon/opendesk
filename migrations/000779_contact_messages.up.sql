-- One message sent to many customers at once (contracts/api.md "Messages to many customers"): a
-- ticket for each customer, all with one label, created a few at a time by a job that follows
-- this row. contact_ids holds the customers it reaches (those without an email address or
-- blocked were left out when it was made and are counted in skipped).
CREATE TABLE contact_messages (
    id           uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    mailbox_id   uuid REFERENCES mailboxes(id) ON DELETE SET NULL,
    subject      text NOT NULL,
    body_html    text NOT NULL,
    label        text NOT NULL,
    status       text NOT NULL CHECK (status IN ('open', 'pending', 'solved')),
    state        text NOT NULL DEFAULT 'sending' CHECK (state IN ('sending', 'done', 'cancelled')),
    contact_ids  uuid[] NOT NULL,
    next_index   integer NOT NULL DEFAULT 0,
    total        integer NOT NULL,
    sent         integer NOT NULL DEFAULT 0,
    failed       integer NOT NULL DEFAULT 0,
    last_error   text NOT NULL DEFAULT '',
    skipped      jsonb NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz
);
CREATE INDEX contact_messages_workspace_idx ON contact_messages (workspace_id, created_at DESC);
CREATE UNIQUE INDEX contact_messages_sending_idx ON contact_messages (workspace_id) WHERE state = 'sending';
