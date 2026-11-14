-- The id a workspace gives a company in its own product, so the chat widget's verified identify
-- can link a signed-in user to the company that has it.
ALTER TABLE companies ADD COLUMN external_id text;
CREATE UNIQUE INDEX companies_ws_external_uq ON companies(workspace_id, external_id) WHERE external_id IS NOT NULL;
