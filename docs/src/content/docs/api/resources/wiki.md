---
title: Wiki
description: Read and write the team's internal wiki pages, spaces, databases, the trash, templates, links and tags, comments, and their links to tickets and the help center.
---

The wiki holds your team's internal pages: runbooks, policies, notes, plans, databases. It is for members only and never shown to customers. Pages nest under each other and live in the workspace, a teamspace or one member's private pages.

Scopes: `wiki:read` to read, `wiki:write` to change. Guides: [Wiki](/guides/wiki/), [Databases](/guides/wiki-databases/), [Canvas](/guides/wiki-canvas/), [Links, tags and the graph](/guides/wiki-links/), [Comments and following](/guides/wiki-collaboration/), [Tickets, the help center and Ollie](/guides/wiki-desk/), [Import and export](/guides/wiki-import-export/).

## Pages

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/wiki/pages` | Every page you can see, without its body, to build the tree |
| `POST` | `/v1/wiki/pages` | Create a page: `parent_id`, `space`, `team_id`, `title`, `icon`, `body_html`, `position`, `template`, `kind`, `database`, `props`, `canvas` (all optional) |
| `GET`, `PATCH`, `DELETE` | `/v1/wiki/pages/{id}` | Read a page with its body, change it, or delete it for good with its subpages |
| `POST` | `/v1/wiki/pages/{id}/move` | Put it under another page, or at the top level of a space, at a position |
| `POST` | `/v1/wiki/pages/{id}/duplicate` | Copy it with its subpages: `parent_id`, `space`, `team_id`, `template`, `title`, `position` |
| `POST` | `/v1/wiki/pages/{id}/trash` | Move it and its subpages to the trash |
| `POST` | `/v1/wiki/pages/{id}/restore` | Put it back from the trash, with what went with it |
| `GET` | `/v1/wiki/trash` | The pages in the trash, last first |
| `GET` | `/v1/wiki/templates` | The templates you can see |
| `GET` | `/v1/wiki/pages/{id}/revisions` | Its history, newest first |
| `GET` | `/v1/wiki/pages/{id}/revisions/{revisionId}` | One revision with its body |
| `POST` | `/v1/wiki/pages/{id}/revisions/{revisionId}/restore` | Put a revision back as a new version |
| `GET` | `/v1/wiki/search?q=` | Pages matching the words, best first, with a passage around the match |
| `POST` | `/v1/wiki/unfurl` | A link's title, description and picture, for a bookmark block |

Viewers read. Agents and up create, edit, move, copy and restore pages. `GET /v1/search` also returns the top wiki pages, in `wiki_pages`.

## Objects

```ts
type WikiNode = {
  id: string;
  parent_id: string | null;
  title: string;          // "" until named; up to 200 characters (longer is 422)
  icon: string;           // one emoji, or ""
  position: number;       // among its siblings, from 0
  version: number;        // goes up on every change of title, icon or body
  updated_at: string;
  created_by_id: string | null;
  tags: string[];         // the #tags in its text, lower case
  kind: "page" | "database" | "canvas";
  private: boolean;       // yours alone
  team_id: string | null; // the teamspace it is in
  journal?: true;         // your journal, which holds your daily notes
  daily_date?: string;    // a daily note's day, YYYY-MM-DD
  template?: true;
  verified?: true;        // verified, and not past the day it was verified until
};

type WikiPage = WikiNode & PageSettings & {
  body_html: string;
  database: Database | null;          // a database's properties and views
  canvas: Canvas | null;              // a canvas's cards and connections
  props: Record<string, unknown>;     // a database row's values, by property id
  verification: { by: UserRef | null; at: string; until: string | null; expired: boolean } | null;
  deleted_at: string | null;          // in the trash since
  deleted_by: UserRef | null;
  created_by: UserRef | null;
  updated_by: UserRef | null;
  created_at: string;
  breadcrumbs: { id: string; title: string; icon: string }[]; // top-level page first
  children: { id: string; title: string; icon: string }[];
};

