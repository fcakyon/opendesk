-- A person's own keyboard shortcuts (contracts/api.md "Keyboard shortcuts"): the keys they
-- chose for a shortcut of the web app, or null for one they turned off. User-level, like the
-- rest of this row: the same keys in every workspace and on every device.
ALTER TABLE user_workspace_prefs ADD COLUMN shortcuts jsonb NOT NULL DEFAULT '{}';
