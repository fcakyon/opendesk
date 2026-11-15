// A wiki canvas's pure logic (contracts/wiki.md "Canvas"): geometry in world points (the
// view maps them to the screen), the edits the view makes, the local undo history, and the
// shape the API takes. Nothing here touches the DOM.

import type { Canvas, CanvasEdge, CanvasEnd, CanvasNode, CanvasSide } from "@/lib/api/types";

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
/** Screen = world * zoom + (x, y). */
export type View = { x: number; y: number; zoom: number };
export type Size = { width: number; height: number };

export const GRID = 20;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export const MIN_SIZE = 20;
export const MAX_SIZE = 20000;
export const MAX_COORD = 1e6;
export const MAX_NODES = 2000;
export const MAX_EDGES = 4000;
export const MAX_LABEL = 200;
export const SIDES: readonly CanvasSide[] = ["top", "right", "bottom", "left"];

/** JSON Canvas's six preset colours, as the app's tones. */
export const PRESET_TONES = { "1": "red", "2": "orange", "3": "yellow", "4": "green", "5": "cyan", "6": "purple" } as const;
export type PresetColor = keyof typeof PRESET_TONES;
export const PRESETS = Object.keys(PRESET_TONES) as PresetColor[];
const HEX = /^#[0-9a-fA-F]{6}$/;
export const isColor = (c: unknown): c is string => typeof c === "string" && (c in PRESET_TONES || HEX.test(c));

/** A new card's size, by type. */
export const DEFAULT_SIZE: Record<CanvasNode["type"], Size> = {
  text: { width: 260, height: 140 },
  page: { width: 320, height: 200 },
  link: { width: 320, height: 240 },
  file: { width: 300, height: 220 },
  group: { width: 520, height: 360 },
};

export const emptyCanvas = (): Canvas => ({ nodes: [], edges: [] });

// ─── Geometry ────────────────────────────────────────────────────────────────

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clampZoom = (z: number) => clamp(z, MIN_ZOOM, MAX_ZOOM);
export const snap = (v: number, grid = GRID) => Math.round(v / grid) * grid;

export const toWorld = (v: View, p: Point): Point => ({ x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom });
export const toScreen = (v: View, p: Point): Point => ({ x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y });

/** The view zoomed to `zoom`, keeping the world point under the screen point `at` where it is. */
export function zoomAt(v: View, at: Point, zoom: number): View {
  const z = clampZoom(zoom);
  const w = toWorld(v, at);
  return { zoom: z, x: at.x - w.x * z, y: at.y - w.y * z };
}

