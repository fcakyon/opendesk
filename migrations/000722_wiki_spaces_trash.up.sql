-- Where a wiki page lives and who sees it (contracts/wiki.md "Private pages and teamspaces"),
-- the trash, templates, journals, verification, and each member's favorites and visits.

ALTER TABLE wiki_pages
    -- A private page (and everything under it) is its member's alone, admins included.
    ADD COLUMN private_to     uuid REFERENCES users(id) ON DELETE CASCADE,
    -- A teamspace page belongs to a team; a private team's pages show to its members only.
    ADD COLUMN team_id        uuid REFERENCES teams(id) ON DELETE SET NULL,
    -- In the trash since deleted_at; trashed_with is the page whose trashing took it along.
    ADD COLUMN deleted_at     timestamptz,
    ADD COLUMN deleted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN trashed_with   uuid,
    -- A template is copied into new pages; it stays out of the tree, search and the graph.
    ADD COLUMN template       boolean NOT NULL DEFAULT false,
    -- A member's journal (a private top-level page) and its daily notes under it.
    ADD COLUMN journal        boolean NOT NULL DEFAULT false,
    ADD COLUMN daily_date     date,
    -- Verified as right by someone, until a day or for good (verified_until null).
    ADD COLUMN verified_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN verified_at    timestamptz,
    ADD COLUMN verified_until timestamptz,
    ADD CONSTRAINT wiki_pages_one_space CHECK (private_to IS NULL OR team_id IS NULL),
    ADD CONSTRAINT wiki_pages_daily_private CHECK (daily_date IS NULL OR private_to IS NOT NULL),
    ADD CONSTRAINT wiki_pages_journal_private CHECK (NOT journal OR private_to IS NOT NULL);

CREATE INDEX wiki_pages_private_idx ON wiki_pages(private_to) WHERE private_to IS NOT NULL;
CREATE INDEX wiki_pages_team_idx ON wiki_pages(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX wiki_pages_trash_idx ON wiki_pages(workspace_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX wiki_pages_deleted_by_idx ON wiki_pages(deleted_by) WHERE deleted_by IS NOT NULL;
CREATE INDEX wiki_pages_verified_by_idx ON wiki_pages(verified_by) WHERE verified_by IS NOT NULL;
CREATE UNIQUE INDEX wiki_pages_journal_idx ON wiki_pages(workspace_id, private_to) WHERE journal AND deleted_at IS NULL;
CREATE UNIQUE INDEX wiki_pages_daily_idx ON wiki_pages(workspace_id, private_to, daily_date) WHERE daily_date IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE wiki_favorites (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page_id      uuid NOT NULL,
    position     integer NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, user_id, page_id),
    FOREIGN KEY (workspace_id, page_id) REFERENCES wiki_pages(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX wiki_favorites_page_idx ON wiki_favorites(workspace_id, page_id);
CREATE INDEX wiki_favorites_user_idx ON wiki_favorites(user_id);

-- Who opened a page, when last and how often: recent pages, and a page's readers.
CREATE TABLE wiki_visits (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page_id      uuid NOT NULL,
    visits       integer NOT NULL DEFAULT 1,
    first_at     timestamptz NOT NULL DEFAULT now(),
    last_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id, page_id),
    FOREIGN KEY (workspace_id, page_id) REFERENCES wiki_pages(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX wiki_visits_recent_idx ON wiki_visits(workspace_id, user_id, last_at DESC);
CREATE INDEX wiki_visits_page_idx ON wiki_visits(workspace_id, page_id);
CREATE INDEX wiki_visits_user_idx ON wiki_visits(user_id);
