// The wiki graph's data and force layout, without the DOM, so it can be tested.
import type { WikiLink, WikiNode } from "@/lib/api/types";

export type GNode = {
  id: string;
  title: string;
  icon: string;
  /** Its top-level ancestor's id: pages under one top-level page share a colour. */
  group: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Held in place, while it is dragged. */
  fixed?: boolean;
};

export type GEdge = { a: number; b: number; kind: "link" | "subpage" };

export type Graph = { nodes: GNode[]; edges: GEdge[] };

export type GraphOptions = {
  /** Draw a page's subpages as edges too. */
  subpageLinks: boolean;
  /** Keep pages with no edges. */
  orphans: boolean;
  /** The page the graph is about: always kept. */
  focus?: string;
  /** With focus, keep only pages this many hops away. */
  depth?: number;
  tag?: string;
  query?: string;
};

export const LINK_DISTANCE = 70;
/** The simulation is at rest below this. */
export const ALPHA_MIN = 0.005;
/** About 300 ticks from 1 to ALPHA_MIN, like d3. */
const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300);

export const titleOf = (title: string) => title.trim() || "Untitled";

/** A node's radius in world units: grows gently with its edges. */
export const radius = (degree: number) => Math.min(3.5 + Math.sqrt(degree) * 1.6, 16);

export function buildGraph(nodes: WikiNode[], links: WikiLink[], opts: GraphOptions): Graph {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Undirected and deduped: links first, so a link that is also a subpage edge draws solid.
  const pairs = new Map<string, { a: string; b: string; kind: GEdge["kind"] }>();
  const add = (a: string, b: string, kind: GEdge["kind"]) => {
    if (a === b || !byId.has(a) || !byId.has(b)) return;
    const key = a < b ? `${a} ${b}` : `${b} ${a}`;
    if (!pairs.has(key)) pairs.set(key, { a, b, kind });
  };
  for (const l of links) add(l.from, l.to, "link");
  if (opts.subpageLinks) for (const n of nodes) if (n.parent_id) add(n.parent_id, n.id, "subpage");

  const adj = new Map<string, string[]>();
  for (const { a, b } of pairs.values()) {
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }

  let keep = new Set(byId.keys());
  const focus = opts.focus && byId.has(opts.focus) ? opts.focus : undefined;
  if (focus && opts.depth) {
    keep = new Set([focus]);
    let ring = [focus];
    for (let hop = 0; hop < opts.depth; hop++) {
      const next: string[] = [];
      for (const id of ring) {
        for (const m of adj.get(id) ?? []) {
          if (keep.has(m)) continue;
          keep.add(m);
          next.push(m);
        }
      }
      ring = next;
    }
  }
  const tag = opts.tag?.toLowerCase();
  const query = opts.query?.trim().toLowerCase();
  for (const id of keep) {
    if (id === focus) continue;
    const n = byId.get(id)!;
    if (tag && !n.tags.includes(tag)) keep.delete(id);
    else if (query && !titleOf(n.title).toLowerCase().includes(query)) keep.delete(id);
  }

  const edges = [...pairs.values()].filter((e) => keep.has(e.a) && keep.has(e.b));
  if (!opts.orphans) {
    const linked = new Set(edges.flatMap((e) => [e.a, e.b]));
    for (const id of keep) if (id !== focus && !linked.has(id)) keep.delete(id);
  }

  const out: GNode[] = nodes
    .filter((n) => keep.has(n.id))
    .map((n) => ({ id: n.id, title: titleOf(n.title), icon: n.icon, group: topOf(n, byId), degree: 0, x: 0, y: 0, vx: 0, vy: 0 }));
  const index = new Map(out.map((n, i) => [n.id, i]));
  const gEdges = edges.map((e) => ({ a: index.get(e.a)!, b: index.get(e.b)!, kind: e.kind }));
  for (const e of gEdges) {
    out[e.a].degree++;
    out[e.b].degree++;
  }
  seed(out);
  return { nodes: out, edges: gEdges };
}

function topOf(n: WikiNode, byId: Map<string, WikiNode>): string {
  // Bounded walk: a broken parent chain must not loop forever.
  let cur = n;
  for (let i = 0; i < byId.size && cur.parent_id; i++) {
    const up = byId.get(cur.parent_id);
    if (!up) break;
    cur = up;
  }
  return cur.id;
}

/** Deterministic start positions on a sunflower spiral, so layouts and tests repeat. */
export function seed(nodes: GNode[]) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((n, i) => {
    const r = 12 * Math.sqrt(i + 0.5);
    n.x = r * Math.cos(i * golden);
    n.y = r * Math.sin(i * golden);
    n.vx = n.vy = 0;
  });
}

export type StepOptions = { charge?: number; linkDistance?: number; gravity?: number; damping?: number };

/** Above this many nodes repulsion is approximated on a grid. */
const EXACT_MAX = 600;

