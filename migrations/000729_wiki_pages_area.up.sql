-- Pages (contracts/pages.md): the workspace's own pages, databases and canvases, a product of
-- their own beside the wiki. Both live in wiki_pages; area says whose tree a page is in. A
-- subpage is always in its parent's area. A member keeps a journal in each.
ALTER TABLE wiki_pages ADD COLUMN area text NOT NULL DEFAULT 'wiki'
    CONSTRAINT wiki_pages_area_check CHECK (area IN ('wiki', 'pages'));

CREATE INDEX wiki_pages_area_idx ON wiki_pages(workspace_id, area);

DROP INDEX wiki_pages_journal_idx;
DROP INDEX wiki_pages_daily_idx;
CREATE UNIQUE INDEX wiki_pages_journal_idx ON wiki_pages(workspace_id, area, private_to) WHERE journal AND deleted_at IS NULL;
CREATE UNIQUE INDEX wiki_pages_daily_idx ON wiki_pages(workspace_id, area, private_to, daily_date) WHERE daily_date IS NOT NULL AND deleted_at IS NULL;