type PageSettings = {
  cover: string;          // "", "gradient:<name>", or an image: https or /v1/attachments/<id>
  cover_y: number;        // 0..100, which part of an image cover shows
  full_width: boolean;
  small_text: boolean;
  font: "default" | "serif" | "mono";
  locked: boolean;        // the app opens it read-only until someone unlocks it
};
```

`created_by_id` and `created_by` are null for a page an API key created, or once its creator deleted their account.

## Spaces

A top-level page lives in a space, and every page under it lives there too:

- `workspace` (the default): every member sees it.
- `private`: one member's own. Nobody else sees it, admins included, nor an API key. AI clients connected as that member read it as them.
- `team`: a teamspace, with `team_id`. A private team's pages are its members' alone; a public team's every member sees.

Create, move and duplicate take `space` and `team_id` for a top-level page; a subpage always lives where its parent does. Moving a page to another space takes its subpages along. A page you can't see is `404` on every route and never shows in the tree, search, links, the graph, favorites or recent pages.

## Edit without overwriting a teammate

Send the `version` you started from. If someone saved the page since, the API answers `409` with code `page_changed` and changes nothing:

```sh
curl -X PATCH https://api.opendesk.sh/v1/wiki/pages/0192f0c4-... \
  -H "Authorization: Bearer od_live_..." \
  -H "Content-Type: application/json" \
  -d '{"body_html": "<p>Refunds over 100 euros go to the team lead.</p>", "version": 4}'
