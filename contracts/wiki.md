# Wiki

The **wiki** is the team's internal documentation: runbooks, policies, escalation steps,
onboarding, how-tos. Pages nest under each other like folders that hold their own text. Schema:
`migrations/000683_wiki.up.sql`. Owners: the API is backend-helpdesk (`internal/helpdesk/wiki`), the
pages are web (`web/src/pages/wiki`).

The wiki is for members only. It is never public and never reaches a customer: no help center,
no widget, no email agent, no knowledge source of the AI agent, no embeddings. The knowledge base
(`/v1/kb/*`) is what customers read. Ollie, the in-app assistant, reads the wiki for the member it
works for; AI clients connected to the MCP server read and write it with the `wiki:*` scopes. The
wiki is on every plan, with the limits below.

## Shapes

```ts
interface WikiNode {           // a page in the tree, without its body
  id: string
  parent_id: string | null     // the page it sits under; null at the top level
  title: string                // 0..200 characters (longer is 422), whitespace folded; "" shows as "Untitled"
  icon: string                 // one emoji (see "Icons"), or ""
  position: number             // order among its siblings: 0, 1, 2... with no gaps
  version: number              // starts at 1, +1 on every change of title, icon or body
  updated_at: string           // the last change of title, icon or body (moves do not count)
  created_by_id: string | null // who created it; null for an API key, or once the person deleted their account
  tags: string[]               // the #tags in its text, lower case, see "Links and tags"
}

interface WikiRef { id: string; title: string; icon: string }

interface WikiPage extends WikiNode, PageSettings {
  body_html: string            // rich text, see "Body"
  created_by: UserRef | null   // null for an API key, or once the person deleted their account
  updated_by: UserRef | null
  created_at: string
  breadcrumbs: WikiRef[]       // its ancestors, the top-level page first
  children: WikiRef[]          // its subpages, in order
}

interface PageSettings {       // see "Page settings"
  cover: string                // "" (none), "gradient:<name>", or an image: https or /v1/attachments/<id>
  cover_y: number              // 0..100: which part of an image cover shows, top to bottom; default 50
  full_width: boolean
  small_text: boolean
  font: "default" | "serif" | "mono"
  locked: boolean              // the app keeps the page read-only until someone unlocks it
}

interface LinkCard { title: string; description: string; image: string; site: string }

interface WikiRevision {
  id: string
  title: string
  icon: string
  body_html?: string           // only when one revision is read
  author: UserRef | null
  created_at: string           // the first edit it holds
  updated_at: string           // the last edit it holds
}

interface WikiSearchHit {
  id: string
  parent_id: string | null
  title: string
  icon: string
  snippet: string              // plain text around the match, no markup
  path: WikiRef[]              // its ancestors, the top-level page first
  updated_at: string
}
```

## Access

| who | reads | creates, edits, moves, restores | deletes |
| --- | --- | --- | --- |
| viewer | yes | no | no |
| agent | yes | yes | a page they created, when they also created every page under it |
| admin, owner | yes | yes | any page |
| API key, AI client | `wiki:read` | `wiki:write` | `wiki:write` (an AI client's member: as their role allows) |

An agent deleting a page with someone else's page in it (the page or any subpage, including pages
moved under it) gets `403`, with a message saying an admin can delete it; so moving another team's
pages under one's own never makes them deletable. The tree carries `created_by_id` so the app offers
Delete only where it would pass, and says why it doesn't otherwise. An API key with `wiki:write`
deletes any page: whoever holds the key is trusted with the whole wiki.

Every page belongs to one workspace and is read and written with the caller's workspace. A
`parent_id` from another workspace is `422`; another workspace's page is `404`. The parent of a
page is enforced in the schema too (a composite key on `(workspace_id, parent_id)`). `kb:*`
scopes do not reach the wiki, nor `wiki:*` the knowledge base.

## Tree

