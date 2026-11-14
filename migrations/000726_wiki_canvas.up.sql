-- Wiki canvases (contracts/wiki.md "Canvas"): a page that is a canvas keeps its cards and
-- the connections between them. canvas_text is the words on its cards, kept by the API as
-- it saves the canvas, so search finds them.
ALTER TABLE wiki_pages DROP CONSTRAINT wiki_pages_kind_check;
ALTER TABLE wiki_pages
    ADD CONSTRAINT wiki_pages_kind_check CHECK (kind IN ('page', 'database', 'canvas')),
    ADD COLUMN canvas      jsonb,
    ADD COLUMN canvas_text text NOT NULL DEFAULT '',
    ADD CONSTRAINT wiki_pages_canvas_shape CHECK ((kind = 'canvas') = (canvas IS NOT NULL));

-- Search reads a canvas's words beside its text.
ALTER TABLE wiki_pages DROP COLUMN search;
ALTER TABLE wiki_pages ADD COLUMN search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', regexp_replace(coalesce(body_html, ''), '<[^>]+>', ' ', 'g')), 'C') ||
    setweight(to_tsvector('simple', canvas_text), 'C')
) STORED;
CREATE INDEX wiki_pages_search_idx ON wiki_pages USING gin(search);