export const containsPoint = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
export const containsRect = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** The rectangle two corners span, either way round. */
export function rectFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** The view that shows `bounds` whole in a viewport, centred, never closer than maxZoom. */
export function fitView(bounds: Rect | null, viewport: Size, padding = 72, maxZoom = 1): View {
  if (!bounds || viewport.width <= 0 || viewport.height <= 0) return { x: viewport.width / 2, y: viewport.height / 2, zoom: 1 };
  const zoom = clampZoom(
    Math.min(maxZoom, (viewport.width - padding * 2) / Math.max(bounds.width, 1), (viewport.height - padding * 2) / Math.max(bounds.height, 1)),
  );
  return {
    zoom,
    x: viewport.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: viewport.height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}

/** Groups are drawn first (under everything), then the other cards in their order. */
export function renderOrder(nodes: readonly CanvasNode[]): CanvasNode[] {
  return [...nodes.filter((n) => n.type === "group"), ...nodes.filter((n) => n.type !== "group")];
}

/** The card on top at a world point. */
export function hitNode(nodes: readonly CanvasNode[], p: Point): CanvasNode | null {
  const order = renderOrder(nodes);
  for (let i = order.length - 1; i >= 0; i--) if (containsPoint(order[i]!, p)) return order[i]!;
  return null;
}

/** The cards a marquee selects: those it touches, and a group only when it holds it whole. */
export function marqueeHits(nodes: readonly CanvasNode[], r: Rect): string[] {
  return nodes.filter((n) => (n.type === "group" ? containsRect(r, n) : intersects(r, n))).map((n) => n.id);
}

/** The cards a group holds whole (they move with it). */
export function groupContents(nodes: readonly CanvasNode[], group: CanvasNode): string[] {
  return nodes.filter((n) => n.id !== group.id && containsRect(group, n)).map((n) => n.id);
}

/** What moves when `ids` are dragged: them, and what the groups among them hold. */
export function dragSet(nodes: readonly CanvasNode[], ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const queue = [...out];
  while (queue.length) {
    const n = byId.get(queue.pop()!);
    if (n?.type !== "group") continue;
    for (const id of groupContents(nodes, n)) {
      if (!out.has(id)) {
        out.add(id);
        queue.push(id);
      }
    }
  }
  return out;
}

// ─── Connections ─────────────────────────────────────────────────────────────

const NORMAL: Record<CanvasSide, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

/** The middle of a card's side, where a connection meets it. */
export function anchor(r: Rect, side: CanvasSide): Point {
  switch (side) {
    case "top":
      return { x: r.x + r.width / 2, y: r.y };
    case "right":
      return { x: r.x + r.width, y: r.y + r.height / 2 };
    case "bottom":
      return { x: r.x + r.width / 2, y: r.y + r.height };
    case "left":
      return { x: r.x, y: r.y + r.height / 2 };
  }
}

/** The side of a card nearest a point. */
export function nearestSide(r: Rect, p: Point): CanvasSide {
  let best: CanvasSide = "top";
  let d = Infinity;
  for (const s of SIDES) {
    const a = anchor(r, s);
    const dist = Math.hypot(a.x - p.x, a.y - p.y);
    if (dist < d) {
      d = dist;
      best = s;
    }
  }
  return best;
}

/** The sides two cards face each other with, for a connection that names none. */
export function facingSides(a: Rect, b: Rect): [CanvasSide, CanvasSide] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  // Side by side when the gap between them runs across more than down.
  const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  if (gapX > gapY || (gapX === gapY && Math.abs(dx) >= Math.abs(dy))) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

export type EdgeGeometry = { from: Point; to: Point; c1: Point; c2: Point; d: string; mid: Point };

/** A smooth curve from one side to another: each end leaves straight out of its side. */
export function curve(from: Point, fromSide: CanvasSide, to: Point, toSide: CanvasSide | null): EdgeGeometry {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const k = clamp(dist * 0.45, 24, 220);
  const n1 = NORMAL[fromSide];
  const c1 = { x: from.x + n1.x * k, y: from.y + n1.y * k };
  const n2 = toSide ? NORMAL[toSide] : { x: 0, y: 0 };
  const c2 = { x: to.x + n2.x * k, y: to.y + n2.y * k };
  const r = (v: number) => Math.round(v * 10) / 10;
  const d = `M${r(from.x)},${r(from.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(to.x)},${r(to.y)}`;
  return { from, to, c1, c2, d, mid: bezierAt(from, c1, c2, to, 0.5) };
}

export function bezierAt(p0: Point, c1: Point, c2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y };
}

/** A connection's curve between its cards, on the sides it names or the facing ones. */
export function edgeGeometry(e: CanvasEdge, from: Rect, to: Rect): EdgeGeometry {
  const [fs, ts] = facingSides(from, to);
  const fromSide = e.fromSide ?? fs;
  const toSide = e.toSide ?? ts;
  return curve(anchor(from, fromSide), fromSide, anchor(to, toSide), toSide);
}

/** An arrowhead (a closed triangle path) at `tip`, pointing away from `back`. */
export function arrowHead(tip: Point, back: Point, size = 9): string {
  let dx = tip.x - back.x;
  let dy = tip.y - back.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const bx = tip.x - dx * size;
  const by = tip.y - dy * size;
  const px = -dy * size * 0.55;
  const py = dx * size * 0.55;
  const r = (v: number) => Math.round(v * 10) / 10;
  return `M${r(tip.x)},${r(tip.y)} L${r(bx + px)},${r(by + py)} L${r(bx - px)},${r(by - py)} Z`;
}

