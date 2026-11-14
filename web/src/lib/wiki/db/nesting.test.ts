import { describe, expect, it } from "vitest";
import type { Database, DbRow } from "../../api/types";
import { row } from "./fixtures";
import { dependencyEdges, isLate, lateBlockers } from "./deps";
import { pairChoices, pairedWrites, pairsOf } from "./pairs";
import { ancestorIds, buildTree, descendantIds, flattenTree, parentsOf } from "./tree";

const db: Database = {
  properties: [
    { id: "title", name: "Name", type: "title" },
    { id: "parent", name: "Parent item", type: "relation", database_id: "db" },
    { id: "subs", name: "Sub-items", type: "relation", database_id: "db" },
    { id: "blocked", name: "Blocked by", type: "relation", database_id: "db" },
    { id: "blocking", name: "Blocking", type: "relation", database_id: "db" },
  ],
  views: [{ id: "table", name: "Table", type: "table" }],
  next_id: 1,
  sub_items: { parent: "parent", children: "subs" },
  dependencies: { blocked_by: "blocked", blocking: "blocking" },
};

const under = (id: string, parent?: string, extra: DbRow["props"] = {}) => row(id, id.toUpperCase(), { ...(parent ? { parent: [parent] } : {}), ...extra });
const shape = (rows: DbRow[]) => {
  const out: string[] = [];
  const walk = (list: ReturnType<typeof buildTree>) => list.forEach((n) => (out.push(`${"-".repeat(n.depth)}${n.row.id}`), walk(n.children)));
  walk(buildTree(rows, "parent"));
  return out;
};

describe("sub-items as a tree", () => {
  it("nests rows under their parent item, keeping the rows' order on every level", () => {
    const rows = [under("c", "a"), under("a"), under("b"), under("d", "c"), under("e", "a")];
    expect(shape(rows)).toEqual(["a", "-c", "--d", "-e", "b"]);
  });

  it("puts a row whose parent isn't among the rows at the top (filtered out, or gone)", () => {
    expect(shape([under("b", "a"), under("c", "gone")])).toEqual(["b", "c"]);
  });

  it("cuts a loop of parents at the row that comes first", () => {
    // a under c under b under a: a comes first and goes to the top.
    const rows = [under("a", "c"), under("b", "a"), under("c", "b"), under("x", "x")];
    expect(shape(rows)).toEqual(["a", "-b", "--c", "x"]);
    expect([...parentsOf(rows, "parent")]).toEqual([
      ["b", "a"],
      ["c", "b"],
    ]);
  });

  it("shows a row's sub-items only while it is open", () => {
    const tree = buildTree([under("a"), under("b", "a"), under("c", "b")], "parent");
    expect(flattenTree(tree, new Set()).map((l) => [l.row.id, l.hasChildren, l.open])).toEqual([["a", true, false]]);
    expect(flattenTree(tree, new Set(["a", "b"])).map((l) => `${l.depth}${l.row.id}`)).toEqual(["0a", "1b", "2c"]);
  });

  it("finds a row's descendants and ancestors, loops guarded", () => {
    const rows = [under("a"), under("b", "a"), under("c", "b"), under("d", "a"), under("x", "y"), under("y", "x")];
    expect([...descendantIds(rows, "parent", "a")].sort()).toEqual(["b", "c", "d"]);
    expect(ancestorIds(rows, "parent", "c")).toEqual(["b", "a"]);
    expect(ancestorIds(rows, "parent", "y")).toEqual(["x"]);
  });
});

describe("paired relations kept in step", () => {
  const rows = [under("a"), under("b"), under("c", "a"), under("d")];
  rows[0]!.props.subs = ["c"];

  it("knows each side's partner, and that a parent item is one row", () => {
    expect(pairsOf(db).get("parent")).toEqual({ partner: "subs", single: true });
    expect(pairsOf(db).get("blocking")).toEqual({ partner: "blocked", single: false });
    expect(pairsOf({ ...db, sub_items: undefined, dependencies: undefined }).size).toBe(0);
  });

  it("moves a row to a new parent: the new one lists it, the old one no longer does", () => {
    const w = pairedWrites(db, rows, "c", { parent: ["b"] });
    expect(Object.fromEntries(w)).toEqual({ c: { parent: ["b"] }, b: { subs: ["c"] }, a: { subs: null } });
  });

  it("gives a parent a sub-item that had another parent, taking it from that one", () => {
    const w = pairedWrites(db, rows, "b", { subs: ["c"] });
    expect(Object.fromEntries(w)).toEqual({ b: { subs: ["c"] }, c: { parent: ["b"] }, a: { subs: null } });
  });

  it("refuses a loop, a row of its own, and keeps one parent", () => {
    // c is under a: a can't go under c, nor under itself.
    expect(Object.fromEntries(pairedWrites(db, rows, "a", { parent: ["c", "a"] }))).toEqual({ a: { parent: null } });
    expect(Object.fromEntries(pairedWrites(db, rows, "d", { parent: ["a", "b"] }))).toEqual({ d: { parent: ["a"] }, a: { subs: ["c", "d"] } });
    expect(pairChoices(db, rows, "a", "parent").map((r) => r.id)).toEqual(["b", "d"]);
    expect(pairChoices(db, rows, "c", "subs").map((r) => r.id)).toEqual(["b", "d"]);
  });

  it("mirrors dependencies both ways, and writes nothing else", () => {
    const w = pairedWrites(db, rows, "d", { blocked: ["a", "b"], notes: "x" } as never);
    expect(Object.fromEntries(w)).toEqual({ d: { blocked: ["a", "b"], notes: "x" }, a: { blocking: ["d"] }, b: { blocking: ["d"] } });
    const after = rows.map((r) => (r.id === "a" ? { ...r, props: { ...r.props, blocking: ["d"] } } : r.id === "d" ? { ...r, props: { blocked: ["a"] } } : r));
    expect(Object.fromEntries(pairedWrites(db, after, "a", { blocking: [] }))).toEqual({ a: { blocking: null }, d: { blocked: null } });
  });

  it("leaves values alone in a database without pairs", () => {
    const plain = { ...db, sub_items: undefined, dependencies: undefined };
    expect(Object.fromEntries(pairedWrites(plain, rows, "c", { parent: ["b", "c"] }))).toEqual({ c: { parent: ["b", "c"] } });
  });
});

describe("dependencies", () => {
  const day = (d: number) => new Date(2026, 10, d);
  const spans: Record<string, { start: Date; end: Date }> = { a: { start: day(1), end: day(5) }, b: { start: day(4), end: day(6) }, c: { start: day(5), end: day(9) } };
  const span = (id: string) => spans[id];

  it("reads edges from both sides, each once, among the rows there", () => {
    const rows = [row("a", "A", { blocking: ["b", "gone"] }), row("b", "B", { blocked: ["a"] }), row("c", "C", { blocked: ["a", "c"] })];
    expect(dependencyEdges(db, rows)).toEqual([
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ]);
    expect(dependencyEdges({ ...db, dependencies: undefined }, rows)).toEqual([]);
  });

  it("marks a row that starts before its blocker ends", () => {
    expect(isLate({ from: "a", to: "b" }, span)).toBe(true);
    expect(isLate({ from: "a", to: "c" }, span)).toBe(false); // starts the day a ends
    expect(isLate({ from: "a", to: "nodates" }, span)).toBe(false);
    expect(lateBlockers("b", [{ from: "a", to: "b" }, { from: "c", to: "b" }, { from: "a", to: "c" }], span)).toEqual(["a", "c"]);
  });
});
