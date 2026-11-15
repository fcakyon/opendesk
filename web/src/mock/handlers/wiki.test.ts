import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Database, DbProperty, DbRows, Notification, WikiComments, WikiDailyNote, WikiNode, WikiPage, WikiPageAnalytics, WikiPageViews, WikiRevision, WikiSearchHit, WikiThread, WikiTrashed } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { applyWikiCommentEvent, applyWikiEvent } from "@/lib/wiki/events";
import { resetSavers, saverFor } from "@/lib/wiki/saver";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";
import { DEFAULT_LOOK } from "@/lib/wiki/look";

async function call(method: string, path: string, body?: unknown, wid?: string) {
  const ws = wid ?? db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: ws ? { "OD-Workspace": ws } : {} });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

describe("mock wiki", () => {
  installMock();

  it("seeds a handbook in the first workspace and nothing elsewhere", async () => {
    const tree = (await call("GET", "/v1/wiki/pages")).body.data as WikiNode[];
    expect(tree.find((n) => n.title === "Support handbook")).toBeTruthy();
    const lumen = db.workspaces[1].workspace.id;
    expect((await call("GET", "/v1/wiki/pages", undefined, lumen)).body.data).toEqual([]);
  });

  it("saves with versions, refuses a stale one and keeps one revision per burst of typing", async () => {
    const p = (await call("POST", "/v1/wiki/pages", { title: "Refunds" })).body as WikiPage;
    expect(p.version).toBe(1);
    const a = (await call("PATCH", `/v1/wiki/pages/${p.id}`, { body_html: "<p>a</p>", version: 1 })).body as WikiPage;
    const b = (await call("PATCH", `/v1/wiki/pages/${p.id}`, { body_html: "<p>ab</p>", version: a.version })).body as WikiPage;
    expect(b.version).toBe(3);
    const stale = await call("PATCH", `/v1/wiki/pages/${p.id}`, { body_html: "<p>old</p>", version: 1 });
    expect(stale).toMatchObject({ status: 409, body: { code: "page_changed" } });
    const revs = (await call("GET", `/v1/wiki/pages/${p.id}/revisions`)).body.data as WikiRevision[];
    expect(revs).toHaveLength(1);
  });

  it("moves without cycles and deletes subpages with their page", async () => {
    const top = (await call("POST", "/v1/wiki/pages", { title: "Top" })).body as WikiPage;
    const sub = (await call("POST", "/v1/wiki/pages", { title: "Sub", parent_id: top.id })).body as WikiPage;
    expect(sub.breadcrumbs.map((c) => c.id)).toEqual([top.id]);
    expect((await call("POST", `/v1/wiki/pages/${top.id}/move`, { parent_id: sub.id, position: 0 })).body.code).toBe("page_cycle");
    expect((await call("DELETE", `/v1/wiki/pages/${top.id}`)).status).toBe(204);
    expect((await call("GET", `/v1/wiki/pages/${sub.id}`)).status).toBe(404);
  });

  it("lets an agent delete only pages they created with everything under them", async () => {
    const ws = db.workspaces[0];
    const me = ws.members.find((m) => m.user_id === db.meId)!;
    const theirs = (await call("GET", "/v1/wiki/pages")).body.data.find((n: WikiNode) => n.created_by_id && n.created_by_id !== db.meId) as WikiNode;
    const mine = (await call("POST", "/v1/wiki/pages", { title: "Empty" })).body as WikiPage;
    const role = me.role;
    me.role = "agent";
    try {
      expect((await call("DELETE", `/v1/wiki/pages/${theirs.id}`)).status).toBe(403);
      await call("POST", `/v1/wiki/pages/${theirs.id}/move`, { parent_id: mine.id, position: 0 });
      const refused = await call("DELETE", `/v1/wiki/pages/${mine.id}`);
      expect(refused).toMatchObject({ status: 403, body: { detail: expect.stringContaining("only an admin") } });
    } finally {
      me.role = role;
    }
    await call("POST", `/v1/wiki/pages/${theirs.id}/move`, { parent_id: theirs.parent_id, position: theirs.position });
    expect((await call("DELETE", `/v1/wiki/pages/${mine.id}`)).status).toBe(204);
  });

  it("refuses long titles and icons that aren't one emoji", async () => {
    expect((await call("POST", "/v1/wiki/pages", { title: "a".repeat(201) })).status).toBe(422);
    for (const icon of ["\u202e📘", "📘📘", "ab", "\u200b📘", "📘\u0301"]) expect((await call("POST", "/v1/wiki/pages", { icon })).status, icon).toBe(422);
    for (const icon of ["📘", "☑️", "🇭🇺", "👨‍👩‍👧‍👦", "1️⃣", "👋🏽"]) expect((await call("POST", "/v1/wiki/pages", { icon })).status, icon).toBe(201);
  });

  it("finds pages by partly typed words, in global search too", async () => {
    const hits = (await call("GET", "/v1/wiki/search?q=escal")).body.data as WikiSearchHit[];
    expect(hits[0]?.title).toBe("Escalation process");
    expect(hits[0]?.path.map((p) => p.title)).toEqual(["Support handbook"]);
    const all = (await call("GET", "/v1/search?q=escalation")).body;
    expect(all.wiki_pages.length).toBeGreaterThan(0);
  });

  it("keeps a member's private pages and a private team's pages out of everyone else's sight", async () => {
    const ws = db.workspaces[0];
    const other = ws.members.find((m) => m.user_id !== db.meId && m.role !== "viewer")!.user_id;
    const mine = (await call("POST", "/v1/wiki/pages", { title: "My scratchpad", space: "private", body_html: "<p>zebracorn plan</p>" })).body as WikiPage;
    const under = (await call("POST", "/v1/wiki/pages", { title: "Inside", parent_id: mine.id })).body as WikiPage;
    expect([mine.private, under.private]).toEqual([true, true]);
    expect(ids(await tree())).toContain(mine.id);
    await as(other, async () => {
      expect((await call("GET", `/v1/wiki/pages/${mine.id}`)).status).toBe(404);
      expect((await call("PATCH", `/v1/wiki/pages/${mine.id}`, { title: "x" })).status).toBe(404);
      expect((await call("POST", `/v1/wiki/pages/${mine.id}/trash`)).status).toBe(404);
      expect((await call("POST", "/v1/wiki/pages", { title: "x", parent_id: mine.id })).status).toBe(422);
      expect(ids(await tree())).not.toContain(mine.id);
      expect((await call("GET", "/v1/wiki/search?q=zebracorn")).body.data).toEqual([]);
    });
    // Moving it to the workspace shares it, with what is under it.
    await call("POST", `/v1/wiki/pages/${mine.id}/move`, { parent_id: null, position: 0, space: "workspace" });
    await as(other, async () => expect(((await call("GET", `/v1/wiki/pages/${under.id}`)).body as WikiPage).private).toBe(false));

    // Legal is private and the signed-in owner is not on it; Support is public.
    const legal = ws.teams.find((t) => t.name === "Legal")!;
    const support = ws.teams.find((t) => t.name === "Support")!;
    const lawyer = legal.members[0]!.user_id;
    expect((await call("POST", "/v1/wiki/pages", { title: "x", space: "team", team_id: legal.id })).status).toBe(422);
    const runbook = await as(lawyer, async () => (await call("POST", "/v1/wiki/pages", { title: "DPA runbook", space: "team", team_id: legal.id })).body as WikiPage);
    const docs = (await call("POST", "/v1/wiki/pages", { title: "Support docs", space: "team", team_id: support.id })).body as WikiPage;
    expect(docs.team_id).toBe(support.id);
    expect((await call("GET", `/v1/wiki/pages/${runbook.id}`)).status).toBe(404);
    expect(ids(await tree())).not.toContain(runbook.id);
    // A link from the hidden page leaks nothing: no backlink, no graph edge.
    await as(lawyer, () => call("PATCH", `/v1/wiki/pages/${runbook.id}`, { body_html: `<p><a data-type="page" data-id="${docs.id}" href="/wiki/${docs.id}">docs</a></p>` }));
    expect((await call("GET", `/v1/wiki/pages/${docs.id}/backlinks`)).body.data).toEqual([]);
    expect(((await call("GET", "/v1/wiki/graph")).body.data as { from: string }[]).some((l) => l.from === runbook.id)).toBe(false);
    await as(lawyer, async () => expect((await call("GET", `/v1/wiki/pages/${docs.id}/backlinks`)).body.data).toHaveLength(1));
  });

  it("trashes a page with its subpages and restores the batch", async () => {
    const root = (await call("POST", "/v1/wiki/pages", { title: "Old process" })).body as WikiPage;
    const child = (await call("POST", "/v1/wiki/pages", { title: "Step one", parent_id: root.id, body_html: "<p>quokkaword</p>" })).body as WikiPage;
    const keep = (await call("POST", "/v1/wiki/pages", { title: "Keep" })).body as WikiPage;
    await call("PUT", "/v1/wiki/favorites", { page_ids: [child.id, keep.id] });

    const trashed = await call("POST", `/v1/wiki/pages/${root.id}/trash`);
    expect(trashed.status).toBe(200);
    expect(trashed.body.deleted_at).toBeTruthy();
    expect(ids(await tree())).not.toContain(child.id);
    expect(((await call("GET", `/v1/wiki/pages/${child.id}`)).body as WikiPage).deleted_at).toBeTruthy();
    expect((await call("GET", "/v1/wiki/search?q=quokkaword")).body.data).toEqual([]);
    expect((await call("PATCH", `/v1/wiki/pages/${child.id}`, { title: "x" })).body.code).toBe("page_in_trash");
    expect((await call("POST", `/v1/wiki/pages/${root.id}/move`, { parent_id: null, position: 0 })).body.code).toBe("page_in_trash");
    expect((await call("POST", "/v1/wiki/pages", { title: "x", parent_id: root.id })).status).toBe(422);
    const trash = (await call("GET", "/v1/wiki/trash")).body.data as WikiTrashed[];
    expect(trash[0]).toMatchObject({ id: root.id, subpages: 1 });
    expect(Date.parse(trash[0]!.purge_at) - Date.parse(trash[0]!.deleted_at)).toBe(30 * 24 * 3600 * 1000);
    expect(trash.some((t) => t.id === child.id)).toBe(false);
    expect(ids((await call("GET", "/v1/wiki/favorites")).body.data)).toEqual([keep.id]);

    expect((await call("POST", `/v1/wiki/pages/${child.id}/restore`)).body.code).toBe("trashed_with_parent");
    expect((await call("POST", `/v1/wiki/pages/${keep.id}/restore`)).body.code).toBe("not_in_trash");
    expect((await call("POST", `/v1/wiki/pages/${root.id}/restore`)).status).toBe(200);
    const top = (await tree()).filter((n) => n.parent_id === null && !n.private && !n.team_id);
    expect(top.at(-1)?.id).toBe(root.id);
    expect(top.map((n) => n.position)).toEqual(top.map((_, i) => i));
    expect(ids(await tree())).toContain(child.id);

    // Delete for good works from the trash, with what went with it.
    await call("POST", `/v1/wiki/pages/${root.id}/trash`);
    expect((await call("DELETE", `/v1/wiki/pages/${root.id}`)).status).toBe(204);
    expect((await call("GET", `/v1/wiki/pages/${child.id}`)).status).toBe(404);
  });

  it("starts a page from a template, with its subpages copied and their ids remapped", async () => {
    const seeded = (await call("GET", "/v1/wiki/templates")).body.data as WikiNode[];
    expect(seeded.map((t) => t.title)).toEqual(expect.arrayContaining(["Incident review", "Meeting notes"]));
    const tpl = (await call("GET", `/v1/wiki/pages/${seeded.find((t) => t.title === "Incident review")!.id}`)).body as WikiPage;
    expect(tpl.template).toBe(true);
    expect(ids(await tree())).not.toContain(tpl.id);
    const sub = tpl.children[0]!.id;
    expect(tpl.body_html).toContain(sub);

    const made = await call("POST", `/v1/wiki/pages/${tpl.id}/duplicate`, { template: false, title: "Outage 12 May" });
    expect(made.status).toBe(201);
    const page = made.body as WikiPage;
    expect(page).toMatchObject({ template: false, title: "Outage 12 May", icon: tpl.icon, cover: tpl.cover });
    const copied = page.children[0]!.id;
    expect(copied).not.toBe(sub);
    expect(page.body_html).toContain(copied);
    expect(page.body_html).not.toContain(sub);
    expect(ids(await tree())).toEqual(expect.arrayContaining([page.id, copied]));

    // Saving a page as a template takes it out of the tree; under itself is a cycle.
    const saved = (await call("POST", `/v1/wiki/pages/${page.id}/duplicate`, { template: true, title: "Outage template" })).body as WikiPage;
    expect(ids((await call("GET", "/v1/wiki/templates")).body.data)).toContain(saved.id);
    expect(ids(await tree())).not.toContain(saved.id);
    expect((await call("POST", `/v1/wiki/pages/${page.id}/duplicate`, { parent_id: copied })).body.code).toBe("page_cycle");
  });

  it("keeps favorites in order, records visits and shows who reads a page", async () => {
    const a = (await call("POST", "/v1/wiki/pages", { title: "A" })).body as WikiPage;
    const b = (await call("POST", "/v1/wiki/pages", { title: "B" })).body as WikiPage;
    const other = db.workspaces[0].members.find((m) => m.user_id !== db.meId && m.role !== "viewer")!.user_id;
    const secret = await as(other, async () => (await call("POST", "/v1/wiki/pages", { title: "Theirs", space: "private" })).body as WikiPage);
    const favs = await call("PUT", "/v1/wiki/favorites", { page_ids: [b.id, a.id, secret.id, b.id] });
    expect(ids(favs.body.data)).toEqual([b.id, a.id]);
    expect(ids((await call("GET", "/v1/wiki/favorites")).body.data)).toEqual([b.id, a.id]);

    await call("GET", `/v1/wiki/pages/${a.id}`);
    await call("GET", `/v1/wiki/pages/${b.id}`);
    await as(other, () => call("GET", `/v1/wiki/pages/${a.id}`));
    expect(ids((await call("GET", "/v1/wiki/recent")).body.data).slice(0, 2)).toEqual([b.id, a.id]);
    const views = (await call("GET", `/v1/wiki/pages/${a.id}/views`)).body as WikiPageViews;
    expect(views).toMatchObject({ views: 2, people: 2 });
    expect(views.readers[0]?.user.id).toBe(other);
    // The seeded handbook already has readers.
    const handbook = (await tree()).find((n) => n.title === "Support handbook")!;
    expect(((await call("GET", `/v1/wiki/pages/${handbook.id}/views`)).body as WikiPageViews).readers.length).toBeGreaterThan(0);
  });

  it("keeps a private journal of daily notes, newest first, one per day", async () => {
    const day1 = await call("POST", "/v1/wiki/daily", { date: "2026-11-06", title: "Friday, 6 November", journal_title: "Journal" });
    expect(day1.status).toBe(200);
    const again = (await call("POST", "/v1/wiki/daily", { date: "2026-11-06", title: "ignored" })).body as WikiPage;
    const day2 = (await call("POST", "/v1/wiki/daily", { date: "2026-11-07", title: "Saturday, 7 November" })).body as WikiPage;
    const note = day1.body as WikiPage;
    expect(again.id).toBe(note.id);
    expect(note).toMatchObject({ private: true, daily_date: "2026-11-06", title: "Friday, 6 November" });
    const journal = (await call("GET", `/v1/wiki/pages/${note.parent_id}`)).body as WikiPage;
    expect(journal).toMatchObject({ journal: true, private: true, icon: "📓", title: "Journal" });
    expect(journal.children.map((c) => c.id)).toEqual([day2.id, note.id]);
    const days = (await call("GET", "/v1/wiki/daily?from=2026-11-01&to=2026-11-30")).body.data as WikiDailyNote[];
    expect(days).toEqual([
      { date: "2026-11-06", id: note.id },
      { date: "2026-11-07", id: day2.id },
    ]);
    expect((await call("POST", "/v1/wiki/daily", { date: "2026-02-30", title: "x" })).status).toBe(422);
    const elsewhere = (await tree()).find((n) => !n.private)!;
    expect((await call("POST", `/v1/wiki/pages/${journal.id}/move`, { parent_id: elsewhere.id, position: 0 })).body.code).toBe("journal_fixed");
    const other = db.workspaces[0].members.find((m) => m.user_id !== db.meId && m.role !== "viewer")!.user_id;
    await as(other, async () => expect((await call("GET", `/v1/wiki/pages/${note.id}`)).status).toBe(404));
  });

  it("verifies a page without a new version and takes the verification away", async () => {
    const seeded = (await tree()).find((n) => n.title === "Escalation process")!;
    expect(seeded.verified).toBe(true);
    const p = (await call("POST", "/v1/wiki/pages", { title: "To verify" })).body as WikiPage;
    const v = (await call("PATCH", `/v1/wiki/pages/${p.id}`, { verified: true, verified_days: 90 })).body as WikiPage;
    expect(v.version).toBe(p.version);
    expect(v.verification).toMatchObject({ by: { id: db.meId }, expired: false });
    expect(Date.parse(v.verification!.until!) - Date.parse(v.verification!.at)).toBe(90 * 24 * 3600 * 1000);
    expect((await call("GET", `/v1/wiki/pages/${p.id}/revisions`)).body.data).toHaveLength(1);
    expect((await tree()).find((n) => n.id === p.id)?.verified).toBe(true);
    expect((await call("PATCH", `/v1/wiki/pages/${p.id}`, { verified_days: 5 })).status).toBe(422);
    const off = (await call("PATCH", `/v1/wiki/pages/${p.id}`, { verified: false })).body as WikiPage;
    expect(off.verification).toBeNull();
    expect((await tree()).find((n) => n.id === p.id)?.verified).toBeUndefined();
  });
});

