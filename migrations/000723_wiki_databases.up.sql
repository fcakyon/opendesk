-- Wiki databases (contracts/wiki.md "Databases"): a page that is a database keeps its
-- properties and views; its rows are its subpages, each with its values of those properties.
ALTER TABLE wiki_pages
    ADD COLUMN kind     text  NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'database')),
    ADD COLUMN database jsonb,
    ADD COLUMN props    jsonb NOT NULL DEFAULT '{}',
    ADD CONSTRAINT wiki_pages_database_shape CHECK ((kind = 'database') = (database IS NOT NULL));
