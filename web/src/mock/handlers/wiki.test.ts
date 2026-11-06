import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Database, DbProperty, DbRows, WikiDailyNote, WikiNode, WikiPage, WikiPageViews, WikiRevision, WikiSearchHit, WikiTrashed } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { applyWikiEvent } from "@/lib/wiki/events";
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
