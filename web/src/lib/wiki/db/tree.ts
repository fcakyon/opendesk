// Sub-items (contracts/wiki.md "Databases"): rows nested under the row their parent item
// names. A view's rows are already filtered and sorted; the tree keeps that order on every
// level, and a row whose parent isn't among them sits at the top.

import type { DbRow, DbValue } from "../../api/types";

/** What nesting reads of a row. */
export type RowRef = Pick<DbRow, "id" | "props">;

export type TreeRow = { row: DbRow; depth: number; children: TreeRow[] };
/** A row as a nested list draws it. */
export type FlatRow = { row: DbRow; depth: number; hasChildren: boolean; open: boolean };

const firstId = (v: DbValue | undefined): string | null => (Array.isArray(v) && typeof v[0] === "string" ? v[0] : null);

/**
 * Each row's parent among rows. A loop of parents (a row its own grandparent) is cut at the
 * row that comes first, which goes to the top.
 */
export function parentsOf(rows: readonly RowRef[], parentProp: string): Map<string, string> {
  const index = new Map(rows.map((r, i) => [r.id, i]));
  const parent = new Map<string, string>();
  for (const r of rows) {
    const p = firstId(r.props[parentProp]);
    if (p && p !== r.id && index.has(p)) parent.set(r.id, p);
  }
  const settled = new Set<string>();
  for (const r of rows) {
    for (;;) {
      const path: string[] = [];
      let cur: string | undefined = r.id;
      while (cur !== undefined && !settled.has(cur) && !path.includes(cur)) {
        path.push(cur);
        cur = parent.get(cur);
      }
      if (cur === undefined || settled.has(cur)) {
        path.forEach((id) => settled.add(id));
        break;
      }
      const loop = path.slice(path.indexOf(cur));
      const first = loop.reduce((a, b) => (index.get(a)! <= index.get(b)! ? a : b));
      parent.delete(first);
    }
  }
  return parent;
}

/** The rows as a tree under their parent items, each level in the rows' order. */
export function buildTree(rows: readonly DbRow[], parentProp: string): TreeRow[] {
  const parent = parentsOf(rows, parentProp);
  const kids = new Map<string, DbRow[]>();
  const roots: DbRow[] = [];
  for (const r of rows) {
    const p = parent.get(r.id);
    if (p) kids.set(p, [...(kids.get(p) ?? []), r]);
    else roots.push(r);
  }
  const grow = (r: DbRow, depth: number): TreeRow => ({ row: r, depth, children: (kids.get(r.id) ?? []).map((c) => grow(c, depth + 1)) });
  return roots.map((r) => grow(r, 0));
}

/** The tree as lines: a row's sub-items follow it while it is open. */
export function flattenTree(tree: readonly TreeRow[], open: ReadonlySet<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (list: readonly TreeRow[]) => {
    for (const n of list) {
      const isOpen = open.has(n.row.id);
      out.push({ row: n.row, depth: n.depth, hasChildren: n.children.length > 0, open: isOpen });
      if (isOpen) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** The rows nested under a row, however deep, by every row of the database. */
export function descendantIds(rows: readonly RowRef[], parentProp: string, id: string): Set<string> {
  const parent = parentsOf(rows, parentProp);
  const kids = new Map<string, string[]>();
  for (const [child, p] of parent) kids.set(p, [...(kids.get(p) ?? []), child]);
  const out = new Set<string>();
  const stack = [...(kids.get(id) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    if (out.has(c) || c === id) continue;
    out.add(c);
    stack.push(...(kids.get(c) ?? []));
  }
  return out;
}

/** The rows a row is nested under, nearest first. */
export function ancestorIds(rows: readonly RowRef[], parentProp: string, id: string): string[] {
  const parent = parentsOf(rows, parentProp);
  const out: string[] = [];
  for (let p = parent.get(id); p && !out.includes(p) && p !== id; p = parent.get(p)) out.push(p);
  return out;
}
