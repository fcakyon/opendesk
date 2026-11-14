import { describe, expect, it } from "vitest";
import type { SidebarPrefs, Space } from "../api/types";
import { applyLayout, hasLayout, LAYOUTS, resetPrefs } from "./layouts";
import { asSpace, newOwnSection, sidebarEntries, entryKey } from "./ownSections";
import { applyRowOrder, moveRow, setRowOrder } from "./rowOrder";
import { canDrop, dropInSpace, dropOnSidebar, pinKey, starKey } from "./sidebarEditModel";
import { defaultSidebarPrefs, hid, isHidden, normalizePrefs, sectionOrder } from "./sidebarPrefs";

const W = "w1";
const base = (): SidebarPrefs => defaultSidebarPrefs();

describe("row order", () => {
  const rows = ["a", "b", "c", "d"];
  it("puts the rows the order names first, the rest after in their usual order", () => {
    expect(applyRowOrder(rows, (r) => r, ["c", "gone", "a"])).toEqual(["c", "a", "b", "d"]);
    expect(applyRowOrder(rows, (r) => r, undefined)).toEqual(rows);
  });
  it("moves a row and keeps the order of rows that do not show", () => {
    const p = setRowOrder(base(), "inbox", ["hiddenrow", "a"]);
    const next = moveRow(p, "inbox", ["a", "b", "c"], "c", 0);
    expect(next.row_order.inbox).toEqual(["c", "a", "b", "hiddenrow"]);
  });
  it("reads a saved order and leaves out what is not a list", () => {
    expect(normalizePrefs({ row_order: { inbox: ["a", 1 as unknown as string], teams: "x" as unknown as string[] } }).row_order).toEqual({ inbox: ["a"] });
    expect(normalizePrefs({}).row_order).toEqual({});
  });
});

describe("layouts", () => {
  it("applies a layout's order and shown sections, own sections after the section they followed, rows hidden inside kept", () => {
    let p = { ...base(), hidden: [hid.view("v1")] };
    p = newOwnSection(p, W, "Launch", undefined, "inbox").prefs;
    const docs = LAYOUTS.find((l) => l.id === "docs")!;
    const next = applyLayout(p, docs);
    expect(sectionOrder(next).slice(0, 3)).toEqual(["favorites", "pages", "inbox"]);
    const keys = sidebarEntries(next).map(entryKey);
    expect(keys[keys.indexOf("inbox") + 1]).toMatch(/^custom:/);
    expect(isHidden(next, hid.view("v1"))).toBe(true);
    expect(hasLayout(next, docs)).toBe(true);
  });
  it("hides what a layout hides and shows the rest", () => {
    const p = { ...base(), hidden: [hid.section("workspace")] };
    const next = applyLayout(p, LAYOUTS.find((l) => l.id === "support")!);
    expect(isHidden(next, hid.section("mail"))).toBe(true);
    expect(isHidden(next, hid.section("pages"))).toBe(true);
    expect(isHidden(next, hid.section("workspace"))).toBe(false);
  });
  it("resets order, hidden rows and row order, keeping own sections and favorites", () => {
    let p: SidebarPrefs = { ...base(), order: ["views", "inbox"], hidden: ["section:mail", "team:t1"], row_order: { inbox: ["a"] }, pinned: [{ kind: "view", id: "v1" }] };
    p = newOwnSection(p, W, "Mine").prefs;
    const next = resetPrefs(p);
    expect(next.hidden).toEqual([]);
    expect(next.row_order).toEqual({});
    expect(sectionOrder(next)).toEqual(sectionOrder(base()));
    expect(next.sections).toHaveLength(1);
    expect(next.pinned).toEqual(p.pinned);
  });
});

