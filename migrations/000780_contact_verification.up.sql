-- How a contact proved who they are (contracts/api.md "Contact verification"): with a link
-- emailed to the address they gave in the chat widget, or by signing in on a widget with
-- identity verification (user_hash). Typing an address in the widget never sets these.
ALTER TABLE contacts
    ADD COLUMN verified_via text CHECK (verified_via IN ('email', 'identity')),
    ADD COLUMN verified_email citext,
    ADD COLUMN verified_at timestamptz;

-- Links that confirm an address a chat visitor gave in the widget. Stored hashed, single use.
CREATE TABLE contact_email_verifications (
    id           uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    contact_id   uuid NOT NULL,
    widget_id    uuid REFERENCES widgets(id) ON DELETE SET NULL,
    email        citext NOT NULL,
    token_hash   bytea NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX contact_email_verifications_contact_idx ON contact_email_verifications(workspace_id, contact_id, created_at DESC);
CREATE INDEX contact_email_verifications_email_idx ON contact_email_verifications(workspace_id, email, created_at DESC);
CREATE INDEX contact_email_verifications_expiry_idx ON contact_email_verifications(expires_at);
