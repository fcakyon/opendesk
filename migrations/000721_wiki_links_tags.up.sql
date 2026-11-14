-- Links between wiki pages and the pages' #tags (contracts/wiki.md "Links and tags"):
-- kept from each page's body as it is saved, for backlinks, the graph and the tag list.
ALTER TABLE wiki_pages ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX wiki_pages_tags_idx ON wiki_pages USING gin(tags);

CREATE TABLE wiki_links (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    from_id      uuid NOT NULL,
    to_id        uuid NOT NULL,
    PRIMARY KEY (workspace_id, from_id, to_id),
    FOREIGN KEY (workspace_id, from_id) REFERENCES wiki_pages(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, to_id) REFERENCES wiki_pages(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX wiki_links_to_idx ON wiki_links(workspace_id, to_id);

-- Pages written before: their links (to pages of the same workspace) and tags.
INSERT INTO wiki_links (workspace_id, from_id, to_id)
SELECT DISTINCT p.workspace_id, p.id, t.id
FROM wiki_pages p
CROSS JOIN LATERAL regexp_matches(p.body_html, '(?:/wiki/|data-id=")([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') m
JOIN wiki_pages t ON t.workspace_id = p.workspace_id AND t.id = lower(m[1])::uuid
WHERE t.id <> p.id
ON CONFLICT DO NOTHING;

UPDATE wiki_pages p SET tags = coalesce((
    SELECT array_agg(DISTINCT lower(m[2]))
    FROM regexp_matches(regexp_replace(regexp_replace(p.body_html, '<code[^>]*>[^<]*</code>', ' ', 'g'), '<[^>]+>', ' ', 'g'),
        '(^|\s)#([[:alnum:]_/-]*[[:alpha:]][[:alnum:]_/-]*)', 'g') m), '{}')
WHERE p.body_html LIKE '%#%';