- New pages go at the end of their parent's subpages unless `position` says where.
- `POST /v1/wiki/pages/{id}/move` `{parent_id, position}` moves a page with everything under it. A
  page never moves under itself or one of its subpages (`422 page_cycle`). Positions are numbered
  again from 0 among the new siblings and, when the parent changed, the old ones.
- Changes to the tree (create, move, delete) of one workspace run one at a time
  (`pg_advisory_xact_lock`), so counts, depths and cycle checks see each other.
- Deleting a page deletes its subpages and their history, for good (`ON DELETE CASCADE`). The app
  asks first and names how many subpages go with it.
- In the app, pages drag onto, above and below each other; **Move to…** in a page's menu (in the tree
  and on the page) picks the new parent from a searchable list, or the top level, and puts the page
  last among its new siblings. It is what touch screens use, where dragging is not available. Pages
  the move can't go under (the page itself, its subpages, or past the depth limit) are not offered.

## Body

`body_html` is sanitized before it is stored with `hd.SanitizeWiki`: the rich-text allowlist the
knowledge base uses (`hd.SanitizeRich`: paragraphs, headings, lists, quotes, code, links, images from
https or our attachments, mentions) and the wiki's blocks below. Pages written before the blocks
existed are valid as they are. The knowledge base keeps its own allowlist: no block reaches an article.
Images and files are uploaded as attachments (`POST /v1/attachments`).

## Blocks

The app writes pages with a block editor (`web/src/components/wiki/editor`): "/" offers every block,
"[[" links a page, "@" mentions a person, a page or a date, ":" an emoji; a handle beside each block
drags it or opens its menu (turn into, colour, duplicate, copy a link to it, move, delete), and a
toolbar shows over selected text. The page's formatting bar stays available (page menu, "Formatting
bar", kept per browser). Every block is a plain element with data attributes, each value checked:

| block | HTML |
| --- | --- |
| headings 1 to 3, paragraph | `h1`..`h3`, `p`; `style="text-align: left\|center\|right\|justify"` |
| block colour | `data-color` (text) and `data-bg` (background) on `p`, `h1`..`h3`, `li`, lists, `blockquote`, `details`: `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `red` |
| inline colour | `<span data-color>`, `<mark data-bg>` (same tones) |
| to-do list | `<ul data-type="taskList"><li data-type="taskItem" data-checked="true\|false">`; the checkbox is the app's to draw, never stored |
| toggle | `<details><summary>…</summary><div data-type="detailsContent">…</div></details>` |
| callout | `<div data-type="callout" data-icon="<emoji>" data-tone="<tone>">blocks</div>` |
| columns | `<div data-type="columns">` holding 2 to 5 `<div data-type="column">` |
| code | `<pre><code class="language-<name>">`; the app highlights it |
| equation | `<div data-type="block-math" data-latex>`, `<span data-type="inline-math" data-latex>`; KaTeX in the app |
| image | `<img src alt data-width="1..100" data-align="left\|right" data-caption>` (width in percent of the column) |
| file, video, audio | `<div data-type="file\|video\|audio" data-src data-name data-size data-mime>`; `data-src` is https or one of our attachments |
| bookmark | `<div data-type="bookmark" data-url data-title data-description data-image>` (https links), see "Bookmarks" |
| embed | `<div data-type="embed" data-url>`, see "Embeds" |
| table of contents | `<div data-type="toc">`: the app lists the page's headings |
| subpage | `<div data-type="subpage" data-id="<page id>">`: the page shows where it sits in the text |
| link to a page | `<a data-type="page" data-id="<page id>" data-block="<block id>" href="/wiki/<id>">title when linked</a>`; the app shows the page's live title and icon |
| date | `<time data-type="date" datetime="YYYY-MM-DD">` |
| table | `table`, `colgroup`/`col` (`style` width or min-width in px), `th`/`td` (`colspan`, `rowspan`, `colwidth`) |
| divider | `hr` |

Blocks carry `data-block-id` (a uuid) so a link can point at one (`/wiki/<id>#<block id>`). The app adds
ids as a page loads without saving them: loading is never an edit, and the next save carries them.
"Copy link to block" saves first. Nothing runs, loads a frame or styles freely: no `iframe`, `script`,
`style` element or event handler survives, and a value that doesn't match is dropped.