describe("drops in the sidebar", () => {
  const rows = (p: SidebarPrefs) => (section: string) => (section === "favorites" ? p.pinned.map(pinKey) : section === "inbox" ? ["ticket_folder:unassigned", "ticket_folder:mine", "ticket_folder:open"] : []);

  it("reorders sections, built-in and own alike", () => {
    const p = newOwnSection(base(), W, "Mine").prefs;
    const own = `custom:${p.sections[0].id}`;
    const r = dropOnSidebar(p, W, { kind: "section", key: own }, { kind: "section", before: "favorites" }, rows(p));
    expect(r && "prefs" in r && sidebarEntries(r.prefs).map(entryKey)[0]).toBe(own);
  });

  it("leaves a section where it is when it lands on itself or on something that is not a section", () => {
    const p = base();
    const before = sidebarEntries(p).map(entryKey);
    for (const target of ["mail", "support-teamspace"]) {
      const r = dropOnSidebar(p, W, { kind: "section", key: "mail" }, { kind: "section", before: target }, rows(p));
      expect(r && "prefs" in r && sidebarEntries(r.prefs).map(entryKey)).toEqual(before);
    }
    const up = dropOnSidebar(p, W, { kind: "section", key: "mail" }, { kind: "section", before: "inbox" }, rows(p));
    const keys = up && "prefs" in up ? sidebarEntries(up.prefs).map(entryKey) : [];
    expect(keys.indexOf("mail")).toBe(keys.indexOf("inbox") - 1);
  });

  it("reorders a built-in section's rows into the member's row order", () => {
    const p = base();
    const r = dropOnSidebar(p, W, { kind: "row", from: "inbox", key: "ticket_folder:open" }, { kind: "row", section: "inbox", before: "ticket_folder:unassigned" }, rows(p));
    expect(r && "prefs" in r && r.prefs.row_order.inbox).toEqual(["ticket_folder:open", "ticket_folder:unassigned", "ticket_folder:mine"]);
  });

  it("pins a row dropped on Favorites where it lands, and stars a page", () => {
    const p = { ...base(), pinned: [{ kind: "view" as const, id: "v1" }] };
    const pin = { kind: "team" as const, id: "t1" };
    const r = dropOnSidebar(p, W, { kind: "row", from: "teams", key: "team:t1", pin, row: pin }, { kind: "row", section: "favorites", before: "view:v1" }, rows(p));
    expect(r && "prefs" in r && r.prefs.pinned).toEqual([pin, { kind: "view", id: "v1" }]);
    const s = dropOnSidebar(p, W, { kind: "row", from: "pages", key: "wiki_page:p1", page: "p1", row: { kind: "wiki_page", id: "p1" } }, { kind: "row", section: "favorites", before: null }, rows(p));
    expect(s).toEqual({ star: "p1", before: null });
  });

  it("reorders starred pages among themselves", () => {
    const p = base();
    const r = dropOnSidebar(p, W, { kind: "row", from: "favorites", key: starKey("p2"), page: "p2" }, { kind: "row", section: "favorites", before: starKey("p1") }, () => [starKey("p1"), starKey("p2")]);
    expect(r).toEqual({ stars: ["p2", "p1"] });
  });

  it("adds a built-in row to an own section where it lands, and moves a row between own sections", () => {
    let p = newOwnSection(base(), W, "One", { kind: "view", id: "v1" }).prefs;
    p = newOwnSection(p, W, "Two").prefs;
    const [one, two] = p.sections;
    const add = dropOnSidebar(p, W, { kind: "row", from: "teams", key: "team:t1", row: { kind: "team", id: "t1" } }, { kind: "row", section: `custom:${one.id}`, before: `${W}:view:v1` }, rows(p));
    expect(add && "prefs" in add && add.prefs.sections[0].items.map((i) => i.id)).toEqual(["t1", "v1"]);
    const moved = add && "prefs" in add ? add.prefs : p;
    const mv = dropOnSidebar(moved, W, { kind: "row", from: `custom:${one.id}`, key: `${W}:view:v1`, row: { kind: "view", id: "v1" } }, { kind: "row", section: `custom:${two.id}`, before: null }, rows(moved));
    expect(mv && "prefs" in mv && mv.prefs.sections.map((s) => s.items.map((i) => i.id))).toEqual([["t1"], ["v1"]]);
  });

  it("refuses rows into a built-in section they are not from, and a full Favorites", () => {
    const p = { ...base(), pinned: Array.from({ length: 30 }, (_, i) => ({ kind: "view" as const, id: `v${i}` })) };
    expect(canDrop(p, W, { kind: "row", from: "teams", key: "team:t1", row: { kind: "team", id: "t1" } }, { kind: "row", section: "inbox", before: null })).toBe(false);
    expect(canDrop(p, W, { kind: "row", from: "teams", key: "team:t1", pin: { kind: "team", id: "t1" } }, { kind: "row", section: "favorites", before: null })).toBe(false);
    expect(canDrop(p, W, { kind: "section", key: "inbox" }, { kind: "row", section: "inbox", before: null })).toBe(false);
  });
});

describe("drops in a Space", () => {
  const space = (): Space => ({
    id: "s",
    name: "S",
    icon: "",
    color: "grey",
    marks: true,
    sections: [
      { id: "a", title: "A", collapsed: false, items: [{ workspace_id: W, kind: "view", id: "v1" }, { workspace_id: W, kind: "view", id: "v2" }] },
      { id: "b", title: "B", collapsed: false, items: [] },
    ],
  });
  it("reorders sections and moves rows within and between them", () => {
    expect(dropInSpace(space(), { kind: "section", key: "b" }, { kind: "section", before: "a" })?.sections.map((x) => x.id)).toEqual(["b", "a"]);
    expect(dropInSpace(space(), { kind: "row", from: "a", key: `${W}:view:v2` }, { kind: "row", section: "a", before: `${W}:view:v1` })?.sections[0].items.map((i) => i.id)).toEqual(["v2", "v1"]);
    const moved = dropInSpace(space(), { kind: "row", from: "a", key: `${W}:view:v1` }, { kind: "row", section: "b", before: null });
    expect(moved?.sections.map((x) => x.items.map((i) => i.id))).toEqual([["v2"], ["v1"]]);
  });
  it("keeps an own section's emoji through the Space model", () => {
    const p = newOwnSection(base(), W, "One").prefs;
    const withIcon = { ...p, sections: [{ ...p.sections[0], icon: "🚀" }] };
    expect(asSpace(withIcon, W).sections[0].icon).toBe("🚀");
  });
});
