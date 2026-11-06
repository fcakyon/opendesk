-- Tickets a wiki page mentions (contracts/wiki.md "Desk"): kept from each page's body as
-- it is saved, like wiki_links, for the pages a ticket shows. Both ends are of one workspace.
CREATE TABLE wiki_ticket_links (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    page_id      uuid NOT NULL,
    ticket_id    uuid NOT NULL,
    PRIMARY KEY (page_id, ticket_id),
    FOREIGN KEY (workspace_id, page_id) REFERENCES wiki_pages(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX wiki_ticket_links_ticket_idx ON wiki_ticket_links(ticket_id);

-- Pages written before: the tickets of their own workspace they mention.
INSERT INTO wiki_ticket_links (workspace_id, page_id, ticket_id)
SELECT DISTINCT p.workspace_id, p.id, t.id
FROM wiki_pages p
CROSS JOIN LATERAL regexp_matches(p.body_html, 'data-type="ticket" data-id="([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"', 'g') m
JOIN tickets t ON t.workspace_id = p.workspace_id AND t.id = lower(m[1])::uuid
WHERE p.body_html LIKE '%data-type="ticket"%'
ON CONFLICT DO NOTHING;