## Embeds

An embed keeps only the link that was pasted. The app maps it to the provider's own player
(`web/src/lib/wiki/embeds.ts`: YouTube, Vimeo, Loom, Figma, Google Docs, Sheets, Slides, Forms and
Drive, Google Maps, Miro, CodePen, CodeSandbox, Spotify, Excalidraw, Airtable, Typeform, Calendly) and
loads it in a sandboxed frame. Those players' origins are the only frames the app's
Content-Security-Policy allows besides Turnstile (`internal/app/app.go`, `deploy/cloudflare/pages/app/_headers`;
`TestEmbedFrameSourcesAgree` keeps the three lists equal). A link no provider plays shows as a link.

## Bookmarks

`POST /v1/wiki/unfurl` `{url}` (agent, `wiki:write`; 120 a minute per workspace) reads an https page
once, through the outbound guard (no private, loopback or link-local targets; redirects re-checked; 512 KB
of HTML at most), and answers a `LinkCard` from its Open Graph tags, else its `<title>` and description.
A page it can't read is `422 unreachable`; the app then keeps the bookmark with its address alone. The
card is stored in the block: nothing is fetched when the page is read later.

## Page settings

A page's cover, width, text size, font and lock are its look, not its text. `PATCH` takes any of
`cover`, `cover_y`, `full_width`, `small_text`, `font`, `locked` without a `version`: changing them keeps
the version (a tab typing on the page never conflicts with it) and adds no revision. A cover is ""
(none), one of the app's gradients (`gradient:` `dawn`, `ocean`, `forest`, `dusk`, `sand`, `slate`, `rose`,
`lagoon`, `aurora`, `ember`; `web/src/components/wiki/covers.ts`), or an image: https or an attachment.
Anything else is `422`. A locked page opens read-only in the app for everyone, with Unlock for people
who may edit; the API does not refuse edits to it (it guards against accidents, not people). Viewers
change nothing.

## Editing together

The app saves as people type. Every PATCH from the app sends the `version` it edited; when someone
else saved since, the API answers `409 page_changed` and changes nothing. The app then shows
"Someone else edited this page", keeps what was typed and offers to load their version or to keep
its own (which saves again with the new version). A PATCH without `version` (an API caller that
does not care) always applies. A PATCH that changes nothing keeps the version and publishes no
event.

Only a person who may edit ever saves, and loading a version (someone else's, a restored one,
theirs after a conflict) is never an edit: viewers and idle agents send nothing. A save answered
`403` or `404` stops for good (no retries): the page says it can't be edited or was deleted, and
offers the unsent text to copy. While any page holds unsent text, closing the tab from anywhere in
the app sends it and the browser asks first. A tab refetches a page when an event's `version` is
newer than the one it holds, so the same person's edits from another tab or through Ollie arrive
too.

## History

Every change of title, icon or body is kept as a revision:

- One person's edits less than 10 minutes apart, for at most an hour, are one revision: while they
  type, their latest revision moves along (`updated_at`). Someone else's edit, a pause, an API key's
  edit and a restore start a new one.
- At most 100 revisions per page are kept; the oldest go first.
- Restoring a revision puts its title, icon and body back as a new version and a new revision, so
  what it replaced stays in the history.

Moves are not revisions.

## Links and tags

As a page's body is saved (create, update, restore), the API keeps what it links to and its tags
(`wiki_links`, `wiki_pages.tags`; migration `000720` read them from pages written before):

- A link is a link to a page (`/wiki/<id>`, the page-link and subpage blocks) of the same workspace;
  a link to a page that doesn't exist there is left out. Deleting a page removes its links both ways.
- A tag is `#` and letters, digits, `_`, `/` or `-` with at least one letter (`#42` is a number), after
  a space or at a line's start, never inside code. Lower case, each once, at most 50 of 64 characters.
  `/` nests them (`#process/refunds` is under `#process`).