/** The end of a curve's tangent: where an arrowhead at that end points from. */
export function tangentBack(g: EdgeGeometry, end: "from" | "to"): Point {
  if (end === "to") return g.c2.x === g.to.x && g.c2.y === g.to.y ? g.c1 : g.c2;
  return g.c1.x === g.from.x && g.c1.y === g.from.y ? g.c2 : g.c1;
}

export const fromEnd = (e: CanvasEdge): CanvasEnd => e.fromEnd ?? "none";
export const toEnd = (e: CanvasEdge): CanvasEnd => e.toEnd ?? "arrow";

// ─── Edits ───────────────────────────────────────────────────────────────────

/** A fresh id for a card or a connection. */
export function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const clampCoord = (v: number) => clamp(v, -MAX_COORD, MAX_COORD);
const clampSize = (v: number) => clamp(v, MIN_SIZE, MAX_SIZE);

/** Moves cards by (dx, dy); with a grid, the first card's corner lands on it and the rest keep their places. */
export function moveNodes(doc: Canvas, ids: ReadonlySet<string>, dx: number, dy: number, grid = 0): Canvas {
  if (!ids.size) return doc;
  let ox = dx;
  let oy = dy;
  if (grid) {
    const lead = doc.nodes.find((n) => ids.has(n.id));
    if (lead) {
      ox = snap(lead.x + dx, grid) - lead.x;
      oy = snap(lead.y + dy, grid) - lead.y;
    }
  }
  if (!ox && !oy) return doc;
  return { ...doc, nodes: doc.nodes.map((n) => (ids.has(n.id) ? { ...n, x: clampCoord(n.x + ox), y: clampCoord(n.y + oy) } : n)) };
}

export type Handle = "e" | "s" | "se" | "w" | "n" | "nw" | "ne" | "sw";

/** A card resized from a handle by (dx, dy) from its size at the start (`start`). */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, grid = 0): Rect {
  let { x, y, width, height } = start;
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const s = (v: number) => (grid ? snap(v, grid) : v);
  if (handle.includes("e")) width = clampSize(s(right + dx) - x);
  if (handle.includes("s")) height = clampSize(s(bottom + dy) - y);
  if (handle.includes("w")) {
    x = Math.min(s(start.x + dx), right - MIN_SIZE);
    width = clampSize(right - x);
    x = right - width;
  }
  if (handle.includes("n")) {
    y = Math.min(s(start.y + dy), bottom - MIN_SIZE);
    height = clampSize(bottom - y);
    y = bottom - height;
  }
  return { x, y, width, height };
}

export function updateNode(doc: Canvas, id: string, patch: Partial<CanvasNode>): Canvas {
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as CanvasNode) : n)) };
}

export function updateEdge(doc: Canvas, id: string, patch: Partial<CanvasEdge>): Canvas {
  return { ...doc, edges: doc.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

/** Removes cards (with their connections) and connections. */
export function removeItems(doc: Canvas, nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string> = new Set()): Canvas {
  return {
    nodes: doc.nodes.filter((n) => !nodeIds.has(n.id)),
    edges: doc.edges.filter((e) => !edgeIds.has(e.id) && !nodeIds.has(e.fromNode) && !nodeIds.has(e.toNode)),
  };
}

/** Puts the cards on top (the end of the order); groups stay under everything when drawn. */
export function bringToFront(doc: Canvas, ids: ReadonlySet<string>): Canvas {
  const moved = doc.nodes.filter((n) => ids.has(n.id));
  if (!moved.length || doc.nodes.slice(-moved.length).every((n) => ids.has(n.id))) return doc;
  return { ...doc, nodes: [...doc.nodes.filter((n) => !ids.has(n.id)), ...moved] };
}

/** The cards and the connections among them, to copy. */
export function extract(doc: Canvas, ids: ReadonlySet<string>): Canvas {
  return { nodes: doc.nodes.filter((n) => ids.has(n.id)), edges: doc.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode)) };
}

