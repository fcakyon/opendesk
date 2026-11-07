DROP INDEX IF EXISTS attachments_wiki_page_idx;
ALTER TABLE attachments DROP COLUMN IF EXISTS wiki_page_id;