describe("mock wiki databases", () => {
  installMock();

  const ws = () => db.workspaces[0]!;
  const create = async (b: Record<string, unknown>) => {
    const r = await call("POST", "/v1/wiki/pages", b);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as WikiPage;
  };
  const rowsOf = async (id: string) => (await call("GET", `/v1/wiki/databases/${id}/rows`)).body as DbRows;
  const schema = (customers: string, extra: DbProperty[] = []): Database => ({
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "status",
        name: "Status",
        type: "status",
        options: [
          { id: "open", name: "Open", color: "blue" },
          { id: "done", name: "Done", color: "green" },
        ],
        groups: [
          { id: "todo", option_ids: ["open"] },
          { id: "done", option_ids: ["done"] },
        ],
      },
      { id: "tags", name: "Tags", type: "multi_select", options: [{ id: "ui", name: "UI", color: "pink" }] },
      { id: "points", name: "Points", type: "number", number_format: "number" },
      { id: "due", name: "Due", type: "date" },
      { id: "owner", name: "Owner", type: "person" },
      { id: "link", name: "Link", type: "url" },
      { id: "note", name: "Note", type: "text" },
      { id: "done", name: "Done", type: "checkbox" },
      { id: "ticket", name: "Ticket", type: "ticket" },
      { id: "customer", name: "Customer", type: "relation", database_id: customers },
      { id: "count", name: "Customers", type: "rollup", rollup: { relation: "customer", property: "title", fn: "count" } },
      { id: "score", name: "Score", type: "formula", formula: 'prop("Points") * 2' },
      ...extra,
    ],
    views: [
      { id: "table", name: "All", type: "table" },
      { id: "board", name: "Board", type: "board", settings: { group_by: "status" } },
    ],
    next_id: 1,
  });
  /** A ticket of the workspace the person sees, and one of a private team they aren't on. */
  const tickets = () => {
    const hidden = new Set(ws().teams.filter((t) => t.private && !t.members.some((m) => m.user_id === db.meId)).map((t) => t.id));
    return { seen: ws().tickets.find((t) => !t.team_id || !hidden.has(t.team_id))!.id, hidden: ws().tickets.find((t) => t.team_id && hidden.has(t.team_id))?.id };
  };

  it("creates a database with a title and tags in a table, and only with kind database", async () => {
    const d = await create({ title: "Bugs", kind: "database" });
    expect(d).toMatchObject({ kind: "database", props: {} });
    expect(d.database).toEqual({
      properties: [
        { id: "title", name: "Name", type: "title" },
        { id: "tags", name: "Tags", type: "multi_select" },
      ],
      views: [{ id: "table", name: "Table", type: "table" }],
      next_id: 1,
    });
    expect((await tree()).find((n) => n.id === d.id)?.kind).toBe("database");
    const page = await create({ title: "Plain" });
    expect(page).toMatchObject({ kind: "page", database: null, props: {} });
    expect(await call("POST", "/v1/wiki/pages", { title: "x", database: d.database })).toMatchObject({ status: 422, body: { code: "invalid_database" } });
    expect((await call("POST", "/v1/wiki/pages", { title: "x", kind: "sheet" })).status).toBe(422);
    expect(await call("POST", "/v1/wiki/pages", { title: "x", props: { tags: [] } })).toMatchObject({ status: 422, body: { code: "invalid_database" } });
    // A schema given at creation is checked like a PATCH's.
    const customers = await create({ title: "Customers", kind: "database" });
    const made = await create({ title: "Bugs 2", kind: "database", database: schema(customers.id) });
    expect(made.database?.properties).toHaveLength(13);
    expect((await call("POST", "/v1/wiki/pages", { title: "x", kind: "database", database: { properties: [], views: [] } })).body.code).toBe("invalid_database");
  });

  it("replaces a schema without a new version and refuses one that breaks the rules", async () => {
    const customers = await create({ title: "Customers", kind: "database" });
    const d = await create({ title: "Bugs", kind: "database" });
    const s = schema(customers.id);
    const ok = (await call("PATCH", `/v1/wiki/pages/${d.id}`, { database: { ...s, properties: s.properties.map((p) => (p.id === "points" ? { ...p, name: "  Story   points " } : p)) } })).body as WikiPage;
    expect(ok.version).toBe(d.version);
    expect(ok.database?.properties.find((p) => p.id === "points")?.name).toBe("Story points");
    expect(ok.database?.views[1]?.settings).toEqual({ group_by: "status" });
    const title: DbProperty = { id: "title", name: "N", type: "title" };
    const views = s.views;
    const bad: unknown[] = [
      { properties: [{ id: "x", name: "X", type: "text" }], views },
      { properties: [title, { id: "t2", name: "N2", type: "title" }], views },
      { properties: [title, { id: "x", name: "X", type: "magic" }], views },
      { properties: [title, { id: "r", name: "R", type: "rollup", rollup: { relation: "title", property: "x", fn: "count" } }], views },
      { properties: [title, { id: "r", name: "R", type: "rollup", rollup: { relation: "title", property: "x", fn: "guess" } }], views },
      { properties: [title], views: [] },
      { properties: [title, { id: "Bad id", name: "X", type: "text" }], views },
      { properties: [title, { id: "x", name: "X", type: "text" }, { id: "x", name: "Y", type: "text" }], views },
      { properties: [title, { id: "x", name: "   ", type: "text" }], views },
      { properties: [title, { id: "s", name: "S", type: "select", options: [{ id: "a", name: "A", color: "teal" }] }], views },
      { properties: [title, { id: "s", name: "S", type: "status", options: [{ id: "a", name: "A", color: "red" }], groups: [{ id: "later", option_ids: ["a"] }] }], views },
      { properties: [title, { id: "s", name: "S", type: "status", options: [{ id: "a", name: "A", color: "red" }], groups: [{ id: "todo", option_ids: ["b"] }] }], views },
      { properties: [title, { id: "n", name: "N", type: "number", number_format: "roman" }], views },
      { properties: [title, { id: "r", name: "R", type: "relation" }], views },
      { properties: [title, { id: "p", name: "P", type: "unique_id", prefix: "TOOLONGPREFIX" }], views },
      { properties: [title], views: [{ id: "v", name: "V", type: "kanban" }] },
      { properties: [title], views: [{ id: "v", name: "V", type: "table" }, { id: "v", name: "W", type: "list" }] },
      { properties: [{ ...title, name: 5 }], views },
      { properties: "title", views },
    ];
    for (const b of bad) expect(await call("PATCH", `/v1/wiki/pages/${d.id}`, { database: b }), JSON.stringify(b)).toMatchObject({ status: 422, body: { code: "invalid_database" } });
    // A schema goes with a database only; a viewer reads it and no more.
    const page = await create({ title: "Plain" });
    expect((await call("PATCH", `/v1/wiki/pages/${page.id}`, { database: s })).body.code).toBe("invalid_database");
    const me = ws().members.find((m) => m.user_id === db.meId)!;
    const role = me.role;
    me.role = "viewer";
    try {
      expect((await call("PATCH", `/v1/wiki/pages/${d.id}`, { database: s })).status).toBe(403);
      expect((await call("GET", `/v1/wiki/databases/${d.id}/rows`)).status).toBe(200);
    } finally {
      me.role = role;
    }
  });

  it("checks a row's values against their properties and the workspace", async () => {
    const customers = await create({ title: "Customers", kind: "database" });
    const acme = await create({ title: "Acme", parent_id: customers.id });
    const d = await create({ title: "Bugs", kind: "database", database: schema(customers.id) });
    const { seen, hidden } = tickets();
    const row = await create({
      title: "Login fails",
      parent_id: d.id,
      body_html: "<p>Steps to reproduce: open the app.</p>",
      props: {
        status: "open",
        tags: ["ui", "ui"],
        points: 3,
        due: { start: "2026-11-10", end: "2026-11-12T09:30:00Z" },
        owner: [db.meId.toUpperCase()],
        link: " https://example.com/bug ",
        done: false,
        ticket: [seen],
        customer: [acme.id],
      },
    });
    expect(row.props).toEqual({
      status: "open",
      tags: ["ui"],
      points: 3,
      due: { start: "2026-11-10", end: "2026-11-12T09:30:00Z" },
      owner: [db.meId],
      link: "https://example.com/bug",
      done: false,
      ticket: [seen],
      customer: [acme.id],
    });
    const stranger = db.workspaces[1]!.members.find((m) => !ws().members.some((x) => x.user_id === m.user_id))?.user_id ?? "00000000-0000-4000-8000-000000000000";
    const bad: Record<string, unknown>[] = [
      { status: "nope" },
      { tags: ["nope"] },
      { tags: "ui" },
      { points: "three" },
      { due: { start: "tomorrow" } },
      { due: { start: "2026-02-30" } },
      { due: "2026-11-10" },
      { owner: [`${db.meId}x`] },
      { owner: [stranger] },
      { link: "javascript:alert(1)" },
      { note: "x".repeat(10001) },
      { done: "yes" },
      { customer: [d.id] },
      { customer: [row.id] },
      { ticket: ["00000000-0000-4000-8000-000000000000"] },
      ...(hidden ? [{ ticket: [hidden] }] : []),
      { score: 1 },
      { count: 1 },
      { title: "x" },
      { nothing: 1 },
    ];
    for (const p of bad) expect(await call("PATCH", `/v1/wiki/pages/${row.id}`, { props: p }), JSON.stringify(p)).toMatchObject({ status: 422, body: { code: "invalid_database" } });
    expect(await call("POST", "/v1/wiki/pages", { title: "x", parent_id: d.id, props: { status: "nope" } })).toMatchObject({ status: 422, body: { code: "invalid_database" } });
    // A related page in the trash is no row to name.
    const gone = await create({ title: "Gone", parent_id: customers.id });
    await call("POST", `/v1/wiki/pages/${gone.id}/trash`);
    expect((await call("PATCH", `/v1/wiki/pages/${row.id}`, { props: { customer: [gone.id] } })).status).toBe(422);
    // Values go with rows only.
    expect((await call("PATCH", `/v1/wiki/pages/${d.id}`, { props: { status: "open" } })).body.code).toBe("invalid_database");
  });

  it("merges a change, takes a null value away and moves no version", async () => {
    const d = await create({ title: "Bugs", kind: "database", database: schema((await create({ title: "C", kind: "database" })).id) });
    const row = await create({ title: "Row", parent_id: d.id, props: { status: "open", points: 3, link: "https://example.com" } });
    const merged = (await call("PATCH", `/v1/wiki/pages/${row.id}`, { props: { status: "done", link: null, note: "  " } })).body as WikiPage;
    expect(merged.props).toEqual({ status: "done", points: 3, note: null });
    expect(merged.version).toBe(row.version);
    expect((await call("GET", `/v1/wiki/pages/${row.id}/revisions`)).body.data).toHaveLength(1);
    // A property the schema no longer has loses its values at the row's next change.
    await call("PATCH", `/v1/wiki/pages/${d.id}`, { database: { ...d.database!, properties: d.database!.properties.filter((p) => p.id !== "points") } });
    expect(((await call("PATCH", `/v1/wiki/pages/${row.id}`, { props: { done: true } })).body as WikiPage).props).toEqual({ status: "done", note: null, done: true });
  });

  it("numbers rows with unique ids on create, when one is added later and when a row is copied in", async () => {
    const customers = await create({ title: "Customers", kind: "database" });
    const d = await create({ title: "Bugs", kind: "database", database: schema(customers.id) });
    const first = await create({ title: "First", parent_id: d.id });
    await create({ title: "Second", parent_id: d.id });
    // Rows already there are numbered oldest first, whatever their order; new rows count on.
    await call("POST", `/v1/wiki/pages/${first.id}/move`, { parent_id: d.id, position: 1 });
    const s = schema(customers.id, [{ id: "num", name: "ID", type: "unique_id", prefix: "BUG" }]);
    const patched = (await call("PATCH", `/v1/wiki/pages/${d.id}`, { database: s })).body as WikiPage;
    expect(patched.database?.next_id).toBe(3);
    const third = await create({ title: "Third", parent_id: d.id });
    expect(third.props.num).toBe(3);
    const rows = await rowsOf(d.id);
    expect(rows.data.map((r) => [r.title, r.props.num])).toEqual([
      ["Second", 2],
      ["First", 1],
      ["Third", 3],
    ]);
    expect((await call("PATCH", `/v1/wiki/pages/${third.id}`, { props: { num: 9 } })).body.code).toBe("invalid_database");
    // Sending the schema again leaves the numbers and the counter as they are.
    expect(((await call("PATCH", `/v1/wiki/pages/${d.id}`, { database: { ...s, next_id: 1 } })).body as WikiPage).database?.next_id).toBe(4);
    // A copy in the database is a new row with its own number; a copy elsewhere is a page without values.
    await call("PATCH", `/v1/wiki/pages/${third.id}`, { props: { status: "open" } });
    const again = (await call("POST", `/v1/wiki/pages/${third.id}/duplicate`, { parent_id: d.id, title: "Third again" })).body as WikiPage;
    expect(again.props).toEqual({ status: "open", num: 4 });
    const out = (await call("POST", `/v1/wiki/pages/${third.id}/duplicate`, { parent_id: null })).body as WikiPage;
    expect(out.props).toEqual({});
  });

  it("lists a database's rows with their values and excerpts, its templates apart", async () => {
    const issues = (await tree()).find((n) => n.title === "Known issues")!;
    expect(issues.kind).toBe("database");
    const rows = await rowsOf(issues.id);
    expect(rows.data).toHaveLength(10);
    expect(rows.templates.map((t) => t.title)).toEqual(["New issue"]);
    expect(rows.data.map((r) => r.position)).toEqual(rows.data.map((_, i) => i));
    expect(rows.data.map((r) => r.props.issue_id).sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const sso = rows.data[0]!;
    expect(sso).toMatchObject({ title: "SSO sign-in loops back to the login page", props: { status: "fixing", severity: "critical" }, cover: "", cover_y: expect.any(Number), created_at: expect.any(String) });
    expect(sso.created_by?.id).toBeTruthy();
    expect(sso.excerpt.startsWith("Symptoms After a successful Okta")).toBe(true);
    expect([...sso.excerpt].length).toBeLessThanOrEqual(281);
    expect(sso.excerpt.endsWith("…")).toBe(true);
    expect((sso.props.ticket as string[]).length).toBe(1);
    expect(rows.data.some((r) => r.excerpt === "")).toBe(true);
    // The schema shows off every view, a relation to the key accounts and a rollup through it.
    const page = (await call("GET", `/v1/wiki/pages/${issues.id}`)).body as WikiPage;
    expect(page.database?.views.map((v) => v.type)).toEqual(["table", "board", "timeline", "calendar", "gallery", "chart"]);
    const accounts = (await tree()).find((n) => n.title === "Key accounts")!;
    expect(page.database?.properties.find((p) => p.type === "relation")?.database_id).toBe(accounts.id);
    expect((await rowsOf(accounts.id)).data).toHaveLength(5);
    // Every seeded value passes the API's checks.
    for (const r of [...rows.data, ...(await rowsOf(accounts.id)).data]) {
      const { issue_id: _n, ...values } = r.props;
      expect((await call("PATCH", `/v1/wiki/pages/${r.id}`, { props: values })).status, r.title).toBe(200);
    }
    // The handbook links to it, so the backlinks show it.
    const handbook = (await tree()).find((n) => n.title === "Support handbook")!;
    expect(ids((await call("GET", `/v1/wiki/pages/${issues.id}/backlinks`)).body.data)).toContain(handbook.id);
    // A page that isn't a database has no rows.
    expect((await call("GET", `/v1/wiki/databases/${handbook.id}/rows`)).status).toBe(404);
  });

  it("duplicates a database with its rows, their values pointing at the copies", async () => {
    const d = await create({ title: "Tasks", kind: "database" });
    // A relation of the database to itself: the copy relates to its own rows.
    const s: Database = { ...d.database!, properties: [...d.database!.properties, { id: "blocked", name: "Blocked by", type: "relation", database_id: d.id }, { id: "num", name: "ID", type: "unique_id" }] };
    await call("PATCH", `/v1/wiki/pages/${d.id}`, { database: s });
    const a = await create({ title: "A", parent_id: d.id });
    const b = await create({ title: "B", parent_id: d.id, props: { blocked: [a.id] } });
    expect(b.props).toEqual({ blocked: [a.id], num: 2 });
    const copy = await call("POST", `/v1/wiki/pages/${d.id}/duplicate`, { title: "Tasks copy" });
    expect(copy.status).toBe(201);
    const c = copy.body as WikiPage;
    expect(c).toMatchObject({ kind: "database", title: "Tasks copy" });
    expect(c.database?.next_id).toBe(3);
    expect(c.database?.properties.find((p) => p.id === "blocked")?.database_id).toBe(c.id);
    const rows = await rowsOf(c.id);
    expect(rows.data.map((r) => r.title)).toEqual(["A", "B"]);
    const [ca, cb] = rows.data;
    expect(cb!.props).toEqual({ blocked: [ca!.id], num: 2 });
    expect(ca!.props.num).toBe(1);
    expect((await rowsOf(d.id)).data.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("keeps form views, and sub-items and dependencies naming two relations of the database to itself", async () => {
    const d = await create({ title: "Tasks", kind: "database" });
    const customers = await create({ title: "Customers", kind: "database" });
    const rel = (id: string, name: string, target = d.id): DbProperty => ({ id, name, type: "relation", database_id: target });
    const props: DbProperty[] = [{ id: "title", name: "Name", type: "title" }, rel("parent", "Parent item"), rel("subs", "Sub-items"), rel("blocked", "Blocked by"), rel("blocking", "Blocking"), rel("customer", "Customer", customers.id)];
    const views: Database["views"] = [
      { id: "table", name: "Table", type: "table" },
      { id: "form", name: "Report", type: "form", settings: { form: { title: "Report a task", fields: [{ property: "title", required: true }, { property: "customer", help: "Who asked" }], submitted: "Thanks" } } },
    ];
    const good: Database = { properties: props, views, next_id: 1, sub_items: { parent: "parent", children: "subs" }, dependencies: { blocked_by: "blocked", blocking: "blocking" } };
    const saved = (await call("PATCH", `/v1/wiki/pages/${d.id}`, { database: good })).body as WikiPage;
    expect(saved.database).toMatchObject({ sub_items: good.sub_items, dependencies: good.dependencies });
    expect(saved.database?.views[1]).toEqual(views[1]);

    for (const bad of [
      { sub_items: { parent: "parent", children: "parent" } },
      { sub_items: { parent: "parent", children: "title" } },
      { sub_items: { parent: "parent", children: "nothing" } },
      { sub_items: { parent: "parent", children: "customer" } },
      { sub_items: { parent: "parent", children: "subs" }, dependencies: { blocked_by: "subs", blocking: "blocking" } },
      { views: [{ id: "x", name: "X", type: "survey" }] },
    ])
      expect(await call("PATCH", `/v1/wiki/pages/${d.id}`, { database: { properties: props, views, next_id: 1, ...bad } }), JSON.stringify(bad)).toMatchObject({ status: 422, body: { code: "invalid_database" } });

    // One parent item at most; sub-items and dependencies take many; rows of this database only.
    const a = await create({ title: "A", parent_id: d.id });
    const b = await create({ title: "B", parent_id: d.id });
    const c = await create({ title: "C", parent_id: d.id, props: { parent: [a.id], blocked: [a.id, b.id] } });
    expect(c.props).toEqual({ parent: [a.id], blocked: [a.id, b.id] });
    expect((await call("PATCH", `/v1/wiki/pages/${c.id}`, { props: { parent: [a.id, b.id] } })).status).toBe(422);
    expect((await call("PATCH", `/v1/wiki/pages/${a.id}`, { props: { subs: [b.id, c.id] } })).status).toBe(200);
    expect((await call("PATCH", `/v1/wiki/pages/${a.id}`, { props: { subs: [customers.id] } })).status).toBe(422);
  });
});

const tree = async () => (await call("GET", "/v1/wiki/pages")).body.data as WikiNode[];
const ids = (list: { id: string }[]) => list.map((n) => n.id);

/** Runs fn as another member of the workspace, then signs the mock's person back in. */
async function as<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const me = db.meId;
  db.meId = userId;
  try {
    return await fn();
  } finally {
    db.meId = me;
  }
}

describe("mock wiki comments", () => {
  installMock();

  const ws = () => db.workspaces[0];
  const pageNamed = async (title: string) => ((await call("GET", "/v1/wiki/pages")).body.data as WikiNode[]).find((n) => n.title === title)!;
  const comments = async (id: string) => (await call("GET", `/v1/wiki/pages/${id}/comments`)).body as WikiComments;
  const mention = (uid: string) => `<span data-type="mention" data-id="${uid}" class="mention">@x</span>`;
  /** Notifications published since mark, as [type, user]. */
  const told = (mark: number) =>
    ws()
      .events.slice(mark)
      .filter((e) => e.type === "notification.created")
      .map((e) => [(e.data.notification as Notification).type, e.topics?.find((x) => x.startsWith("user:"))?.slice(5)])
      // The mock's own activity sends other notifications on a timer.
      .filter(([type]) => type?.startsWith("wiki_"));
  const asRole = async <T,>(role: "viewer" | "agent", fn: () => Promise<T>) => {
    const me = ws().members.find((m) => m.user_id === db.meId)!;
    const was = me.role;
    me.role = role;
    try {
      return await fn();
    } finally {
      me.role = was;
    }
  };

  it("seeds threads: one inline on marked text, one on the page, one resolved, with reactions", async () => {
    const esc = await pageNamed("Escalation process");
    const page = (await call("GET", `/v1/wiki/pages/${esc.id}`)).body as WikiPage;
    const { data, following } = await comments(esc.id);
    expect(following).toBe(false);
    const inline = data.find((t) => t.inline)!;
    expect(inline.quote).toBe("money is at stake");
    expect(page.body_html).toContain(`<span data-comment="${inline.id}">money is at stake</span>`);
    expect(inline.comments).toHaveLength(2);
    expect(inline.comments[0].reactions[0]).toMatchObject({ emoji: "👍" });
    expect(data.some((t) => !t.inline && !t.resolved_at)).toBe(true);
    const refunds = await comments((await pageNamed("Refund policy")).id);
    expect(refunds.data[0]).toMatchObject({ inline: true, quote: "no questions asked", resolved_by: { id: db.meId } });
  });

  it("starts threads and replies, checks what is sent and reopens a resolved thread with a reply", async () => {
    const p = (await call("POST", "/v1/wiki/pages", { title: "Discussed" })).body as WikiPage;
    expect((await call("POST", `/v1/wiki/pages/${p.id}/comments`, { body_html: "<p> </p>" })).status).toBe(422);
    expect((await call("POST", `/v1/wiki/pages/${p.id}/comments`, { body_html: "<p>x</p>", inline: true })).status).toBe(422);
    const made = await call("POST", `/v1/wiki/pages/${p.id}/comments`, { body_html: "<p>On this <script>x()</script>bit</p>", quote: "  the   bit ", inline: true });
    expect(made.status).toBe(201);
    const t = made.body as WikiThread;
    expect(t).toMatchObject({ page_id: p.id, inline: true, quote: "the bit", resolved_at: null });
    expect(t.comments[0].body_html).not.toContain("script");
    expect((await call("POST", `/v1/wiki/threads/${t.id}/resolve`, { resolved: true })).body).toMatchObject({ resolved_by: { id: db.meId } });
    const reply = (await call("POST", `/v1/wiki/pages/${p.id}/comments`, { body_html: "<p>Back to it</p>", thread_id: t.id })).body as WikiThread;
    expect(reply.resolved_at).toBeNull();
    expect(reply.comments.map((c) => c.body_html)).toEqual(["<p>On this bit</p>", "<p>Back to it</p>"]);
    // A thread of another page is not one to reply to.
    const other = (await call("POST", "/v1/wiki/pages", { title: "Elsewhere" })).body as WikiPage;
    expect((await call("POST", `/v1/wiki/pages/${other.id}/comments`, { body_html: "<p>x</p>", thread_id: t.id })).status).toBe(422);
  });

  it("lets only the author edit, the author or an admin delete, and the first comment takes the thread", async () => {
    const esc = await pageNamed("Escalation process");
    const theirs = (await comments(esc.id)).data.find((t) => t.inline)!;
    expect(theirs.comments[0].author?.id).not.toBe(db.meId);
    expect((await call("PATCH", `/v1/wiki/comments/${theirs.comments[0].id}`, { body_html: "<p>mine now</p>" })).status).toBe(403);
    expect((await asRole("agent", () => call("DELETE", `/v1/wiki/comments/${theirs.comments[1].id}`))).status).toBe(403);
    // The mock person is the owner: an admin deletes anyone's.
    expect((await call("DELETE", `/v1/wiki/comments/${theirs.comments[1].id}`)).status).toBe(204);
    const p = (await call("POST", "/v1/wiki/pages", { title: "Edits" })).body as WikiPage;
    const t = (await call("POST", `/v1/wiki/pages/${p.id}/comments`, { body_html: "<p>first</p>" })).body as WikiThread;
    const edited = (await call("PATCH", `/v1/wiki/comments/${t.id}`, { body_html: "<p>first, better</p>" })).body as WikiThread;
    expect(edited.comments[0]).toMatchObject({ body_html: "<p>first, better</p>", edited_at: expect.any(String) });
    await call("POST", `/v1/wiki/pages/${p.id}/comments`, { body_html: "<p>reply</p>", thread_id: t.id });
    expect((await call("DELETE", `/v1/wiki/comments/${t.id}`)).status).toBe(204);
    expect((await comments(p.id)).data).toEqual([]);
  });

  it("toggles reactions, one emoji at a time, oldest first", async () => {
    const p = (await call("POST", "/v1/wiki/pages", { title: "Reacted" })).body as WikiPage;
    const t = (await call("POST", `/v1/wiki/pages/${p.id}/comments`, { body_html: "<p>hi</p>" })).body as WikiThread;
    const id = t.comments[0].id;
    for (const emoji of ["👍👍", "ab", ""]) expect((await call("POST", `/v1/wiki/comments/${id}/reactions`, { emoji, on: true })).status, emoji).toBe(422);
    await call("POST", `/v1/wiki/comments/${id}/reactions`, { emoji: "🎉", on: true });
    await call("POST", `/v1/wiki/comments/${id}/reactions`, { emoji: "🎉", on: true });
    const on = (await call("POST", `/v1/wiki/comments/${id}/reactions`, { emoji: "👍", on: true })).body as WikiThread;
    expect(on.comments[0].reactions).toEqual([
      { emoji: "🎉", users: [db.meId] },
      { emoji: "👍", users: [db.meId] },
    ]);
    const off = (await call("POST", `/v1/wiki/comments/${id}/reactions`, { emoji: "🎉", on: false })).body as WikiThread;
    expect(off.comments[0].reactions).toEqual([{ emoji: "👍", users: [db.meId] }]);
    // Up to 20 different ones; one already there still toggles.
    const twenty = ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🙂", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙", "🥲"];
    for (const emoji of twenty) expect((await call("POST", `/v1/wiki/comments/${id}/reactions`, { emoji, on: true })).status, emoji).toBeLessThan(300);
    expect((await call("POST", `/v1/wiki/comments/${id}/reactions`, { emoji: "🎉", on: true })).body).toMatchObject({ code: "validation_failed", detail: expect.stringContaining("20 different") });
    expect((await call("POST", `/v1/wiki/comments/${id}/reactions`, { emoji: "👍", on: false })).status).toBeLessThan(300);
    expect((await call("POST", `/v1/wiki/comments/${id}/reactions`, { emoji: "👍", on: true })).status).toBeLessThan(300);
  });

  it("lets viewers read and follow but not write, and keeps a page in the trash read-only", async () => {
    const p = (await call("POST", "/v1/wiki/pages", { title: "Quiet" })).body as WikiPage;
    const t = (await call("POST", `/v1/wiki/pages/${p.id}/comments`, { body_html: "<p>hi</p>" })).body as WikiThread;
    await asRole("viewer", async () => {
      expect((await call("GET", `/v1/wiki/pages/${p.id}/comments`)).status).toBe(200);
      expect((await call("POST", `/v1/wiki/pages/${p.id}/comments`, { body_html: "<p>x</p>" })).status).toBe(403);
      expect((await call("POST", `/v1/wiki/threads/${t.id}/resolve`, { resolved: true })).status).toBe(403);
      // Following is a reader's choice.
      expect((await call("PUT", `/v1/wiki/pages/${p.id}/follow`, { following: false })).body).toEqual({ following: false });
    });
    await call("POST", `/v1/wiki/pages/${p.id}/trash`);
    expect((await comments(p.id)).data).toHaveLength(1);
    expect((await call("POST", `/v1/wiki/pages/${p.id}/comments`, { body_html: "<p>x</p>" })).body.code).toBe("page_in_trash");
    expect((await call("PUT", `/v1/wiki/pages/${p.id}/follow`, { following: false })).body.code).toBe("page_in_trash");
  });

  it("follows pages people make or comment on, until they unfollow", async () => {
    const esc = await pageNamed("Escalation process");
    expect((await comments(esc.id)).following).toBe(false);
    await call("POST", `/v1/wiki/pages/${esc.id}/comments`, { body_html: "<p>me too</p>" });
    expect((await comments(esc.id)).following).toBe(true);
    expect((await call("PUT", `/v1/wiki/pages/${esc.id}/follow`, { following: false })).body).toEqual({ following: false });
    await call("POST", `/v1/wiki/pages/${esc.id}/comments`, { body_html: "<p>and again</p>" });
    expect((await comments(esc.id)).following).toBe(false);
    const mine = (await call("POST", "/v1/wiki/pages", { title: "Mine" })).body as WikiPage;
    expect((await comments(mine.id)).following).toBe(true);
    expect((await call("PUT", `/v1/wiki/pages/${mine.id}/follow`, { following: "yes" })).status).toBe(422);
  });

  it("notifies who a comment mentions, then followers and the thread's people, once each, and publishes the change", async () => {
    const esc = await pageNamed("Escalation process");
    const thread = (await comments(esc.id)).data.find((t) => t.inline)!;
    const first = thread.comments[0].author!.id;
    const second = ws().members.find((m) => m.user_id !== db.meId && m.user_id !== first && m.role !== "viewer")!.user_id;
    const mark = ws().events.length;
    await call("POST", `/v1/wiki/pages/${esc.id}/comments`, { body_html: `<p>Agreed ${mention(second)}</p>`, thread_id: thread.id });
    const got = told(mark);
    expect(got).toContainEqual(["wiki_mention", second]);
    expect(got).toContainEqual(["wiki_comment", first]);
    expect(got.filter(([, u]) => u === second)).toHaveLength(1);
    expect(got.some(([, u]) => u === db.meId)).toBe(false);
    const change = ws().events.slice(mark).find((e) => e.type === "wiki_comment.changed")!;
    expect(change.data).toEqual({ page_id: esc.id, thread_id: thread.id });
    const n = ws().events.slice(mark).find((e) => e.type === "notification.created")!.data.notification as Notification;
    expect(n.data).toMatchObject({ page_id: esc.id, page_title: "Escalation process", thread_id: thread.id, by: db.meId });
  });

  it("notifies someone newly mentioned in a page's text, not again on the next save", async () => {
    const other = ws().members.find((m) => m.user_id !== db.meId && m.role !== "viewer")!.user_id;
    const p = (await call("POST", "/v1/wiki/pages", { title: "Mentions" })).body as WikiPage;
    let mark = ws().events.length;
    const a = (await call("PATCH", `/v1/wiki/pages/${p.id}`, { body_html: `<p>${mention(other)}</p>` })).body as WikiPage;
    expect(told(mark)).toEqual([["wiki_mention", other]]);
    mark = ws().events.length;
    await call("PATCH", `/v1/wiki/pages/${p.id}`, { body_html: `<p>${mention(other)} again</p>`, version: a.version });
    expect(told(mark)).toEqual([]);
  });

  it("refetches a page's comments on wiki_comment.changed", () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.wikiComments("p1"), { data: [], following: false });
    applyWikiCommentEvent(qc, { page_id: "p1", thread_id: "t1" });
    expect(qc.getQueryState(qk.wikiComments("p1"))?.isInvalidated).toBe(true);
  });
});

