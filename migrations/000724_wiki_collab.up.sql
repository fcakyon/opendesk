-- Wiki collaboration (contracts/wiki.md "Comments", "Following", "Reminders"): threads of
-- comments on a page, who follows a page, and the reminders set in a page's text.
CREATE TABLE wiki_comments (
    id           uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    page_id      uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
    -- The thread's first comment; the first comment has thread_id = id.
    thread_id    uuid NOT NULL,
    -- On the first comment only: the text an inline comment was made on.
    quote        text NOT NULL DEFAULT '',
    inline       boolean NOT NULL DEFAULT false,
    author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    body_html    text NOT NULL,
    mentions     uuid[] NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now(),
    edited_at    timestamptz,
    resolved_at  timestamptz,
    resolved_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX wiki_comments_page_idx ON wiki_comments(page_id, created_at);
CREATE INDEX wiki_comments_thread_idx ON wiki_comments(thread_id);

CREATE TABLE wiki_comment_reactions (
    comment_id uuid NOT NULL REFERENCES wiki_comments(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, user_id, emoji)
);

-- following = false is an unfollow that commenting doesn't undo.
CREATE TABLE wiki_follows (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    page_id      uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following    boolean NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (page_id, user_id)
);
CREATE INDEX wiki_follows_user_idx ON wiki_follows(user_id);

-- id is the one in the page's markup (data-reminder); user_id set it and is reminded.
CREATE TABLE wiki_reminders (
    id           uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    page_id      uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    remind_at    timestamptz NOT NULL,
    label        text NOT NULL DEFAULT '',
    sent_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wiki_reminders_page_idx ON wiki_reminders(page_id);
CREATE INDEX wiki_reminders_due_idx ON wiki_reminders(remind_at) WHERE sent_at IS NULL;

-- A page out of someone's sight takes its wiki notifications with it.
CREATE INDEX notifications_wiki_page_idx ON notifications(workspace_id, (data->>'page_id'))
    WHERE type IN ('wiki_mention', 'wiki_comment', 'wiki_reminder');
