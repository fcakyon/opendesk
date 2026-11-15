DROP INDEX wiki_pages_journal_idx;
DROP INDEX wiki_pages_daily_idx;
-- Pages' pages join the wiki; their journals and daily notes become plain pages, so the
-- wiki's own keep their unique indexes.
UPDATE wiki_pages SET journal = false, daily_date = NULL WHERE area = 'pages' AND (journal OR daily_date IS NOT NULL);
CREATE UNIQUE INDEX wiki_pages_journal_idx ON wiki_pages(workspace_id, private_to) WHERE journal AND deleted_at IS NULL;
CREATE UNIQUE INDEX wiki_pages_daily_idx ON wiki_pages(workspace_id, private_to, daily_date) WHERE daily_date IS NOT NULL AND deleted_at IS NULL;
DROP INDEX wiki_pages_area_idx;
ALTER TABLE wiki_pages DROP COLUMN area;
