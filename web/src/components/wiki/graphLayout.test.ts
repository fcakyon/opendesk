import { describe, expect, it } from "vitest";
import type { WikiLink, WikiNode } from "@/lib/api/types";
import { buildGraph, fitView, settle, step, type Graph, type GraphOptions } from "./graphLayout";

const node = (id: string, parent: string | null = null, tags: string[] = []): WikiNode => ({
  id,
  parent_id: parent,
  title: id === "u" ? "" : `Page ${id.toUpperCase()}`,
  tags,
  icon: "",
  position: 0,
  version: 1,
  updated_at: "2026-10-01T00:00:00Z",
  created_by_id: "me",
});

// Links: a - b - c - d, a - e. Subpages: f under a, g under f. h stands alone.
const nodes = [node("a"), node("b", null, ["ops"]), node("c", null, ["ops"]), node("d"), node("e"), node("f", "a"), node("g", "f"), node("h"), node("u")];
const links: WikiLink[] = [
  { from: "a", to: "b" },
  { from: "b", to: "a" },
  { from: "b", to: "c" },
  { from: "c", to: "d" },
  { from: "a", to: "e" },
  { from: "a", to: "a" },
  { from: "a", to: "gone" },
];
const base: GraphOptions = { subpageLinks: false, orphans: true };
const ids = (g: Graph) => g.nodes.map((n) => n.id).join("");
const build = (opts: Partial<GraphOptions>) => buildGraph(nodes, links, { ...base, ...opts });

describe("wiki graph", () => {
  it("dedupes edges and drops self edges and missing pages", () => {
    const g = build({});
    expect(ids(g)).toBe("abcdefghu");
    expect(g.edges).toHaveLength(4);
    expect(g.edges.every((e) => e.kind === "link")).toBe(true);
    expect(g.nodes.find((n) => n.id === "a")!.degree).toBe(2);
    expect(g.nodes.find((n) => n.id === "u")!.title).toBe("Untitled");
  });

  it("adds subpage edges and groups pages by their top-level page", () => {
    const g = build({ subpageLinks: true });
    expect(g.edges.filter((e) => e.kind === "subpage")).toHaveLength(2);
    expect(g.nodes.find((n) => n.id === "g")!.group).toBe("a");
    expect(g.nodes.find((n) => n.id === "b")!.group).toBe("b");
  });

  it("drops orphans when asked", () => {
    expect(ids(build({ orphans: false }))).toBe("abcde");
    expect(ids(build({ orphans: false, subpageLinks: true }))).toBe("abcdefg");
  });

  it("keeps pages within the focus's depth, both directions", () => {
    expect(ids(build({ focus: "c", depth: 1 }))).toBe("bcd");
    expect(ids(build({ focus: "c", depth: 2 }))).toBe("abcd");
    expect(ids(build({ focus: "a", depth: 1, subpageLinks: true }))).toBe("abef");
    expect(ids(build({ focus: "g", depth: 2, subpageLinks: true }))).toBe("afg");
    // Without a depth the focus is only marked.
    expect(ids(build({ focus: "c" }))).toBe("abcdefghu");
  });

  it("filters by tag and title, keeping the focus", () => {
    expect(ids(build({ tag: "ops" }))).toBe("bc");
    expect(ids(build({ tag: "ops", focus: "a" }))).toBe("abc");
    expect(ids(build({ query: "page b" }))).toBe("b");
    expect(ids(build({ query: "UNTITLED" }))).toBe("u");
    const g = build({ tag: "ops", focus: "h", orphans: false });
    expect(ids(g)).toBe("bch");
    expect(g.edges).toEqual([{ a: 0, b: 1, kind: "link" }]);
  });

  it("seeds the same positions every time", () => {
    expect(build({}).nodes.map((n) => [n.x, n.y])).toEqual(build({}).nodes.map((n) => [n.x, n.y]));
  });

  it("settles with linked pages closer than unlinked ones", () => {
    const g = build({ subpageLinks: true });
    settle(g, 300);
    for (const n of g.nodes) for (const v of [n.x, n.y, n.vx, n.vy]) expect(Number.isFinite(v)).toBe(true);

    const dist = (i: number, j: number) => Math.hypot(g.nodes[i].x - g.nodes[j].x, g.nodes[i].y - g.nodes[j].y);
    const linked = new Set(g.edges.map((e) => `${Math.min(e.a, e.b)} ${Math.max(e.a, e.b)}`));
    const near: number[] = [];
    const far: number[] = [];
    for (let i = 0; i < g.nodes.length; i++) for (let j = i + 1; j < g.nodes.length; j++) (linked.has(`${i} ${j}`) ? near : far).push(dist(i, j));
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean(near)).toBeLessThan(mean(far));
    // At rest: a further tick barely moves anything.
    const before = g.nodes.map((n) => [n.x, n.y]);
    step(g, 0.001);
    g.nodes.forEach((n, i) => expect(Math.hypot(n.x - before[i][0], n.y - before[i][1])).toBeLessThan(0.5));
  });

  it("holds fixed nodes and stays finite on a large graph", () => {
    const many = Array.from({ length: 800 }, (_, i) => node(`n${i}`));
    const chain = many.slice(1).map((n, i) => ({ from: many[i].id, to: n.id }));
    const g = buildGraph(many, chain, base);
    g.nodes[0].fixed = true;
    const [x, y] = [g.nodes[0].x, g.nodes[0].y];
    for (let i = 0; i < 20; i++) step(g, 1 - i / 20);
    expect([g.nodes[0].x, g.nodes[0].y]).toEqual([x, y]);
    expect(g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("fits every node in the view", () => {
    const g = build({});
    settle(g);
    const v = fitView(g.nodes, 400, 300);
    for (const n of g.nodes) {
      expect(n.x * v.k + v.x).toBeGreaterThanOrEqual(0);
      expect(n.x * v.k + v.x).toBeLessThanOrEqual(400);
      expect(n.y * v.k + v.y).toBeGreaterThanOrEqual(0);
      expect(n.y * v.k + v.y).toBeLessThanOrEqual(300);
    }
  });
});
