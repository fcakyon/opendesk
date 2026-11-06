DROP TABLE IF EXISTS wiki_links;
DROP INDEX IF EXISTS wiki_pages_tags_idx;
ALTER TABLE wiki_pages DROP COLUMN IF EXISTS tags;