describe("wiki events on the cache", () => {
  const node = (id: string, parent: string | null, position: number, version = 1): WikiNode => ({ id, parent_id: parent, title: id, icon: "", position, version, updated_at: "2026-10-01T00:00:00Z", created_by_id: null, tags: [] });

  it("patches the tree, refetches a page someone else changed and drops deleted subpages", () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.wikiTree, [node("a", null, 0), node("b", "a", 0)]);
    qc.setQueryData(qk.wikiPage("a"), { ...node("a", null, 0), body_html: "" });
    applyWikiEvent(qc, "created", { wiki_page: node("c", null, 1), updated_by: null });
    expect(qc.getQueryData<WikiNode[]>(qk.wikiTree)?.map((n) => n.id)).toEqual(["a", "b", "c"]);
    applyWikiEvent(qc, "updated", { wiki_page: { ...node("a", null, 0, 2), title: "Renamed" }, updated_by: { id: "other" } });
    expect(qc.getQueryData<WikiNode[]>(qk.wikiTree)?.[0]?.title).toBe("Renamed");
    expect(qc.getQueryState(qk.wikiPage("a"))?.isInvalidated).toBe(true);
    applyWikiEvent(qc, "deleted", { wiki_page_id: "a", wiki_page_ids: ["a", "b"] });
    expect(qc.getQueryData<WikiNode[]>(qk.wikiTree)).toEqual([node("c", null, 0)]);
    expect(qc.getQueryData(qk.wikiPage("a"))).toBeUndefined();
  });

  it("refetches the person's own change made elsewhere, not the save this tab made", () => {
    const qc = new QueryClient();
    const page = { ...DEFAULT_LOOK, ...node("a", null, 0), body_html: "", breadcrumbs: [], children: [], created_at: "", created_by: null, updated_by: null, verification: null, deleted_at: null, deleted_by: null, kind: "page", database: null, props: {} } as WikiPage;
    qc.setQueryData(qk.wikiPage("a"), page);
    const saver = saverFor(page);
    // This tab saved version 2: the saver knows it, nothing to refetch.
    saver.version = 2;
    applyWikiEvent(qc, "updated", { wiki_page: node("a", null, 0, 2), updated_by: { id: "me" } });
    expect(qc.getQueryState(qk.wikiPage("a"))?.isInvalidated).toBe(false);
    // The same person in another tab (or Ollie) saved version 3: refetched.
    applyWikiEvent(qc, "updated", { wiki_page: node("a", null, 0, 3), updated_by: { id: "me" } });
    expect(qc.getQueryState(qk.wikiPage("a"))?.isInvalidated).toBe(true);
    resetSavers();
  });
});

