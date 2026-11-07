import { describe, expect, it } from "vitest";
import type { Canvas, CanvasNode } from "@/lib/api/types";
import {
  anchor,
  arrowHead,
  boundsOf,
  canonical,
  cleanUrl,
  curve,
  dragSet,
  edgeGeometry,
  extract,
  facingSides,
  fitView,
  hitNode,
  historyReducer,
  initHistory,
  marqueeHits,
  moveNodes,
  nearestSide,
  paste,
  placeNode,
  rectFrom,
  removeItems,
  resizeRect,
  snap,
  toApi,
  toScreen,
  toWorld,
  zoomAt,
} from "./model";

const text = (id: string, x: number, y: number, width = 100, height = 50): CanvasNode => ({ id, type: "text", html: `<p>${id}</p>`, x, y, width, height });
const group = (id: string, x: number, y: number, width: number, height: number): CanvasNode => ({ id, type: "group", label: id, x, y, width, height });

describe("view geometry", () => {
  it("maps world and screen points both ways", () => {
    const v = { x: 100, y: -40, zoom: 2 };
    const p = { x: 13, y: 7 };
    expect(toScreen(v, p)).toEqual({ x: 126, y: -26 });
    expect(toWorld(v, toScreen(v, p))).toEqual(p);
  });

  it("zooms around the pointer, keeping the point under it still", () => {
    const v = { x: 10, y: 20, zoom: 1 };
    const at = { x: 300, y: 200 };
    const before = toWorld(v, at);
    const next = zoomAt(v, at, 2.5);
    expect(next.zoom).toBe(2.5);
    const after = toWorld(next, at);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomAt(v, at, 99).zoom).toBe(4);
    expect(zoomAt(v, at, 0).zoom).toBe(0.1);
  });

  it("fits bounds in the viewport, centred and never past 100%", () => {
    const v = fitView({ x: 0, y: 0, width: 400, height: 200 }, { width: 1000, height: 800 }, 50);
    expect(v.zoom).toBe(1);
    expect(toScreen(v, { x: 200, y: 100 })).toEqual({ x: 500, y: 400 });
    const big = fitView({ x: -1000, y: 0, width: 4000, height: 1000 }, { width: 1000, height: 800 }, 100);
    expect(big.zoom).toBeCloseTo(0.2);
    const c = toScreen(big, { x: 1000, y: 500 });
    expect(c.x).toBeCloseTo(500);
    expect(c.y).toBeCloseTo(400);
    expect(fitView(null, { width: 600, height: 400 })).toEqual({ x: 300, y: 200, zoom: 1 });
  });

  it("bounds a set of rectangles", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([text("a", 0, 0), text("b", 200, -30, 50, 10)])).toEqual({ x: 0, y: -30, width: 250, height: 80 });
  });

  it("snaps to the grid", () => {
    expect(snap(29)).toBe(20);
    expect(snap(31)).toBe(40);
    expect(snap(-11)).toBe(-20);
  });
});

describe("hit tests and selection", () => {
  const nodes = [group("g", 0, 0, 500, 400), text("a", 20, 20), text("b", 60, 40), text("far", 900, 900)];

  it("finds the card on top, cards above groups", () => {
    expect(hitNode(nodes, { x: 70, y: 50 })?.id).toBe("b");
    expect(hitNode(nodes, { x: 25, y: 25 })?.id).toBe("a");
    expect(hitNode(nodes, { x: 400, y: 300 })?.id).toBe("g");
    expect(hitNode(nodes, { x: -5, y: -5 })).toBeNull();
  });

  it("selects what a marquee touches, groups only when held whole", () => {
    expect(marqueeHits(nodes, rectFrom({ x: 150, y: 80 }, { x: 10, y: 10 })).sort()).toEqual(["a", "b"]);
    expect(marqueeHits(nodes, rectFrom({ x: -10, y: -10 }, { x: 600, y: 600 })).sort()).toEqual(["a", "b", "g"]);
  });

  it("drags a group's contents with it, nested groups too", () => {
    const nested = [...nodes, group("inner", 200, 200, 200, 150), text("deep", 220, 220)];
    expect([...dragSet(nested, ["g"])].sort()).toEqual(["a", "b", "deep", "g", "inner"]);
    expect([...dragSet(nested, ["a"])]).toEqual(["a"]);
  });
});

