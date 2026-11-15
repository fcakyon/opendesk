-- Page aliases (contracts/wiki.md "Aliases"): other names a page goes by. Links, page
-- search and unlinked mentions find a page by them, and search weighs them as its title.
ALTER TABLE wiki_pages ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';

-- array_to_string is only stable in general; for text[] it is a plain join.
CREATE FUNCTION wiki_alias_text(text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT array_to_string($1, ' ') $$;

ALTER TABLE wiki_pages DROP COLUMN search;
ALTER TABLE wiki_pages ADD COLUMN search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', wiki_alias_text(aliases)), 'A') ||
    setweight(to_tsvector('simple', regexp_replace(coalesce(body_html, ''), '<[^>]+>', ' ', 'g')), 'C') ||
    setweight(to_tsvector('simple', canvas_text), 'C')
) STORED;
CREATE INDEX wiki_pages_search_idx ON wiki_pages USING gin(search);

-- Page analytics (contracts/wiki.md "Page analytics"): how often each person opened a page
-- each day (UTC), counts only. Reads by the same person less than 30 minutes apart are one
-- view. Kept 90 days.
CREATE TABLE wiki_page_views (
    workspace_id uuid NOT NULL,
    page_id      uuid NOT NULL,
    day          date NOT NULL,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    views        integer NOT NULL DEFAULT 1,
    PRIMARY KEY (page_id, day, user_id),
    FOREIGN KEY (workspace_id, page_id) REFERENCES wiki_pages(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX wiki_page_views_user_idx ON wiki_page_views(user_id);
CREATE INDEX wiki_page_views_day_idx ON wiki_page_views(day);