// ─── Ticket backlinks (GET /v1/tickets/{id}/wiki) ──────────────────────────

describe("mock ticket wiki pages", () => {
  installMock();

  it("lists the live pages the caller may see that mention a ticket, newest edit first", async () => {
    const ws = db.workspaces[0];
    const hiddenTeams = new Set(ws.teams.filter((t) => t.private && !t.members.some((m) => m.user_id === db.meId)).map((t) => t.id));
    const tk = ws.tickets.find((t) => !t.team_id || !hiddenTeams.has(t.team_id))!;
    const other = ws.members.find((m) => m.user_id !== db.meId)!.user_id;
    const mention = `<a data-type="ticket" data-id="${tk.id}" href="/tickets/${tk.number}">#${tk.number} ${tk.subject}</a>`;
    const pages = async (ref: string) => (await call("GET", `/v1/tickets/${ref}/wiki`)).body.data as WikiNode[];

    const older = (await call("POST", "/v1/wiki/pages", { title: "Refund runbook", body_html: `<p>See ${mention}</p>` })).body as WikiPage;
    const newer = (await call("POST", "/v1/wiki/pages", { title: "Escalation", body_html: "<p>nothing yet</p>" })).body as WikiPage;
    await call("PATCH", `/v1/wiki/pages/${newer.id}`, { body_html: `<p>${mention}</p>`, version: newer.version });
    const listed = ids(await pages(tk.id));
    expect(listed.indexOf(newer.id)).toBeLessThan(listed.indexOf(older.id));
    expect(listed.indexOf(older.id)).toBeGreaterThanOrEqual(0);
    expect(ids(await pages(encodeURIComponent(`#${tk.number}`)))).toEqual(listed);
    expect(ids(await pages(String(tk.number)))).toEqual(listed);

    // Someone else's private page stays theirs; a trashed page leaves the list.
    const theirs = await as(other, async () => (await call("POST", "/v1/wiki/pages", { title: "Theirs", space: "private", body_html: `<p>${mention}</p>` })).body as WikiPage);
    expect(ids(await pages(tk.id))).not.toContain(theirs.id);
    await as(other, async () => expect(ids(await pages(tk.id))).toContain(theirs.id));
    await call("POST", `/v1/wiki/pages/${newer.id}/trash`);
    expect(ids(await pages(tk.id))).not.toContain(newer.id);

    // A private team's ticket is not found for someone off the team, like a missing one.
    const hidden = ws.tickets.find((t) => t.team_id && hiddenTeams.has(t.team_id))!;
    expect((await call("GET", `/v1/tickets/${hidden.id}/wiki`)).status).toBe(404);
    expect((await call("GET", "/v1/tickets/999999/wiki")).status).toBe(404);
  });
});

