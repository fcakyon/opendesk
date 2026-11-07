DROP TABLE IF EXISTS wiki_page_views;

ALTER TABLE wiki_pages DROP COLUMN search;
ALTER TABLE wiki_pages ADD COLUMN search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', regexp_replace(coalesce(body_html, ''), '<[^>]+>', ' ', 'g')), 'C') ||
    setweight(to_tsvector('simple', canvas_text), 'C')
) STORED;
CREATE INDEX wiki_pages_search_idx ON wiki_pages USING gin(search);
DROP FUNCTION IF EXISTS wiki_alias_text(text[]);
ALTER TABLE wiki_pages DROP COLUMN IF EXISTS aliases;
