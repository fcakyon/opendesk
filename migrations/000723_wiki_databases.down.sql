ALTER TABLE wiki_pages
    DROP CONSTRAINT IF EXISTS wiki_pages_database_shape,
    DROP COLUMN IF EXISTS props,
    DROP COLUMN IF EXISTS database,
    DROP COLUMN IF EXISTS kind;
