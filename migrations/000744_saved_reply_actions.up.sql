-- A saved reply can carry actions applied to the ticket when a message using it is sent:
-- labels to add or remove, a team, an assignee (contracts/api.md, saved replies). {} = none.
ALTER TABLE saved_replies ADD COLUMN actions jsonb NOT NULL DEFAULT '{}'::jsonb;
