-- A wiki page's own look (contracts/wiki.md "Page settings"): a cover, its width, its type
-- size and font, and a lock against accidental edits. None of them is part of the page's
-- text: changing one keeps the version and adds no revision.
ALTER TABLE wiki_pages
    ADD COLUMN cover      text     NOT NULL DEFAULT '',
    ADD COLUMN cover_y    smallint NOT NULL DEFAULT 50 CHECK (cover_y BETWEEN 0 AND 100),
    ADD COLUMN full_width boolean  NOT NULL DEFAULT false,
    ADD COLUMN small_text boolean  NOT NULL DEFAULT false,
    ADD COLUMN font       text     NOT NULL DEFAULT 'default' CHECK (font IN ('default', 'serif', 'mono')),
    ADD COLUMN locked     boolean  NOT NULL DEFAULT false;