| method | path | | |
| --- | --- | --- | --- |
| GET | `/v1/wiki/pages/{id}/backlinks` | `wiki:read` | `Page<WikiMention>`: the pages linking to it, last edited first (at most 200) |
| GET | `/v1/wiki/pages/{id}/mentions` | `wiki:read` | `Page<WikiMention>`: unlinked mentions, the pages whose text has its title as a phrase and no link to it (at most 100; none for an untitled page) |
| GET | `/v1/wiki/graph` | `wiki:read` | `Page<{from, to}>`: every link in the workspace (the pages are the tree's) |

```ts
interface WikiMention { id: string; parent_id: string | null; title: string; icon: string; snippet: string; updated_at: string }
```

The app shows them as Obsidian does: a page panel beside the page (Mod+Shift+;) with its outline, its
linked mentions, its unlinked mentions (each with Link, which links the first place that page names
this one, outside links and code, and saves it with that page's version), the pages it links to, its
local graph and what it holds (words, reading time, tags, who made and edited it); "N backlinks" under
the title; a graph of the whole wiki (`/wiki/graph`, `?focus=` a page, `?tag=`); the tags with their
pages (`/wiki/tags`, `?tag=`); a preview of a page while the pointer rests on a link to it; `#tags`
drawn as tags in the text; and a random page from the wiki's home.

## Search

`GET /v1/wiki/search?q=` matches titles (weighted highest) and bodies, every word also as a
prefix ("refu" finds "refunds"), like the knowledge base's `prefixQuery`. `GET /v1/search` (the
command palette) returns the top 5 pages in `wiki_pages` to callers that may read the wiki.

## Icons

`icon` is one emoji as Unicode spells them (UTS #51): an `Extended_Pictographic` character with an
optional variation selector and skin tone, several joined by ZWJ (families, professions), a flag
(a pair of regional indicators, or a black flag with tag characters), or a keycap. Anything else
(letters, bidi controls, zero-width characters other than the joiner, combining marks, two emoji)
is `422`. Every emoji the app's picker offers passes (`TestPickerEmoji`).

## Events

`wiki_page.created`, `wiki_page.updated`, `wiki_page.moved`: `{ wiki_page: WikiNode, updated_by }`;
`wiki_page.updated` also carries `settings: PageSettings` when the page's look changed (it has no
version to compare, so a client takes it as it comes).
`wiki_page.deleted`: `{ wiki_page_id, wiki_page_ids }` (the page and every subpage removed with it).
Bodies are left out, as they are large and saved often: a client showing the page refetches it.
The web app patches the tree in place on `created`, `updated` and `deleted`, and refetches it on
`moved`. Audit: `wiki_page.created` `{title, parent_id}`, `wiki_page.deleted` `{title, subpages}`.

## Limits

| | |
| --- | --- |
| pages per workspace | 5,000 (`422 wiki_full`) |
| depth | 10 levels (`422 page_too_deep`, counting the subpages a move takes along) |
| body | 512 KB (`422 page_too_large`) |
| title | 200 characters (`422`; the app's title field stops at 200) |
| revisions per page | 100 |

## AI

- **Ollie** (`internal/ai/assistant`) has `search_wiki` and `get_wiki_page` read tools and links
  the pages it used (`Ref.kind: "wiki_page"`). The page context carries `wiki_page_id` on a wiki
  page. Writing goes through `api_change` and its approval, like other settings.
- **MCP** (`contracts/agent.md` "opendesk MCP server"): `search_wiki`, `get_wiki_page`
  (`wiki:read`), `create_wiki_page`, `update_wiki_page` (`wiki:write`; markdown bodies).
- Never the widget agent, the email agent, suggested replies or anything a customer sees.
- An admin writing an agent procedure may copy a page's text into its instructions once
  (`contracts/agent.md` "Procedures"). The copy is the procedure's own text from then on: nothing stays
  linked, and later edits of the page never reach the agent.