// ─── Canvas (contracts/wiki.md "Canvas") ────────────────────────────────────

describe("mock wiki canvases", () => {
  installMock();
  const card = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, width: 240, height: 120, ...extra });

  it("seeds a canvas in the handbook, its page cards counted as links", async () => {
    const tree = (await call("GET", "/v1/wiki/pages")).body.data as WikiNode[];
    const map = tree.find((n) => n.title === "First response map")!;
    expect(map.kind).toBe("canvas");
    const page = (await call("GET", `/v1/wiki/pages/${map.id}`)).body as WikiPage;
    const ref = page.canvas!.nodes.find((n) => n.type === "page")!;
    expect(ref.type === "page" && tree.some((n) => n.id === ref.page_id)).toBe(true);
    const graph = (await call("GET", "/v1/wiki/graph")).body.data as { from: string; to: string }[];
    expect(graph.some((l) => l.from === map.id)).toBe(true);
  });

  it("makes a canvas, replaces its cards whole without a new version, and sends them live", async () => {
    const target = (await call("POST", "/v1/wiki/pages", { title: "Refunds" })).body as WikiPage;
    const made = (await call("POST", "/v1/wiki/pages", { title: "Board", kind: "canvas" })).body as WikiPage;
    expect(made.kind).toBe("canvas");
    expect(made.canvas).toEqual({ nodes: [], edges: [] });
    const canvas = {
      nodes: [card("t", "text", { html: "<p>Ship it #launch<script>x</script></p>" }), card("p", "page", { page_id: target.id }), card("g", "group", { label: " Week  one " })],
      edges: [{ id: "e", fromNode: "t", toNode: "p", fromEnd: "none", toEnd: "arrow", label: "explains" }],
    };
    const saved = (await call("PATCH", `/v1/wiki/pages/${made.id}`, { canvas })).body as WikiPage;
    expect(saved.version).toBe(made.version);
    expect(saved.canvas!.nodes[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(saved.canvas)).not.toContain("script");
    expect(saved.canvas!.nodes[2]).toMatchObject({ label: "Week one" });
    expect(saved.canvas!.edges[0]).toEqual({ id: "e", fromNode: "t", toNode: "p", label: "explains" });
    const tree = (await call("GET", "/v1/wiki/pages")).body.data as WikiNode[];
    expect(tree.find((n) => n.id === made.id)?.tags).toEqual(["launch"]);
    const back = (await call("GET", `/v1/wiki/pages/${target.id}/backlinks`)).body.data as { id: string }[];
    expect(back.map((b) => b.id)).toContain(made.id);
    const hits = (await call("GET", "/v1/wiki/search?q=explains")).body.data as WikiSearchHit[];
    expect(hits.map((h) => h.id)).toContain(made.id);

    // The cards copy with the page.
    const copy = (await call("POST", `/v1/wiki/pages/${made.id}/duplicate`, { title: "Board copy" })).body as WikiPage;
    expect(copy.kind).toBe("canvas");
    expect(copy.canvas!.nodes).toHaveLength(3);
  });

  it("refuses canvases the API refuses", async () => {
    const made = (await call("POST", "/v1/wiki/pages", { title: "Board", kind: "canvas" })).body as WikiPage;
    const plain = (await call("POST", "/v1/wiki/pages", { title: "Plain" })).body as WikiPage;
    const bad: unknown[] = [
      { nodes: [card("a b", "text")] },
      { nodes: [card("a", "text"), card("a", "text")] },
      { nodes: [card("a", "text", { x: 2e6 })] },
      { nodes: [card("a", "text", { width: 5 })] },
      { nodes: [card("a", "text", { color: "7" })] },
      { nodes: [card("a", "shape")] },
      { nodes: [card("a", "page", { page_id: "00000000-0000-4000-8000-000000000000" })] },
      { nodes: [card("a", "link", { url: "http://x.test" })] },
      { nodes: [card("a", "file", { src: "data:text/html,x", name: "x" })] },
      { nodes: [card("a", "group", { label: "x".repeat(201) })] },
      { nodes: [card("a", "text")], edges: [{ id: "e", fromNode: "a", toNode: "zz" }] },
      { nodes: [card("a", "text")], edges: [{ id: "e", fromNode: "a", toNode: "a", toSide: "middle" }] },
      { nodes: Array.from({ length: 2001 }, (_, i) => card(`n${i}`, "group")) },
    ];
    for (const canvas of bad) expect(await call("PATCH", `/v1/wiki/pages/${made.id}`, { canvas })).toMatchObject({ status: 422, body: { code: "invalid_canvas" } });
    expect((await call("PATCH", `/v1/wiki/pages/${plain.id}`, { canvas: { nodes: [], edges: [] } })).status).toBe(422);
    expect((await call("POST", "/v1/wiki/pages", { title: "x", canvas: { nodes: [], edges: [] } })).status).toBe(422);
  });

  it("puts a canvas from an event on the cached page, and refetches one too large to carry", () => {
    const qc = new QueryClient();
    const node: WikiNode = { id: "c", parent_id: null, title: "c", icon: "", position: 0, version: 1, updated_at: "2026-10-01T00:00:00Z", created_by_id: null, tags: [], kind: "canvas" };
    const page = { ...DEFAULT_LOOK, ...node, body_html: "", breadcrumbs: [], children: [], created_at: "", created_by: null, updated_by: null, verification: null, deleted_at: null, deleted_by: null, kind: "canvas", database: null, props: {}, canvas: { nodes: [], edges: [] } } as WikiPage;
    qc.setQueryData(qk.wikiPage("c"), page);
    const canvas = { nodes: [{ id: "a", type: "text", html: "<p>hi</p>", x: 0, y: 0, width: 100, height: 100 }], edges: [] };
    applyWikiEvent(qc, "updated", { wiki_page: node, updated_by: { id: "other" }, canvas });
    expect(qc.getQueryData<WikiPage>(qk.wikiPage("c"))?.canvas).toEqual(canvas);
    expect(qc.getQueryState(qk.wikiPage("c"))?.isInvalidated).toBe(false);
    applyWikiEvent(qc, "updated", { wiki_page: node, updated_by: { id: "other" }, canvas_changed: true });
    expect(qc.getQueryState(qk.wikiPage("c"))?.isInvalidated).toBe(true);
  });
});

