-- Files a wiki page uses (contracts/wiki.md "Files"): an upload the page's body names becomes
-- the page's own as the page is saved or imported. It is kept while the page is, and read by
-- whoever may see the page. A page deleted for good lets go of its files, which the hourly
-- sweep of unattached uploads then removes.
ALTER TABLE attachments ADD COLUMN wiki_page_id uuid REFERENCES wiki_pages(id) ON DELETE SET NULL;
CREATE INDEX attachments_wiki_page_idx ON attachments(wiki_page_id) WHERE wiki_page_id IS NOT NULL;

-- Uploads still kept that a page names and that someone who wrote the page uploaded: the
-- first such page holds each.
UPDATE attachments a SET wiki_page_id = x.page_id
FROM (
    SELECT DISTINCT ON (f.id) f.id, p.id AS page_id
    FROM wiki_pages p
    CROSS JOIN LATERAL regexp_matches(p.body_html, '/v1/attachments/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') m
    JOIN attachments f ON f.workspace_id = p.workspace_id AND f.id = lower(m[1])::uuid
    WHERE p.body_html LIKE '%/v1/attachments/%' AND f.message_id IS NULL
      AND (f.uploaded_by = p.created_by OR EXISTS (
          SELECT 1 FROM wiki_page_revisions r WHERE r.workspace_id = p.workspace_id AND r.page_id = p.id AND r.author_id = f.uploaded_by))
    ORDER BY f.id, p.created_at, p.id
) x
WHERE a.id = x.id AND a.wiki_page_id IS NULL;
