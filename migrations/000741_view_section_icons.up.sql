-- A view section's icon in the sidebar (contracts/api.md, PATCH /v1/view-sections): a `ViewIcon`,
-- as views store theirs, for every view that names the section. `key` is the section's name in
-- lower case, as views match it. No row: the section shows no icon.
CREATE TABLE view_sections (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key text NOT NULL,
    icon jsonb NOT NULL CHECK (jsonb_typeof(icon) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, key)
);
