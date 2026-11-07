-- Canvases become pages again: their text and subpages stay, their cards go.
ALTER TABLE wiki_pages DROP CONSTRAINT IF EXISTS wiki_pages_canvas_shape;
UPDATE wiki_pages SET kind = 'page' WHERE kind = 'canvas';
ALTER TABLE wiki_pages DROP COLUMN search;
ALTER TABLE wiki_pages ADD COLUMN search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', regexp_replace(coalesce(body_html, ''), '<[^>]+>', ' ', 'g')), 'C')
) STORED;
CREATE INDEX wiki_pages_search_idx ON wiki_pages USING gin(search);
ALTER TABLE wiki_pages
    DROP COLUMN IF EXISTS canvas_text,
    DROP COLUMN IF EXISTS canvas,
    DROP CONSTRAINT wiki_pages_kind_check,
    ADD CONSTRAINT wiki_pages_kind_check CHECK (kind IN ('page', 'database'));