/** Adds a copy of `clip` with new ids, its top-left corner at `at` (or offset from where it was). */
export function paste(doc: Canvas, clip: Canvas, at: Point | null, makeId: () => string = newId): { doc: Canvas; ids: string[] } {
  const room = MAX_NODES - doc.nodes.length;
  if (!clip.nodes.length || room <= 0) return { doc, ids: [] };
  const nodes = clip.nodes.slice(0, room);
  const b = boundsOf(nodes)!;
  const dx = at ? at.x - b.x : GRID * 2;
  const dy = at ? at.y - b.y : GRID * 2;
  const fresh = new Map(nodes.map((n) => [n.id, makeId()]));
  const added = nodes.map((n) => ({ ...n, id: fresh.get(n.id)!, x: clampCoord(n.x + dx), y: clampCoord(n.y + dy) }) as CanvasNode);
  const edges = clip.edges
    .filter((e) => fresh.has(e.fromNode) && fresh.has(e.toNode))
    .slice(0, Math.max(0, MAX_EDGES - doc.edges.length))
    .map((e) => ({ ...e, id: makeId(), fromNode: fresh.get(e.fromNode)!, toNode: fresh.get(e.toNode)! }));
  return { doc: { nodes: [...doc.nodes, ...added], edges: [...doc.edges, ...edges] }, ids: added.map((n) => n.id) };
}

/** A new card centred on a world point, snapped to the grid. */
export function placeNode<T extends CanvasNode["type"]>(type: T, center: Point, extra: Omit<Extract<CanvasNode, { type: T }>, "id" | "type" | "x" | "y" | "width" | "height"> & Partial<Size>, makeId: () => string = newId) {
  const { width = DEFAULT_SIZE[type].width, height = DEFAULT_SIZE[type].height, ...rest } = extra as Partial<Size> & Record<string, unknown>;
  return { ...rest, id: makeId(), type, x: snap(center.x - width / 2), y: snap(center.y - height / 2), width, height } as unknown as Extract<CanvasNode, { type: T }>;
}

// ─── The API's shape ─────────────────────────────────────────────────────────

const round = (v: number) => Math.round(v);

/**
 * The canvas as the API keeps it: whole points, sizes and places in range, fields that don't
 * belong to a card's type left out, and the defaults (fromEnd none, toEnd arrow) omitted.
 */