```

Leave `version` out to always apply the change. A `PATCH` that changes nothing keeps the version.

`PATCH` also takes, without a `version`:

- The page's look: `cover`, `cover_y`, `full_width`, `small_text`, `font`, `locked`. A cover is `""`, `gradient:` and one of `dawn`, `ocean`, `forest`, `dusk`, `sand`, `slate`, `rose`, `lagoon`, `aurora`, `ember`, or an image: https or one of your attachments.
- `verified: true` (with `verified_days`, 1 to 3650, or without for until someone changes it) verifies the page as you; `verified: false` takes it away. People only: an API key is `403`.
- `database` (a database only, replaced whole) and `props` (a row only, merged; `null` removes a value). See [Databases](#databases).
- `canvas` (a canvas only, replaced whole). See [Canvas](#canvas).

None of these moves the version or adds a revision. `locked` is for the app: the API doesn't refuse edits to a locked page.

## Body

`body_html` is sanitized before it is stored: only the formatting and blocks below survive, nothing runs, and a value that doesn't match is dropped. Up to 512 KB.

| Block | HTML |
| --- | --- |
| Text, headings 1 to 3 | `p`, `h1` to `h3`, optionally `style="text-align: center"` (left, center, right, justify) |
| Block colour | `data-color` (text) and `data-bg` (background) on `p`, `h1` to `h3`, `li`, lists, `blockquote`, `details`: `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `red` |
| Inline colour | `<span data-color>`, `<mark data-bg>`, same tones |
| To-do list | `<ul data-type="taskList"><li data-type="taskItem" data-checked="true">` |
| Toggle | `<details><summary>…</summary><div data-type="detailsContent">…</div></details>` |
| Callout | `<div data-type="callout" data-icon="💡" data-tone="yellow">…</div>` |
| Columns | `<div data-type="columns">` with 2 to 5 `<div data-type="column">` |
| Code | `<pre><code class="language-go">` |
| Equation | `<div data-type="block-math" data-latex>`, `<span data-type="inline-math" data-latex>` |
| Image | `<img src alt data-width="1..100" data-align="left\|right" data-caption>` |
| File, video, audio | `<div data-type="file\|video\|audio" data-src data-name data-size data-mime>` |
| Bookmark | `<div data-type="bookmark" data-url data-title data-description data-image>` |
| Embed | `<div data-type="embed" data-url>`: the app plays links from the services it knows |
| Table of contents | `<div data-type="toc">` |
| Subpage | `<div data-type="subpage" data-id="<page id>">` |
| Link to a page | `<a data-type="page" data-id="<page id>" href="/wiki/<page id>">` |
| Person | `<span data-type="mention" data-id="<user id>">` |
| Ticket, contact | `<a data-type="ticket" data-id="<ticket id>" href="/tickets/<number>">`, `<a data-type="contact" data-id="<contact id>" href="/contacts/<contact id>">` |
| Ticket list | `<div data-type="tickets" data-id="<saved view id>" data-limit="10">` |
| Date | `<time data-type="date" datetime="2026-11-07">`, or with a time; `data-reminder="<uuid>"` makes it a [reminder](#reminders) |
| Inline comment | `<span data-comment="<thread id>">` around the text a thread is on |
| Database | `<div data-type="database" data-id="<database id>" data-view="<view id>">` |
| Table, divider | `table` with `colgroup`, `th`, `td`; `hr` |

Blocks may carry `data-block-id` (a uuid), so `/wiki/<id>#<block id>` points at one. Images and files are uploaded as [attachments](/api/resources/messages/) and named by their `/v1/attachments/<id>` path; saving a page makes the uploads it names its own, readable by whoever can see the page. A page read returns them as short-lived signed links.

`POST /v1/wiki/unfurl` `{ url }` reads an https page once and answers `{ title, description, image, site }` for a bookmark (agents, `wiki:write`, 120 a minute per workspace). It refuses private, loopback and link-local addresses; a page it can't read is `422 unreachable`.

## Move a page

```sh
curl -X POST https://api.opendesk.sh/v1/wiki/pages/0192f0c4-.../move \
  -H "Authorization: Bearer od_live_..." \
  -H "Content-Type: application/json" \
  -d '{"parent_id": "0192f0c4-...", "position": 0}'
```

`parent_id: null` moves it to the top level of its space, or of `space` (and `team_id`) when you send one. A page can't move under itself or one of its subpages (`422 page_cycle`).

## Trash and delete

`POST /v1/wiki/pages/{id}/trash` moves a page and its subpages to the trash. They leave the tree, search, links, the graph and favorites; they can still be read, with `deleted_at` and `deleted_by`, and changing, moving or adding under them is `422 page_in_trash`.

`GET /v1/wiki/trash` lists the pages trashed, last first, each a `WikiNode` with `deleted_at`, `deleted_by`, `purge_at`, `subpages` (how many went with it) and `path` (where it was). Pages that went with a parent are not listed on their own.

`POST /v1/wiki/pages/{id}/restore` puts the page back with what went with it: under its parent when that is in the tree, otherwise at the top of its space. A page not in the trash is `422 not_in_trash`; one that went with its parent is `422 trashed_with_parent` (restore the page above it).

After 30 days in the trash, pages are deleted for good. `DELETE /v1/wiki/pages/{id}` deletes one for good at once, from the tree or the trash, with its subpages and their history.

Moving to the trash and deleting follow one rule: admins any page; agents a page they created, when they also created every page under it (otherwise `403`, and an admin can). API keys with `wiki:write` any page they can see.

## Templates and copies

A template is a page (with its subpages) that new pages copy. Templates stay out of the tree, search, links and the graph. Create one with `POST /v1/wiki/pages` and `template: true` at the top level, or copy a page into one.

`POST /v1/wiki/pages/{id}/duplicate` copies a page with its subpages, text, icons and look → `201 WikiPage`. Links between the copied pages point at the copies, and reminders in the copy belong to whoever made it. Send `template: true` to save a page as a template, or `template: false` (with `parent_id` or `space`) to make a page from one.

## Favorites, recent pages and readers

For people only; an API key is `403`.

| Method | Path | Description |
| --- | --- | --- |
| `GET`, `PUT` | `/v1/wiki/favorites` | Your favorites, in order. `PUT` `{ page_ids }` (up to 100) replaces them |
| `GET` | `/v1/wiki/recent?limit=` | The pages you opened lately, last first (default 15, at most 50) |
| `GET` | `/v1/wiki/pages/{id}/views` | `{ views, people, readers: [{ user, visits, last_at }] }`, the latest 20 readers |
| `GET` | `/v1/wiki/daily?from=&to=` | The days you have a daily note, `[{ date, id }]` (default from 60 days ago to 60 days ahead) |
| `POST` | `/v1/wiki/daily` | Open your note of a day: `{ date, title, journal_title?, body_html? }` |

`POST /v1/wiki/daily` makes the note when there is none, and the first time also your journal: a private top-level page that holds your daily notes, one per day. The journal stays at the top of your private pages (`422 journal_fixed` on a move).

## Databases

A page with `kind: "database"` keeps `database`, its properties and views; its subpages are its rows, each a page with `props`, its values by property id.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/wiki/pages` | `{ kind: "database", database? }` makes a database; `{ parent_id: <database>, title, props }` adds a row; `{ parent_id: <database>, template: true }` a row template |
| `GET` | `/v1/wiki/databases/{id}/rows` | `{ data: DbRow[], templates: WikiNode[] }`: every row, in order, and the database's row templates |
| `PATCH` | `/v1/wiki/pages/{id}` | `database` on a database, `props` on a row |

```ts
type Database = { properties: DbProperty[]; views: DbView[]; next_id: number };

type DbProperty = {
  id: string;             // [a-z0-9_]{1,24}; the first is the title, "title"
  name: string;
  type: "title" | "text" | "number" | "select" | "multi_select" | "status" | "date" | "person" | "checkbox"
    | "url" | "email" | "phone" | "files" | "relation" | "rollup" | "formula" | "created_time"
    | "created_by" | "edited_time" | "edited_by" | "unique_id" | "ticket";
  options?: { id: string; name: string; color: string }[];               // select, multi_select, status
  groups?: { id: "todo" | "doing" | "done"; option_ids: string[] }[];    // status
  number_format?: string;  // number, comma, percent, usd, eur, gbp, jpy, chf, cad, aud, inr, brl, huf, pln
  date_time?: boolean;     // dates have a time of day
  database_id?: string;    // relation: the related database
  rollup?: { relation: string; property: string; fn: string };
  formula?: string;
  prefix?: string;         // unique_id: letters before the number
  description?: string;
};

type DbView = { id: string; name: string; type: "table" | "board" | "list" | "gallery" | "calendar" | "timeline" | "chart"; settings?: object };

type DbRow = WikiNode & {
  props: Record<string, unknown>;
  cover: string;
  cover_y: number;
  excerpt: string;         // how its text starts
  created_at: string;
  created_by: UserRef | null;
  updated_by: UserRef | null;
};
```

| Type | Stored value |
| --- | --- |
| `text`, `url`, `email`, `phone` | a string |
| `number` | a number |
| `checkbox` | a boolean |
| `select`, `status` | an option id |
| `multi_select` | option ids |
| `date` | `{ start, end? }`: `YYYY-MM-DD` or RFC 3339 |
| `person` | user ids of members |
| `relation` | page ids of rows of the related database |
| `ticket` | ticket ids |
| `files` | `[{ url, name }]` |
| `unique_id` | numbered by the API for each new row |
| `title`, `rollup`, `formula`, created and edited time and by | worked out by the app, never stored |

`database` is replaced whole; `props` is merged, and `null` removes a value. Neither moves the page's version. A view's `settings` (filters, sorts, grouping, shown properties, calculations) belong to the app, which also works out filters, formulas and rollups. A wrong shape is `422 invalid_database`. A database holds up to 100 properties, 50 views, 128 KB of schema and 64 KB of values per row.

## Canvas

A page with `kind: "canvas"` keeps `canvas`: cards on an endless board and the connections between them, in the shape of [JSON Canvas 1.0](https://jsoncanvas.org) with the wiki's own card types. Its `body_html` is a description (empty from the app); its subpages are pages as anywhere else.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/wiki/pages` | `{ kind: "canvas", canvas? }` makes a canvas; left out, an empty one |
| `PATCH` | `/v1/wiki/pages/{id}` | `canvas` on a canvas, replaced whole |

```ts
type Canvas = { nodes: CanvasNode[]; edges: CanvasEdge[] };  // nodes in z order, later above

type CanvasNode = {
  id: string;              // [A-Za-z0-9_-]{1,64}, unique among the nodes
  x: number; y: number;    // within ±1,000,000
  width: number; height: number;  // 20..20,000
  color?: string;          // "1".."6" (red, orange, yellow, green, cyan, purple) or "#rrggbb"
} & (
  | { type: "text"; html: string }        // sanitized like a body
  | { type: "page"; page_id: string }     // a page of the workspace
  | { type: "link"; url: string; title?: string; description?: string; image?: string }  // https
  | { type: "file"; src: string; name: string }   // /v1/attachments/<id> or https; name up to 255
  | { type: "group"; label?: string }     // label up to 200
);

type CanvasEdge = {
  id: string;              // as a node's, unique among the edges
  fromNode: string; toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";  // left out: the sides that face each other
  toSide?: "top" | "right" | "bottom" | "left";
  fromEnd?: "none" | "arrow";   // default none
  toEnd?: "none" | "arrow";     // default arrow
  color?: string;
  label?: string;          // up to 200
};
```

A save keeps the page's version and adds no revision, and the last save wins. It moves the page's last edit. Fields that don't belong to a node's type are dropped, and default ends are left out. A page card added by a save names a page you can see, not in the trash; a file card added by a save names an attachment of the workspace. Cards already on the canvas stay as they are. Reading a canvas never shows a page's title: look the page up in your own tree. A wrong shape is `422 invalid_canvas`. A canvas holds up to 2,000 nodes, 4,000 edges and 1 MB.

The cards count as the page's text: page cards and page links in text cards are its links (backlinks, the graph), `#tags` and ticket mentions in text cards are its tags and ticket links, and the words on cards and connection labels are searched. Duplicates, templates and the trash carry the canvas with the page.

## Links, tags and the graph

As a page is saved, the API keeps what it links to and its `#tags`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/wiki/pages/{id}/backlinks` | The pages linking to it, last edited first (at most 200) |
| `GET` | `/v1/wiki/pages/{id}/mentions` | Unlinked mentions: pages whose text has its title as a phrase, without a link to it (at most 100) |
| `GET` | `/v1/wiki/graph` | Every link between pages you can see, `[{ from, to }]` |

Backlinks and mentions answer `{ id, parent_id, title, icon, snippet, updated_at }` each. A tag is `#` with letters, digits, `_`, `-` or `/` and at least one letter, outside code; `/` nests tags. Tags come back lower case on every page, in `tags`.

## Comments

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| `GET` | `/v1/wiki/pages/{id}/comments` | `wiki:read` | `{ data: WikiThread[], following }`: open and resolved threads, oldest first |
| `POST` | `/v1/wiki/pages/{id}/comments` | `wiki:write` | `{ body_html, mentions?, thread_id?, quote?, inline? }`: a new thread, or a reply with `thread_id` → `201 WikiThread` |
| `PATCH` | `/v1/wiki/comments/{id}` | `wiki:write` | `{ body_html, mentions? }`: its author only |
| `DELETE` | `/v1/wiki/comments/{id}` | `wiki:write` | Its author or an admin. Deleting a thread's first comment deletes the thread |
| `POST` | `/v1/wiki/threads/{id}/resolve` | `wiki:write` | `{ resolved }` |
| `POST` | `/v1/wiki/comments/{id}/reactions` | `wiki:write` | `{ emoji, on }`: one emoji, once per person |
| `PUT` | `/v1/wiki/pages/{id}/follow` | `wiki:read` | `{ following }`: hear about new comments on the page, or stop |

```ts
type WikiThread = {
  id: string;
  page_id: string;
  quote: string;           // the text an inline thread was started on
  inline: boolean;         // on a run of the text, marked in the body with data-comment
  created_at: string;
  resolved_at: string | null;
  resolved_by: UserRef | null;
  comments: {
    id: string;
    thread_id: string;
    author: UserRef | null;
    body_html: string;
    mentions: string[];    // user ids
    created_at: string;
    edited_at: string | null;
    reactions: { emoji: string; users: string[] }[];
  }[];
};
```

Writing comments is for agents and up, and for people: an API key reads comments and resolves threads, and is `403` on every other write. A reply reopens a resolved thread. A comment holds up to 20,000 characters and 50 mentions. Following is for people, viewers included.

## Reminders

A date in a page's body with `data-reminder="<uuid>"` reminds its owner: whoever first saved the page with that id. On every save the API makes the page's reminders match its body. The time is the date's `datetime`, read in the owner's notification time zone (a bare date at 09:00); a changed time reminds again, and an id gone from the body is removed. Copies and templates get new ids; a template reminds nobody. Up to 100 reminders per page.

## Notifications

The wiki's notifications are the `wiki` group of [notification preferences](/api/resources/workspace/#notifications). Their `ticket` is null:

| Type | When | `data` |
| --- | --- | --- |
| `wiki_mention` | Someone newly mentions you in a page's body, or in a comment | `{ page_id, page_title, by, preview, thread_id?, comment_id? }` |
| `wiki_comment` | A new comment on a page you follow, or a reply in a thread you wrote in | `{ page_id, page_title, by, preview, thread_id, comment_id }` |
| `wiki_reminder` | A reminder you set is due | `{ page_id, page_title, reminder_id, remind_at, label }` |

Only people who can see the page hear about it. When a page leaves someone's sight, or goes to the trash, their notifications about it are removed.

## Tickets and the help center

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/tickets/{id}/wiki` | The pages you can see that mention the ticket, last edited first (at most 50). Viewers; `tickets:read` and `wiki:read` |
| `POST` | `/v1/kb/articles/from-wiki` | `{ page_id, title?, collection_id?, brand_id? }` → `201 { article, left_out }`: a draft article copied from a page. Agents; `kb:write` and `wiki:read` |

A ticket the caller can't see is `404` on `/v1/tickets/{id}/wiki`, as on every ticket route. `from-wiki` turns wiki blocks into article formatting; mentions and links to pages keep only their text, and the workspace's own files, databases and subpages stay in the wiki, counted in `left_out`. A page without a title needs `title`. Nothing stays linked: later edits of the page never reach the article. See [Knowledge base](/api/resources/knowledge-base/).

## Ollie writing

`POST /v1/wiki/ai/write` (agents, `wiki:write`) has Ollie edit a selection or write from a page, the way the editor's **Ask Ollie** does:

```json
{
  "mode": "improve",
  "html": "<p>the selected text</p>",
  "context_html": "<p>the page around the cursor</p>",
  "title": "Refund policy",
  "instructions": "only with mode custom"
}
```

`mode` is `improve`, `fix_grammar`, `shorter`, `longer`, `simplify`, `more_formal`, `friendlier`, `summarize`, `action_items` or `explain` for a selection (`html`), `continue` or `summarize` from the page (`context_html`), or `custom` with `instructions`. The answer `{ html }` is sanitized like a body and is not saved: insert it with `PATCH`. Send `Accept: text/event-stream` to stream it. Typical cost $0.01 for a selection and $0.03 from a page. See [AI](/api/resources/ai/).

## Import and export

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/wiki/import` | Make pages from an upload. Agents; `wiki:write` |
| `GET` | `/v1/wiki/pages/{id}/export?format=&subpages=` | A page as one file, or with `subpages=true` a zip of it and its subpages. Viewers; `wiki:read` |
| `GET` | `/v1/wiki/export?format=` | Every page you can see, as `Wiki <YYYY-MM-DD>.zip`. Viewers; `wiki:read` |

### Import

`POST /v1/wiki/import` takes a multipart form:

| Field | |
| --- | --- |
| `files` | One zip (an Obsidian vault, a Notion, Confluence or Google Docs export), or Markdown, text, HTML, CSV and Obsidian `.canvas` files with the files they use. Repeat the field for each file. Up to 100 MB in all |
| `parent_id` | Optional: a page to import under (not a database, not in the trash). The import's top pages go last under it |
| `space`, `team_id` | Without `parent_id`: `workspace` (default), `private` (people only) or `team` with `team_id`, as for `POST /v1/wiki/pages` |

```sh
curl -X POST https://api.opendesk.sh/v1/wiki/import \
  -H "Authorization: Bearer od_live_..." \
  -F "files=@Notion-export.zip" \
  -F "space=workspace"
```

→ `201`:

```json
{
  "pages": 42,
  "root_ids": ["0192f0c4-..."],
  "skipped": [{ "path": "Vault/setup.exe", "reason": "executable" }]
}
```

`pages` is how many pages it made, `root_ids` the pages at the top of the import in order, and `skipped` what it left out or changed, by its path in the upload:

| `reason` | |
| --- | --- |
| `unsupported` | A kind of file that isn't imported (Obsidian bases) |
| `unused` | A file no page uses |
| `executable` | A program or a script; never imported |
| `too_large` | A file over 25 MB, or a page source over 4 MB |
| `unreadable` | A file whose text or table could not be read, or a table that can't be kept as a database (its rows stay pages) |
| `body_too_large` | A page whose text is over 512 KB; the page is made without it |
| `moved_up` | A page deeper than the wiki holds, placed beside its ancestor at the last level |
| `columns_dropped` | A table's columns past a database's 100 properties |
| `canvas_simplified` | A canvas with cards kept simpler, listed once per canvas: a card for a note's heading or block (`subpath`) shows the whole note; an http link, a file or note not in the upload, or a file not taken (a program, too large) is a text card; a group's background picture and nodes of types JSON Canvas doesn't define are left out |
| `canvas_trimmed` | A canvas's nodes past 2,000 or connections past 4,000, left out |
| `nested_archive` | An archive inside the upload |
| `files_limit` | A file past the plan's limit on imported files; what used it is left out of the page |

All the pages are made in one transaction, with their links, tags, files and a first revision each; imported mentions notify nobody. A `wiki_page.created` event follows for each page, parents first. An import is refused whole, before anything is stored:

| Status | Code | When |
| --- | --- | --- |
| `413` | `import_too_large` | The upload is over 100 MB, or over 200 MB unpacked |
| `422` | `wiki_full` | Its pages don't fit in the workspace's 5,000; the message says how many it makes and how many fit |
| `422` | `page_too_deep` | `parent_id` is at the 10th level |
| `422` | `import_into_database` | `parent_id` is a database |
| `422` | `import_unsupported` | Not a zip, nor a page source the wiki reads |
| `422` | `import_unreadable` | The archive could not be read |
| `422` | `import_too_many_files` | More than 10,000 files or 5,000 pages |
| `422` | `import_unsafe_path` | The archive holds links, absolute paths or paths that leave it |
| `422` | `import_compression` | An entry expands over 100 times past 1 MB |
| `422` | `import_empty` | No pages to import |
| `429` | `rate_limited` | Over 20 imports an hour in the workspace |

A tree deeper than fits below where it lands is lifted: pages past the last level go beside their ancestor there.

### Export

`format` is `markdown` (the default) or `html`.

- **Markdown** is an Obsidian vault: a `.md` per page with YAML front matter (title, icon, dates, tags, a row's values), its subpages in a folder of the same name beside it, `[[links]]` between pages, a database as a table of its rows with a `.csv` beside it, and a canvas as a `.canvas` file (JSON Canvas: text cards in Markdown, page cards as file nodes naming the exported page or a text node when that page isn't exported, https files as links, groups and connections as they are).
- **HTML** is a standalone page per file, linked by relative paths; a canvas draws its cards where they sit, with its connections.

One page without subpages (or without subpages you can see) is one file, `<title>.md` (`text/markdown; charset=utf-8`), a canvas's `<title>.canvas` (`application/json; charset=utf-8`) or `<title>.html` (`text/html; charset=utf-8`), its links to pages and files pointing to the app. A zip carries the files its pages use under `attachments/`, those you may read, up to 1 GB; a link to any other file, or to a page it doesn't carry, goes to the app. Exports never hold signed links. Every download is `Content-Disposition: attachment`. Pages in the trash, templates (for the whole wiki) and pages you can't see are left out; `GET /v1/wiki/export` with no pages is `422 wiki_empty`. An export reads up to 200 MB of page text (`422 export_too_large`). Zips are limited to 30 an hour per person or key (`429 rate_limited`) and recorded in the audit log.

## Presence

Who is on a page goes through the realtime gateway, on the `wiki_page:<wid>:<page_id>` topic: join with `{ "state": "viewing" | "editing" | "idle" }`, or `{ "watch": true }` to see others without being shown, and `{ "team_id": "<tid>" }` for a private team's page. Private pages have no presence. See [Realtime](/api/realtime/).

## Limits

- 5,000 pages per workspace, the trash and templates included (`422 wiki_full`).
- 10 levels deep (`422 page_too_deep`).
- 512 KB of text and formatting per page (`422 page_too_large`).
- 100 revisions per page. One person's edits a few minutes apart share a revision.
- 100 favorites, 100 reminders per page.
- A canvas: 2,000 nodes, 4,000 edges, 1 MB (`422 invalid_canvas`).
- Imports: 100 MB uploaded, 200 MB unpacked, 10,000 files, 5,000 pages, 25 MB a file, 4 MB a page source; 20 an hour per workspace.
- Exports: 200 MB of page text, 1 GB of files in a zip; 30 zips an hour per person or key.

## Events

| Event | Data |
| --- | --- |
| `wiki_page.created`, `wiki_page.updated`, `wiki_page.moved` | `{ wiki_page, updated_by }`: the page without its body. `wiki_page.updated` also carries `settings`, `verification`, `database`, `props` or `canvas` when those changed; `canvas_changed: true` instead of `canvas` when it is over 256 KB (fetch the page) |
| `wiki_page.deleted` | `{ wiki_page_id, wiki_page_ids }`: the page and every subpage that went with it; `trashed: true` when they went to the trash |
| `wiki_page.restored` | `{ wiki_page, wiki_page_ids }`: back from the trash |
| `wiki_comment.changed` | `{ page_id, thread_id }`: a thread changed; fetch the page's comments |

Events about a private page go only to its member, and about a private team's page only to that team. Fetch the page for its text.