describe("edits", () => {
  const doc: Canvas = { nodes: [text("a", 0, 0), text("b", 300, 0), text("c", 0, 300)], edges: [{ id: "e1", fromNode: "a", toNode: "b" }, { id: "e2", fromNode: "b", toNode: "c" }] };

  it("moves cards, snapping the lead card's corner to the grid", () => {
    const moved = moveNodes(doc, new Set(["a", "b"]), 13, 27, 20);
    expect(moved.nodes.map((n) => [n.x, n.y])).toEqual([[20, 20], [320, 20], [0, 300]]);
    expect(moved.nodes[2]).toBe(doc.nodes[2]);
    expect(moveNodes(doc, new Set(["a"]), 13, 27).nodes[0]).toMatchObject({ x: 13, y: 27 });
  });

  it("resizes from any handle, never under the minimum", () => {
    const r = { x: 0, y: 0, width: 100, height: 100 };
    expect(resizeRect(r, "se", 37, 12)).toEqual({ x: 0, y: 0, width: 137, height: 112 });
    expect(resizeRect(r, "se", 37, 12, 20)).toEqual({ x: 0, y: 0, width: 140, height: 120 });
    expect(resizeRect(r, "e", -500, 0).width).toBe(20);
    expect(resizeRect(r, "nw", 30, 50)).toEqual({ x: 30, y: 50, width: 70, height: 50 });
    expect(resizeRect(r, "w", 500, 0)).toEqual({ x: 80, y: 0, width: 20, height: 100 });
  });

  it("removes cards with their connections", () => {
    const out = removeItems(doc, new Set(["b"]));
    expect(out.nodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(out.edges).toEqual([]);
    expect(removeItems(doc, new Set(), new Set(["e1"])).edges.map((e) => e.id)).toEqual(["e2"]);
  });

  it("copies and pastes with new ids, keeping the connections among the copies", () => {
    let n = 0;
    const clip = extract(doc, new Set(["a", "b"]));
    expect(clip.edges.map((e) => e.id)).toEqual(["e1"]);
    const { doc: out, ids } = paste(doc, clip, { x: 1000, y: 1000 }, () => `n${++n}`);
    expect(ids).toEqual(["n1", "n2"]);
    expect(out.nodes.slice(3).map((x) => [x.id, x.x, x.y])).toEqual([["n1", 1000, 1000], ["n2", 1300, 1000]]);
    expect(out.edges[2]).toEqual({ id: "n3", fromNode: "n1", toNode: "n2" });
    const dup = paste(doc, clip, null, () => `d${++n}`);
    expect(dup.doc.nodes[3]).toMatchObject({ x: 40, y: 40 });
  });

  it("places a new card centred and on the grid", () => {
    const t = placeNode("text", { x: 133, y: 71 }, { html: "" }, () => "x");
    expect(t).toEqual({ id: "x", type: "text", html: "", x: 0, y: 0, width: 260, height: 140 });
  });
});

describe("connections", () => {
  const a = { x: 0, y: 0, width: 100, height: 100 };

  it("anchors on the middle of a side and finds the nearest one", () => {
    expect(anchor(a, "right")).toEqual({ x: 100, y: 50 });
    expect(anchor(a, "top")).toEqual({ x: 50, y: 0 });
    expect(nearestSide(a, { x: 50, y: 140 })).toBe("bottom");
    expect(nearestSide(a, { x: -30, y: 60 })).toBe("left");
  });

  it("faces cards side by side or one above the other", () => {
    expect(facingSides(a, { x: 300, y: 20, width: 100, height: 100 })).toEqual(["right", "left"]);
    expect(facingSides(a, { x: -300, y: 20, width: 100, height: 100 })).toEqual(["left", "right"]);
    expect(facingSides(a, { x: 20, y: 300, width: 100, height: 100 })).toEqual(["bottom", "top"]);
    expect(facingSides(a, { x: 20, y: -300, width: 100, height: 100 })).toEqual(["top", "bottom"]);
  });

  it("draws a curve that leaves each side straight out, through its middle", () => {
    const g = curve({ x: 100, y: 50 }, "right", { x: 300, y: 50 }, "left");
    expect(g.c1.y).toBe(50);
    expect(g.c1.x).toBeGreaterThan(100);
    expect(g.c2.x).toBeLessThan(300);
    expect(g.mid).toEqual({ x: 200, y: 50 });
    expect(g.d).toMatch(/^M100,50 C\d+(\.\d)?,50 \d+(\.\d)?,50 300,50$/);
    const e = edgeGeometry({ id: "e", fromNode: "a", toNode: "b", fromSide: "bottom" }, a, { x: 300, y: 0, width: 100, height: 100 });
    expect(e.from).toEqual({ x: 50, y: 100 });
    expect(e.to).toEqual({ x: 300, y: 50 });
  });

  it("points an arrowhead along the curve's end", () => {
    expect(arrowHead({ x: 100, y: 0 }, { x: 0, y: 0 }, 10)).toBe("M100,0 L90,5.5 L90,-5.5 Z");
  });
});

describe("the API's shape", () => {
  it("rounds, clamps and leaves out what the API leaves out", () => {
    const doc: Canvas = {
      nodes: [
        { id: "a", type: "text", html: "<p>x</p>", x: 10.4, y: -2e6, width: 5, height: 99.6, color: "9" },
        { id: "l", type: "link", url: "https://x.test", title: "", image: "", x: 0, y: 0, width: 300, height: 200, color: "#AABBCC" },
        { id: "g", type: "group", label: "", x: 0, y: 0, width: 300, height: 200 },
      ],
      edges: [
        { id: "e", fromNode: "a", toNode: "l", fromEnd: "none", toEnd: "arrow", label: "  two   words ", color: "3" },
        { id: "gone", fromNode: "a", toNode: "missing" },
      ],
    };
    expect(toApi(doc)).toEqual({
      nodes: [
        { id: "a", type: "text", html: "<p>x</p>", x: 10, y: -1e6, width: 20, height: 100 },
        { id: "l", type: "link", url: "https://x.test", x: 0, y: 0, width: 300, height: 200, color: "#AABBCC" },
        { id: "g", type: "group", x: 0, y: 0, width: 300, height: 200 },
      ],
      edges: [{ id: "e", fromNode: "a", toNode: "l", label: "two words", color: "3" }],
    });
  });

  it("spells the same canvas the same way whatever its keys' order", () => {
    const a: Canvas = { nodes: [{ id: "a", type: "page", page_id: "p", x: 0, y: 0, width: 100, height: 100 }], edges: [] };
    const b = JSON.parse('{"edges":[],"nodes":[{"height":100,"width":100,"y":0,"x":0,"page_id":"p","type":"page","id":"a"}]}') as Canvas;
    expect(canonical(a)).toBe(canonical(b));
    expect(canonical(a)).not.toBe(canonical({ ...a, nodes: [{ ...a.nodes[0]!, x: 1 }] }));
  });

  it("takes https links only", () => {
    expect(cleanUrl("example.com/a")).toBe("https://example.com/a");
    expect(cleanUrl("https://example.com")).toBe("https://example.com");
    expect(cleanUrl("http://example.com")).toBeNull();
    expect(cleanUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("history", () => {
  const d = (n: number): Canvas => ({ nodes: [text(`n${n}`, n, 0)], edges: [] });

  it("undoes and redoes discrete edits", () => {
    let h = initHistory(d(0));
    h = historyReducer(h, { type: "set", doc: d(1) });
    h = historyReducer(h, { type: "set", doc: d(2) });
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toEqual(d(1));
    h = historyReducer(h, { type: "redo" });
    expect(h.present).toEqual(d(2));
    h = historyReducer(h, { type: "undo" });
    h = historyReducer(h, { type: "set", doc: d(3) });
    expect(h.future).toEqual([]);
    expect(historyReducer(h, { type: "redo" })).toBe(h);
  });

  it("makes a gesture one step, and a cancelled gesture none", () => {
    let h = initHistory(d(0));
    h = historyReducer(h, { type: "preview", doc: d(1) });
    h = historyReducer(h, { type: "preview", doc: d(2) });
    expect(h.past).toEqual([]);
    h = historyReducer(h, { type: "commit" });
    expect(h.past).toEqual([d(0)]);
    expect(h.present).toEqual(d(2));
    h = historyReducer(h, { type: "preview", doc: d(5) });
    h = historyReducer(h, { type: "cancel" });
    expect(h.present).toEqual(d(2));
    expect(h.past).toHaveLength(1);
    // Undo waits for a gesture to end.
    h = historyReducer(h, { type: "preview", doc: d(6) });
    expect(historyReducer(h, { type: "undo" })).toBe(h);
  });

  it("amends the canvas in place, and applies updaters to the latest canvas", () => {
    let h = initHistory(d(0));
    h = historyReducer(h, { type: "set", doc: d(1) });
    h = historyReducer(h, { type: "amend", doc: (c) => ({ ...c, edges: [{ id: "e", fromNode: "n1", toNode: "n1" }] }) });
    expect(h.past).toEqual([d(0)]);
    expect(h.present.edges).toHaveLength(1);
    h = historyReducer(h, { type: "preview", doc: (c) => ({ ...c, nodes: [] }) });
    h = historyReducer(h, { type: "preview", doc: (c) => ({ ...c, edges: [] }) });
    expect(h.present).toEqual({ nodes: [], edges: [] });
    expect(historyReducer(h, { type: "amend", doc: (c) => c })).toBe(h);
  });

  it("keeps the last 100 steps and starts over on someone else's canvas", () => {
    let h = initHistory(d(0));
    for (let i = 1; i <= 120; i++) h = historyReducer(h, { type: "set", doc: d(i) });
    expect(h.past).toHaveLength(100);
    expect(h.past[0]).toEqual(d(20));
    h = historyReducer(h, { type: "reset", doc: d(999) });
    expect(h).toEqual({ past: [], present: d(999), future: [], base: null });
  });
});
