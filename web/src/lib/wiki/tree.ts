// The wiki's tree, built from the flat list GET /v1/wiki/pages returns
// (contracts/wiki.md), and the moves the tree panel makes on it. Pure: the panel,
// the cache patcher and the mock share these.

import type { WikiArea, WikiNode } from "../api/types";

export const MAX_DEPTH = 10;
/** Characters in a title; the API refuses longer ones. */
export const MAX_TITLE = 200;

export type Tree = {
  byId: Map<string, WikiNode>;
  /** Children of a parent id ("" is the top level), in order. */
  kids: Map<string, WikiNode[]>;
};

const key = (parent: string | null) => parent ?? "";

export function buildTree(nodes: readonly WikiNode[]): Tree {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, WikiNode[]>();
  for (const n of nodes) {
    // A page whose parent is not in the list (a stale cache) shows at the top level.
    const k = n.parent_id && byId.has(n.parent_id) ? n.parent_id : "";
    const list = kids.get(k);
    if (list) list.push(n);
    else kids.set(k, [n]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  return { byId, kids };
}

export function childrenOf(tree: Tree, parent: string | null): WikiNode[] {
  return tree.kids.get(key(parent)) ?? [];
}

/** The pages above id, the top-level one first. */
export function ancestorsOf(tree: Tree, id: string): WikiNode[] {
  const out: WikiNode[] = [];
  let cur = tree.byId.get(id)?.parent_id ?? null;
  while (cur && out.length < 64) {
    const n = tree.byId.get(cur);
    if (!n) break;
    out.unshift(n);
    cur = n.parent_id;
  }
  return out;
}

/** Every page under id (not id itself). */
export function descendantsOf(tree: Tree, id: string): WikiNode[] {
  const out: WikiNode[] = [];
  const walk = (p: string) => {
    for (const c of tree.kids.get(p) ?? []) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

/** How many levels the page spans with its subpages (1: none). */
export function heightOf(tree: Tree, id: string): number {
  const kids = tree.kids.get(id) ?? [];
  return 1 + kids.reduce((m, c) => Math.max(m, heightOf(tree, c.id)), 0);
}

/**
 * Whether me created the page and everything under it (contracts/wiki.md "Access"): "yes";
 * "page" when someone else created the page; "subpages" when they created one under it.
 * A page not in the tree is "yes", and the API decides.
 */
export type Ownership = "yes" | "page" | "subpages";

export function ownership(tree: Tree, id: string, me: string | undefined): Ownership {
  const n = tree.byId.get(id);
  if (!n) return "yes";
  if (n.created_by_id !== me) return "page";
  return descendantsOf(tree, id).every((d) => d.created_by_id === me) ? "yes" : "subpages";
}

/**
 * Where a page goes: under parent at position; at the top level, in space and area
 * (contracts/pages.md) when they change.
 */
export type Drop = { parent: string | null; position: number; space?: SpaceKey; area?: WikiArea };

const areaOf = (n: Pick<WikiNode, "area">): WikiArea => n.area ?? "wiki";

/**
 * The space a page lives in (contracts/wiki.md "Private pages and teamspaces"): "workspace",
 * "private" or "team:<id>". The sidebar shows one section per space.
 */
export type SpaceKey = "workspace" | "private" | `team:${string}`;

export function spaceOf(n: Pick<WikiNode, "private" | "team_id">): SpaceKey {
  if (n.private) return "private";
  if (n.team_id) return `team:${n.team_id}`;
  return "workspace";
}

/** The API's way of naming a space in create and move. */
export function spaceBody(key: SpaceKey): { space: "workspace" | "private" | "team"; team_id?: string } {
  if (key === "private" || key === "workspace") return { space: key };
  return { space: "team", team_id: key.slice(5) };
}

/** The part of the tree in one space: its pages, its top-level pages at the top. */
export function spaceTree(nodes: readonly WikiNode[], key: SpaceKey): Tree {
  return buildTree(nodes.filter((n) => spaceOf(n) === key));
}

/**
 * Whether id may go under parent: never under itself or a subpage, and no deeper than
 * MAX_DEPTH with what it takes along.
 */
export function canPlace(tree: Tree, id: string, parent: string | null): boolean {
  if (!parent) return true;
  if (parent === id) return false;
  const up = ancestorsOf(tree, parent);
  if (up.some((a) => a.id === id)) return false;
  return up.length + 1 + heightOf(tree, id) <= MAX_DEPTH;
}

/** The pages "Move to…" offers for id, in tree order with their depth: those canPlace takes. */
export function moveTargets(tree: Tree, id: string): { node: WikiNode; depth: number }[] {
  const out: { node: WikiNode; depth: number }[] = [];
  const walk = (parent: string, depth: number) => {
    for (const n of tree.kids.get(parent) ?? []) {
      if (n.id === id) continue;
      if (canPlace(tree, id, n.id)) out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

/** Moving id under parent with "Move to…": last among its new siblings. */
export function moveToEnd(tree: Tree, id: string, parent: string | null): Drop {
  return { parent, position: childrenOf(tree, parent).filter((c) => c.id !== id).length };
}

export type Zone = "before" | "inside" | "after";

/** Where a drop on target's row puts the dragged page, as the API's move takes it. */
export function dropFor(tree: Tree, dragged: string, target: string, zone: Zone): Drop | null {
  return dropIn(tree, tree, dragged, target, zone);
}

/**
 * dropFor in one section of the sidebar: the target and its siblings are view's (one
 * space), while what the dragged page takes along is in full (it may come from another
 * space). A drop at the top level of another space carries that space.
 */
export function dropIn(view: Tree, full: Tree, dragged: string, target: string, zone: Zone, space?: SpaceKey, area?: WikiArea): Drop | null {
  const t = view.byId.get(target);
  if (!t || dragged === target) return null;
  const fits = (parent: string | null) => canPlace(full, dragged, parent);
  if (zone === "inside") {
    const kids = childrenOf(view, target).filter((c) => c.id !== dragged);
    return fits(target) ? { parent: target, position: kids.length } : null;
  }
  const siblings = childrenOf(view, t.parent_id).filter((c) => c.id !== dragged);
  const at = siblings.findIndex((c) => c.id === target);
  if (!fits(t.parent_id)) return null;
  const drop: Drop = { parent: t.parent_id, position: zone === "before" ? at : at + 1 };
  const from = full.byId.get(dragged);
  if (!t.parent_id && space && from && spaceOf(from) !== space) drop.space = space;
  if (!t.parent_id && area && from && areaOf(from) !== area) drop.area = area;
  return drop;
}

/**
 * The nodes after moving id to drop, positions renumbered as the API does: top-level pages
 * are numbered within their area and space, and the moved page with its subpages takes on
 * the area and space of where it lands.
 */
export function applyMove(nodes: readonly WikiNode[], id: string, drop: Drop): WikiNode[] {
  const moving = nodes.find((n) => n.id === id);
  if (!moving) return nodes.slice();
  const tree = buildTree(nodes);
  const parentNode = drop.parent ? tree.byId.get(drop.parent) : undefined;
  const toSpace: SpaceKey = parentNode ? spaceOf(parentNode) : (drop.space ?? spaceOf(moving));
  const fromSpace = spaceOf(moving);
  const fromArea = areaOf(moving);
  const toArea = parentNode ? areaOf(parentNode) : (drop.area ?? fromArea);
  const inSpace = (s: SpaceKey, a: WikiArea = toArea) => (n: WikiNode) => n.parent_id !== null || (spaceOf(n) === s && areaOf(n) === a);
  const from = moving.parent_id;
  const target = childrenOf(tree, drop.parent).filter((c) => c.id !== id && inSpace(toSpace)(c));
  target.splice(Math.max(0, Math.min(drop.position, target.length)), 0, { ...moving, parent_id: drop.parent });
  const pos = new Map<string, { parent: string | null; position: number }>();
  target.forEach((n, i) => pos.set(n.id, { parent: drop.parent, position: i }));
  if (key(from) !== key(drop.parent) || fromSpace !== toSpace || fromArea !== toArea) {
    childrenOf(tree, from)
      .filter((c) => c.id !== id && inSpace(fromSpace, fromArea)(c))
      .forEach((n, i) => pos.set(n.id, { parent: from, position: i }));
  }
  const taken = new Set([id, ...descendantsOf(tree, id).map((d) => d.id)]);
  const look = toSpace === "private" ? { private: true, team_id: null } : toSpace === "workspace" ? { private: false, team_id: null } : { private: false, team_id: toSpace.slice(5) };
  return nodes.map((n) => {
    const p = pos.get(n.id);
    let next = p && (p.parent !== n.parent_id || p.position !== n.position) ? { ...n, parent_id: p.parent, position: p.position } : n;
    if (fromSpace !== toSpace && taken.has(n.id)) next = { ...next, ...look };
    if (fromArea !== toArea && taken.has(n.id)) next = { ...next, area: toArea };
    return next;
  });
}

/** The nodes without id and its subpages, the old siblings renumbered. */
export function removeSubtree(nodes: readonly WikiNode[], ids: readonly string[]): WikiNode[] {
  const gone = new Set(ids);
  const left = nodes.filter((n) => !gone.has(n.id));
  const tree = buildTree(left);
  const pos = new Map<string, number>();
  for (const list of tree.kids.values()) list.forEach((n, i) => pos.set(n.id, i));
  return left.map((n) => (pos.get(n.id) === n.position ? n : { ...n, position: pos.get(n.id) ?? n.position }));
}

/** Inserts or replaces a node; a new one shifts the siblings at and after its position. */
export function upsertNode(nodes: readonly WikiNode[], node: WikiNode): WikiNode[] {
  const i = nodes.findIndex((n) => n.id === node.id);
  if (i >= 0) return nodes.map((n, j) => (j === i ? { ...n, ...node } : n));
  const shifted = nodes.map((n) =>
    key(n.parent_id) === key(node.parent_id) && n.position >= node.position ? { ...n, position: n.position + 1 } : n,
  );
  return [...shifted, node];
}

/** The visible rows of the tree in order, for keyboard moves: expanded pages show their subpages. */
export function visibleRows(tree: Tree, expanded: ReadonlySet<string>): { node: WikiNode; depth: number }[] {
  const out: { node: WikiNode; depth: number }[] = [];
  const walk = (parent: string, depth: number) => {
    for (const n of tree.kids.get(parent) ?? []) {
      out.push({ node: n, depth });
      if (expanded.has(n.id)) walk(n.id, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

/** Keyboard moves of a page among its neighbours (Alt+arrows): up, down, indent, outdent. */
export function keyMove(tree: Tree, id: string, dir: "up" | "down" | "in" | "out"): Drop | null {
  const n = tree.byId.get(id);
  if (!n) return null;
  const siblings = childrenOf(tree, n.parent_id);
  const at = siblings.findIndex((c) => c.id === id);
  switch (dir) {
    case "up":
      return at > 0 ? { parent: n.parent_id, position: at - 1 } : null;
    case "down":
      return at < siblings.length - 1 ? { parent: n.parent_id, position: at + 1 } : null;
    case "in": {
      // Under the sibling above, at its end.
      const prev = siblings[at - 1];
      if (!prev || !canPlace(tree, id, prev.id)) return null;
      return { parent: prev.id, position: childrenOf(tree, prev.id).length };
    }
    case "out": {
      // After the parent, among its siblings.
      const parent = n.parent_id ? tree.byId.get(n.parent_id) : undefined;
      if (!parent) return null;
      const up = childrenOf(tree, parent.parent_id).filter((c) => c.id !== id);
      return { parent: parent.parent_id, position: up.findIndex((c) => c.id === parent.id) + 1 };
    }
  }
}