/** One tick of the simulation. Mutates the nodes. */
export function step(g: Graph, alpha: number, opts: StepOptions = {}) {
  const { charge = 140, linkDistance = LINK_DISTANCE, gravity = 0.04, damping = 0.4 } = opts;
  const ns = g.nodes;
  if (ns.length > EXACT_MAX) repelGrid(ns, charge * alpha);
  else repelExact(ns, charge * alpha);

  // Springs, weighted like d3: a hub's edges pull it less than they pull its leaves.
  for (const e of g.edges) {
    const a = ns[e.a];
    const b = ns[e.b];
    const dx = b.x + b.vx - a.x - a.vx || 0.01;
    const dy = b.y + b.vy - a.y - a.vy || 0.01;
    const d = Math.hypot(dx, dy);
    const f = ((d - linkDistance) / d) * alpha * (1 / Math.min(a.degree, b.degree));
    const bias = a.degree / (a.degree + b.degree);
    b.vx -= dx * f * bias;
    b.vy -= dy * f * bias;
    a.vx += dx * f * (1 - bias);
    a.vy += dy * f * (1 - bias);
  }

  for (const n of ns) {
    if (n.fixed) {
      n.vx = n.vy = 0;
      continue;
    }
    // Gravity keeps loose pages and separate clusters in view.
    n.vx = (n.vx - n.x * gravity * alpha) * (1 - damping);
    n.vy = (n.vy - n.y * gravity * alpha) * (1 - damping);
    n.x += n.vx;
    n.y += n.vy;
  }
}

/** Cools alpha one tick towards 0. */
export const cool = (alpha: number) => alpha - alpha * ALPHA_DECAY;

/** Runs the simulation to rest at once: tests and reduced motion. */
export function settle(g: Graph, ticks = 300, alpha = 1) {
  for (let i = 0; i < ticks && alpha > ALPHA_MIN; i++) {
    step(g, alpha);
    alpha = cool(alpha);
  }
}

function push(n: GNode, dx: number, dy: number, strength: number) {
  // Below one unit apart the push stops growing, so coincident nodes never explode.
  const d2 = Math.max(dx * dx + dy * dy, 1);
  const w = strength / d2;
  n.vx += dx * w;
  n.vy += dy * w;
}

function repelExact(ns: GNode[], strength: number) {
  for (let i = 0; i < ns.length; i++) {
    const a = ns[i];
    for (let j = i + 1; j < ns.length; j++) {
      const b = ns[j];
      // Coincident nodes split along a direction fixed by their indexes, not at random.
      const dx = a.x - b.x || (i - j) * 0.01;
      const dy = a.y - b.y || (j - i) * 0.007;
      push(a, dx, dy, strength);
      push(b, -dx, -dy, strength);
    }
  }
}

/**
 * Exact repulsion from the nine nearest cells; farther cells push as one body
 * from their centre of mass, worked out once per cell rather than per node.
 */
function repelGrid(ns: GNode[], strength: number) {
  const grid = Math.min(48, Math.max(16, Math.round(Math.sqrt(ns.length / 3))));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of ns) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  const size = Math.max(maxX - minX, maxY - minY, 1) / grid + 1e-6;
  const cellOf = (v: number, min: number) => Math.min(grid - 1, Math.floor((v - min) / size));
  const cells: number[][] = Array.from({ length: grid * grid }, () => []);
  const cx = new Float64Array(grid * grid);
  const cy = new Float64Array(grid * grid);
  const at = new Int32Array(ns.length);
  ns.forEach((n, i) => {
    const c = cellOf(n.y, minY) * grid + cellOf(n.x, minX);
    at[i] = c;
    cells[c].push(i);
    cx[c] += n.x;
    cy[c] += n.y;
  });
  const full: number[] = [];
  for (let c = 0; c < cells.length; c++) {
    if (!cells[c].length) continue;
    full.push(c);
    cx[c] /= cells[c].length;
    cy[c] /= cells[c].length;
  }

  // Far field, per cell: the force a unit body at the cell's centre feels.
  const fx = new Float64Array(grid * grid);
  const fy = new Float64Array(grid * grid);
  for (const c of full) {
    for (const o of full) {
      if (Math.abs((c % grid) - (o % grid)) <= 1 && Math.abs(Math.floor(c / grid) - Math.floor(o / grid)) <= 1) continue;
      const dx = cx[c] - cx[o];
      const dy = cy[c] - cy[o];
      const w = (strength * cells[o].length) / Math.max(dx * dx + dy * dy, 1);
      fx[c] += dx * w;
      fy[c] += dy * w;
    }
  }

  ns.forEach((a, i) => {
    const c = at[i];
    a.vx += fx[c];
    a.vy += fy[c];
    const col = c % grid;
    const row = (c - col) / grid;
    for (let r = Math.max(0, row - 1); r <= Math.min(grid - 1, row + 1); r++) {
      for (let k = Math.max(0, col - 1); k <= Math.min(grid - 1, col + 1); k++) {
        for (const j of cells[r * grid + k]) if (j !== i) push(a, a.x - ns[j].x || (i - j) * 0.01, a.y - ns[j].y || (j - i) * 0.007, strength);
      }
    }
  });
}

export type View = { x: number; y: number; k: number };

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;
export const clampZoom = (k: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));

/** The view that shows every node in a width x height box, never zoomed past 1.5. */
export function fitView(nodes: GNode[], width: number, height: number, pad = 32): View {
  if (!nodes.length) return { x: width / 2, y: height / 2, k: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const r = radius(n.degree);
    minX = Math.min(minX, n.x - r);
    minY = Math.min(minY, n.y - r);
    maxX = Math.max(maxX, n.x + r);
    maxY = Math.max(maxY, n.y + r);
  }
  const k = clampZoom(Math.min((width - 2 * pad) / (maxX - minX), (height - 2 * pad) / (maxY - minY), 1.5));
  return { x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k, k };
}
