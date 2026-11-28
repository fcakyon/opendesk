-- Contact imports (contracts/imports.md "Contacts"): a CSV file of people added to the
-- directory in chunks by a job, with the counts and the first rows that failed.
CREATE TABLE contact_imports (
    id           uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    upload_id    uuid NOT NULL,
    filename     text NOT NULL,
    status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
    mapping      jsonb NOT NULL,
    match_on     text NOT NULL CHECK (match_on IN ('email', 'external_id')),
    on_match     text NOT NULL CHECK (on_match IN ('skip', 'fill', 'overwrite')),
    total        integer NOT NULL,
    processed    integer NOT NULL DEFAULT 0,
    created      integer NOT NULL DEFAULT 0,
    updated      integer NOT NULL DEFAULT 0,
    skipped      integer NOT NULL DEFAULT 0,
    failed       integer NOT NULL DEFAULT 0,
    errors       jsonb NOT NULL DEFAULT '[]',
    error        text NOT NULL DEFAULT '',
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz
);
CREATE INDEX contact_imports_workspace_idx ON contact_imports(workspace_id, created_at DESC);
