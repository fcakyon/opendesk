# Pages

**Pages** is the workspace's own pages, databases and canvases: docs, notes, plans and projects,
a product of its own beside Tickets and Mail. It is built on the wiki's engine (contracts/wiki.md):
the same editor and blocks, databases, canvases, comments, presence, links, templates, journal,
import and export, and Ollie writing. Its pages are a tree of their own, apart from the wiki's, which
stays the team's runbooks and policies. Schema: `migrations/000729_wiki_pages_area.up.sql`. Owners:
the API is backend-helpdesk (`internal/helpdesk/wiki`), the product flag backend-core
(`internal/products`, `internal/core/workspaces.go`), the app web.

## The product

`settings.pages_enabled` (contracts/api.md `WorkspaceSettings`, default true) turns it on or off for
the workspace. It is the workspace's own flag: no instance option and no plan turns it off, and every
plan has it. The rule that one product stays on counts it: a workspace may use Pages alone, and Pages
can't be turned off while it is the only product on (`422 at_least_one_product_required`).

While Pages is off its pages stay stored and out of reach: every operation on one of its pages or
lists, by id or with `area=pages`, answers `403 feature_disabled` with `product: "pages"` and
`reason: "workspace_disabled"`. Lists of both areas (favorites, search without `area`, a ticket's
pages, a wiki page's backlinks and unlinked mentions) leave its pages out, and its pages' files
answer `404` as files of a page out of sight do. Links, mentions and embeds of them in wiki pages stay in the text and
show as a page you can't open. Everything comes back as it was once Pages is on.

## Areas

Every page has an `area`: `"wiki"` or `"pages"` (`WikiNode.area`, `WikiPage.area`, `WikiSearchHit.area`;
a page from before Pages is the wiki's). A subpage is always in its parent's area.

| | |
| --- | --- |
| lists of one area | `GET /v1/wiki/pages`, `/recent`, `/trash`, `/graph`, `/daily`, `/export` take `area` (`wiki` by default, so every existing client reads the wiki as before) |
| lists of both | `GET /v1/wiki/favorites` (one list of favorites, in the member's order; `PUT` replaces the favorites of the areas that are on, so Pages' stay while Pages is off), `GET /v1/wiki/search` (both unless `area` names one; each hit says its area), `GET /v1/tickets/{id}/wiki`, global search |
| shared | templates (`GET /v1/wiki/templates`): a template makes a page in either area |
| by id | every page route works whatever the area |
| making | `POST /v1/wiki/pages`, `/duplicate`, `/import` and `/daily` take `area` for a top-level page (`wiki` by default); under a parent, the parent's |
| moving | `POST /v1/wiki/pages/{id}/move` with `area` at the top level moves the page with its subpages to the other tree (audit-logged `wiki_page.moved_area`); under a parent of the other area, it goes there too. A daily note that changes area is a page |

Top-level pages are numbered within their area and space. Each member keeps one journal per area.
Links, mentions, backlinks, unlinked mentions and synced blocks work across both areas, within the
reader's visibility (contracts/wiki.md "Private pages and teamspaces"), which is the same in both.

The MCP tools (`search_wiki`, `create_wiki_page`, `get_wiki_page`) take and return `area`; Ollie and
procedures read both areas while Pages is on.

## Web app

- **Routes.** `/pages` is Pages' home, `/pages/<id>` a page, and `/pages/graph`, `/pages/tags`,
  `/pages/templates`, `/pages/trash` its own views, the wiki's own with Pages' tree. A link to
  `/wiki/<id>` of a page of Pages opens `/pages/<id>`, and the other way round, so every link in a
  body, a notification or a search keeps working. While Pages is off, `/pages` goes to the
  workspace's home.
- **The sidebar.** The main sidebar's Pages section (contracts/wiki.md "In the main sidebar") is
  Pages' tree; the wiki keeps its own column at `/wiki`. On a page of Pages the page list beside it is
  hidden while the section shows, unless the member shows it.
- **Home.** Ways to start (a page, a database, a canvas, an import), the member's favorites of Pages,
  the pages edited lately and the databases with their row counts; the shared empty state with the
  same ways in while there are none.
- **Adding.** The new page popup, the header's New menu, the command menu's New page and an import
  from no page add to Pages; opened from inside the wiki, to the wiki; with Pages off, to the wiki.
- **Moving.** A page's menu has Move to Pages or Move to the wiki (not on a journal or a template).
- **Search.** The command menu groups Pages' pages apart from the wiki's.
- **Settings.** Settings › Pages has the product's switch (admins), the teamspaces with how many pages
  each holds, import and export of Pages, and the trash. General › Products has the same switch.