describe("mock wiki import and export", () => {
  installMock();

  const ws = () => db.workspaces[0].workspace.id;
  async function upload(files: File[], fields: Record<string, string> = {}) {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const r = await dispatch("http://mock/v1/wiki/import", { method: "POST", body: fd, headers: { "OD-Workspace": ws() } });
    return { status: r.status, body: await r.json() };
  }
  const file = (name: string, text: string) => new File([text], name);
  async function fetchRaw(path: string) {
    return dispatch(`http://mock${path}`, { method: "GET", headers: { "OD-Workspace": ws() } });
  }

  it("makes a page per Markdown, text and HTML file under the page picked, and lists what it left out", async () => {
    const top = (await call("POST", "/v1/wiki/pages", { title: "Imported here" })).body as WikiPage;
    const res = await upload(
      [
        file("Refunds.md", "---\ntitle: Refund policy\n---\n\n## When\n\nWithin **30 days**.\n\n- one\n- two"),
        file("notes.txt", "First line.\n\nSecond paragraph."),
        file("Escalation.html", "<html><head><title>Escalations</title></head><body><h1>Escalations</h1><p>Call the lead.</p><script>alert(1)</script></body></html>"),
        file("vault.zip", "PK"),
        file("run.sh", "echo hi"),
      ],
      { parent_id: top.id },
    );
    expect(res.status).toBe(201);
    expect(res.body.pages).toBe(3);
    expect(res.body.skipped).toEqual([
      { path: "vault.zip", reason: "unsupported" },
      { path: "run.sh", reason: "executable" },
    ]);
    const pages = await Promise.all((res.body.root_ids as string[]).map(async (id) => (await call("GET", `/v1/wiki/pages/${id}`)).body as WikiPage));
    expect(pages.map((p) => [p.title, p.parent_id])).toEqual([
      ["Refund policy", top.id],
      ["notes", top.id],
      ["Escalations", top.id],
    ]);
    expect(pages[0].body_html).toContain("<h2>When</h2>");
    expect(pages[0].body_html).toContain("<strong>30 days</strong>");
    expect(pages[2].body_html).not.toContain("script");
    const tree = (await call("GET", "/v1/wiki/pages")).body.data as WikiNode[];
    expect(tree.filter((n) => n.parent_id === top.id).map((n) => n.title)).toEqual(["Refund policy", "notes", "Escalations"]);
  });

  it("puts pages at the top of the space asked for, and an Obsidian canvas as a canvas", async () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: "a", type: "text", text: "**Hello**", x: 0, y: 0, width: 200, height: 100 },
        { id: "b", type: "link", url: "https://example.com", x: 300, y: 0, width: 200, height: 100 },
        { id: "c", type: "file", file: "Notes/Elsewhere.md", x: 0, y: 300, width: 200, height: 100 },
      ],
      edges: [{ id: "e", fromNode: "a", toNode: "b" }],
    });
    const res = await upload([file("Board.canvas", canvas)], { space: "private" });
    expect(res.status).toBe(201);
    const p = (await call("GET", `/v1/wiki/pages/${res.body.root_ids[0]}`)).body as WikiPage;
    expect(p).toMatchObject({ title: "Board", kind: "canvas", private: true, parent_id: null });
    expect(p.canvas?.nodes.map((n) => n.type)).toEqual(["text", "link", "text"]);
    expect(p.canvas?.edges).toHaveLength(1);
    expect(res.body.skipped).toEqual([{ path: "Board.canvas", reason: "canvas_simplified" }]);
  });

  it("refuses what it can't import whole, and viewers", async () => {
    expect((await upload([file("vault.zip", "PK")])).body).toMatchObject({ code: "import_unsupported" });
    expect((await upload([file("app.exe", "MZ")])).body).toMatchObject({ code: "import_empty" });
    const issues = ((await call("GET", "/v1/wiki/pages")).body.data as WikiNode[]).find((n) => n.kind === "database")!;
    expect((await upload([file("a.md", "# A")], { parent_id: issues.id })).body).toMatchObject({ code: "import_into_database" });
    const me = db.workspaces[0].members.find((m) => m.user_id === db.meId)!;
    const role = me.role;
    me.role = "viewer";
    try {
      expect((await upload([file("a.md", "# A")])).status).toBe(403);
    } finally {
      me.role = role;
    }
  });

  it("exports a page as a Markdown file with the download headers", async () => {
    const p = (await call("POST", "/v1/wiki/pages", { title: "Refunds: how/why", body_html: "<p>Within <strong>30 days</strong>.</p>" })).body as WikiPage;
    const r = await fetchRaw(`/v1/wiki/pages/${p.id}/export?format=markdown`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="Refunds howwhy.md"');
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const text = await r.text();
    expect(text).toMatch(/^---\ntitle: "Refunds: how\/why"\n/);
    expect(text).toContain("Within **30 days**.");
    const html = await fetchRaw(`/v1/wiki/pages/${p.id}/export?format=html&subpages=true`);
    expect(html.headers.get("content-disposition")).toBe('attachment; filename="Refunds howwhy.html"');
    expect(await html.text()).toContain("<title>Refunds: how/why</title>");
  });

  it("exports a page with its subpages, and the whole wiki, as zips", async () => {
    const top = (await call("POST", "/v1/wiki/pages", { title: "Café" })).body as WikiPage;
    await call("POST", "/v1/wiki/pages", { title: "Menu", parent_id: top.id });
    const r = await fetchRaw(`/v1/wiki/pages/${top.id}/export?format=markdown&subpages=true`);
    expect(r.headers.get("content-type")).toBe("application/zip");
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename*=utf-8''${encodeURIComponent("Café.zip")}`);
    const zip = new Uint8Array(await r.arrayBuffer());
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const names = new TextDecoder().decode(zip);
    expect(names).toContain("Café.md");
    expect(names).toContain("Café/Menu.md");

    const all = await fetchRaw("/v1/wiki/export?format=html");
    expect(all.headers.get("content-disposition")).toMatch(/^attachment; filename="Wiki \d{4}-\d{2}-\d{2}\.zip"$/);
    expect(new TextDecoder().decode(new Uint8Array(await all.arrayBuffer()))).toContain("Support handbook.html");
    const lumen = db.workspaces[1].workspace.id;
    const empty = await dispatch("http://mock/v1/wiki/export", { method: "GET", headers: { "OD-Workspace": lumen } });
    expect(await empty.json()).toMatchObject({ code: "wiki_empty" });
  });

  it("hides a page in the trash from export", async () => {
    const p = (await call("POST", "/v1/wiki/pages", { title: "Gone soon" })).body as WikiPage;
    await call("POST", `/v1/wiki/pages/${p.id}/trash`, {});
    expect((await fetchRaw(`/v1/wiki/pages/${p.id}/export`)).status).toBe(404);
  });
});

describe("mock wiki aliases and analytics", () => {
  installMock();

  it("keeps aliases cleaned, without a new version, and finds pages by them", async () => {
    const p = (await call("POST", "/v1/wiki/pages", { title: "Chargeback policy", aliases: [" Card  disputes ", "card disputes", ""] })).body as WikiPage;
    expect(p.aliases).toEqual(["Card disputes"]);
    const saved = (await call("PATCH", `/v1/wiki/pages/${p.id}`, { aliases: ["Card disputes", "Bank reversals"] })).body as WikiPage;
    expect(saved).toMatchObject({ aliases: ["Card disputes", "Bank reversals"], version: p.version });
    expect((await call("PATCH", `/v1/wiki/pages/${p.id}`, { aliases: Array.from({ length: 11 }, (_, i) => `name ${i}`) })).status).toBe(422);
    expect((await call("PATCH", `/v1/wiki/pages/${p.id}`, { aliases: ["x".repeat(101)] })).status).toBe(422);
    const node = ((await call("GET", "/v1/wiki/pages")).body.data as WikiNode[]).find((n) => n.id === p.id);
    expect(node?.aliases).toEqual(["Card disputes", "Bank reversals"]);
    const hits = (await call("GET", "/v1/wiki/search?q=reversal")).body.data as WikiSearchHit[];
    expect(hits[0]?.id).toBe(p.id);

    const named = (await call("POST", "/v1/wiki/pages", { title: "Billing FAQ", body_html: "<p>Bank reversals take a week.</p>" })).body as WikiPage;
    const unlinked = (await call("GET", `/v1/wiki/pages/${p.id}/mentions`)).body.data as { id: string; snippet: string }[];
    expect(unlinked.find((m) => m.id === named.id)?.snippet).toContain("Bank reversals");
  });

  it("counts views per day and person, a quick reread once, and edits per day", async () => {
    const p = (await call("POST", "/v1/wiki/pages", { title: "Read me" })).body as WikiPage;
    await call("GET", `/v1/wiki/pages/${p.id}`);
    await call("GET", `/v1/wiki/pages/${p.id}`);
    const a = (await call("GET", `/v1/wiki/pages/${p.id}/analytics`)).body as WikiPageAnalytics;
    expect(a.days).toHaveLength(28);
    expect(a.days[27]).toMatchObject({ views: 1, viewers: 1 });
    expect(a).toMatchObject({ total_views: 1, total_viewers: 1 });
    expect(a.edits[27].count).toBeGreaterThan(0);
    expect((await call("GET", `/v1/wiki/pages/${p.id}/analytics?days=91`)).status).toBe(422);
    expect((await call("GET", `/v1/wiki/pages/00000000-0000-4000-8000-000000000000/analytics`)).status).toBe(404);
    // The handbook has its teammates' reads of the last weeks.
    const refunds = ((await call("GET", "/v1/wiki/pages")).body.data as WikiNode[]).find((n) => n.title === "Refund policy")!;
    expect(refunds.aliases).toContain("Money back");
    const seeded = (await call("GET", `/v1/wiki/pages/${refunds.id}/analytics`)).body as WikiPageAnalytics;
    expect(seeded.total_views).toBeGreaterThan(0);
  });

  it("keeps Pages' tree apart from the wiki's, and out of reach while Pages is off", async () => {
    const pages = (await call("GET", "/v1/wiki/pages?area=pages")).body.data as WikiNode[];
    expect(pages.some((n) => n.title === "Team home" && n.area === "pages")).toBe(true);
    expect(((await call("GET", "/v1/wiki/pages")).body.data as WikiNode[]).every((n) => n.area === "wiki")).toBe(true);
    const top = (await call("POST", "/v1/wiki/pages", { title: "Plan", area: "pages" })).body as WikiPage;
    const sub = (await call("POST", "/v1/wiki/pages", { title: "Step", parent_id: top.id, area: "wiki" })).body as WikiPage;
    expect([top.area, sub.area]).toEqual(["pages", "pages"]);
    const moved = (await call("POST", `/v1/wiki/pages/${top.id}/move`, { parent_id: null, position: 999, area: "wiki" })).body as WikiPage;
    expect(moved.area).toBe("wiki");
    expect(((await call("GET", `/v1/wiki/pages/${sub.id}`)).body as WikiPage).area).toBe("wiki");
    const hits = (await call("GET", "/v1/wiki/search?q=roadmap")).body.data as WikiSearchHit[];
    expect(hits.some((h) => h.area === "pages")).toBe(true);
    db.workspaces[0]!.workspace.settings.pages_enabled = false;
    try {
      const off = await call("GET", "/v1/wiki/pages?area=pages");
      expect([off.status, off.body.code, off.body.product]).toEqual([403, "feature_disabled", "pages"]);
      expect((await call("GET", `/v1/wiki/pages/${pages[0]!.id}`)).status).toBe(403);
      expect(((await call("GET", "/v1/wiki/search?q=roadmap")).body.data as WikiSearchHit[]).some((h) => h.area === "pages")).toBe(false);
    } finally {
      db.workspaces[0]!.workspace.settings.pages_enabled = true;
    }
  });
});