export function toApi(doc: Canvas): Canvas {
  const nodes = doc.nodes.map((n): CanvasNode => {
    const base = {
      id: n.id,
      x: round(clampCoord(n.x)),
      y: round(clampCoord(n.y)),
      width: round(clampSize(n.width)),
      height: round(clampSize(n.height)),
      ...(isColor(n.color) ? { color: n.color } : {}),
    };
    switch (n.type) {
      case "text":
        return { ...base, type: "text", html: n.html ?? "" };
      case "page":
        return { ...base, type: "page", page_id: n.page_id };
      case "link":
        return {
          ...base,
          type: "link",
          url: n.url,
          ...(n.title ? { title: n.title } : {}),
          ...(n.description ? { description: n.description } : {}),
          ...(n.image ? { image: n.image } : {}),
        };
      case "file":
        return { ...base, type: "file", src: n.src, name: n.name ?? "" };
      case "group":
        return { ...base, type: "group", ...(n.label ? { label: n.label.slice(0, MAX_LABEL) } : {}) };
    }
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = doc.edges
    .filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
    .map((e): CanvasEdge => ({
      id: e.id,
      fromNode: e.fromNode,
      ...(e.fromSide ? { fromSide: e.fromSide } : {}),
      ...(e.fromEnd && e.fromEnd !== "none" ? { fromEnd: e.fromEnd } : {}),
      toNode: e.toNode,
      ...(e.toSide ? { toSide: e.toSide } : {}),
      ...(e.toEnd && e.toEnd !== "arrow" ? { toEnd: e.toEnd } : {}),
      ...(isColor(e.color) ? { color: e.color } : {}),
      ...(e.label?.trim() ? { label: e.label.trim().replace(/\s+/g, " ").slice(0, MAX_LABEL) } : {}),
    }));
  return { nodes, edges };
}

/** A canvas read from the API or an event: arrays always there. */
export function fromApi(c: Canvas | null | undefined): Canvas {
  return { nodes: c?.nodes ?? [], edges: c?.edges ?? [] };
}

/** One spelling of a canvas whatever its keys' order, to tell whether two are the same. */
export function canonical(doc: Canvas): string {
  return JSON.stringify(toApi(doc), (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}

// ─── Undo and redo (this tab's own) ──────────────────────────────────────────

export const HISTORY_LIMIT = 100;

export type History = {
  past: Canvas[];
  present: Canvas;
  future: Canvas[];
  /** The canvas before a gesture under way (a drag, a resize): the gesture is one step. */
  base: Canvas | null;
};

/** A canvas, or how to make the next one from the current one. */
export type NextDoc = Canvas | ((doc: Canvas) => Canvas);

export type HistoryAction =
  | { type: "set"; doc: NextDoc }
  | { type: "preview"; doc: NextDoc }
  /** Changes the canvas without a step of its own (a link card's preview arriving). */
  | { type: "amend"; doc: NextDoc }
  | { type: "commit" }
  | { type: "cancel" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; doc: Canvas };

export const initHistory = (doc: Canvas): History => ({ past: [], present: doc, future: [], base: null });

const pushPast = (past: Canvas[], doc: Canvas) => [...past, doc].slice(-HISTORY_LIMIT);

const resolve = (next: NextDoc, cur: Canvas) => (typeof next === "function" ? next(cur) : next);

export function historyReducer(h: History, a: HistoryAction): History {
  switch (a.type) {
    case "set": {
      const doc = resolve(a.doc, h.present);
      if (doc === h.present) return h;
      return { past: pushPast(h.past, h.base ?? h.present), present: doc, future: [], base: null };
    }
    case "preview": {
      const doc = resolve(a.doc, h.present);
      return doc === h.present ? h : { ...h, base: h.base ?? h.present, present: doc };
    }
    case "amend": {
      const doc = resolve(a.doc, h.present);
      return doc === h.present ? h : { ...h, present: doc };
    }
    case "commit":
      if (!h.base) return h;
      if (h.base === h.present) return { ...h, base: null };
      return { past: pushPast(h.past, h.base), present: h.present, future: [], base: null };
    case "cancel":
      return h.base ? { ...h, present: h.base, base: null } : h;
    case "undo": {
      if (h.base || !h.past.length) return h;
      return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future], base: null };
    }
    case "redo": {
      if (h.base || !h.future.length) return h;
      return { past: pushPast(h.past, h.present), present: h.future[0]!, future: h.future.slice(1), base: null };
    }
    case "reset":
      // Someone else's canvas replaces this one: steps back would undo their work too.
      return initHistory(a.doc);
  }
}

// ─── Text ────────────────────────────────────────────────────────────────────

/** The cards and connections as plain words, for the list screen readers get. */
export function nodeLabel(n: CanvasNode, text: (html: string) => string, pageTitle: (id: string) => string | null): string {
  switch (n.type) {
    case "text":
      return text(n.html);
    case "page":
      return pageTitle(n.page_id) ?? "";
    case "link":
      return n.title || n.url;
    case "file":
      return n.name || n.src;
    case "group":
      return n.label ?? "";
  }
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
export const isImageName = (name: string) => IMAGE_NAME.test(name.split("?")[0] ?? "");

/** A link the API takes on a link card: https only. */
export function cleanUrl(raw: string): string | null {
  const s = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" || !u.hostname || /[\s"'<>]/.test(withScheme)) return null;
    return withScheme;
  } catch {
    return null;
  }
}

/** An image or file address the wiki loads in place: https or one of our attachments. */
export const WIKI_SRC = /^(https:\/\/[^\s"'<>]+|\/v1\/attachments\/[0-9a-f-]{36}(\?[^\s"'<>]*)?)$/i;
