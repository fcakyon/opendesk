// Relations kept in step (contracts/wiki.md "Databases"): sub-items (parent item and
// sub-items) and dependencies (blocked by and blocking) are each two relations of a database
// to itself. A change to one side is mirrored on the rows it names, here in the app: the
// API checks each value but writes only the row it is given.

import type { Database, DbValue } from "../../api/types";
import { ancestorIds, descendantIds, type RowRef } from "./tree";

/** A paired relation's other side, and whether it holds one row at most (a parent item). */
export type Pair = { partner: string; single: boolean };

/** Every paired relation of a database, by property id. */
export function pairsOf(db: Database): Map<string, Pair> {
  const out = new Map<string, Pair>();
  const s = db.sub_items;
  if (s) {
    out.set(s.parent, { partner: s.children, single: true });
    out.set(s.children, { partner: s.parent, single: false });
  }
  const d = db.dependencies;
  if (d) {
    out.set(d.blocked_by, { partner: d.blocking, single: false });
    out.set(d.blocking, { partner: d.blocked_by, single: false });
  }
  return out;
}

const ids = (v: DbValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The rows a paired relation of a row may name: never the row itself, and for sub-items
 * none that would put it under itself.
 */
export function pairChoices<R extends RowRef>(db: Database, rows: readonly R[], rowId: string, propId: string): R[] {
  const s = db.sub_items;
  let banned = new Set<string>([rowId]);
  if (s && propId === s.parent) banned = new Set([rowId, ...descendantIds(rows, s.parent, rowId)]);
  if (s && propId === s.children) banned = new Set([rowId, ...ancestorIds(rows, s.parent, rowId)]);
  return rows.filter((r) => !banned.has(r.id));
}

/**
 * The writes a change to a row's values makes, by row: the row's own values, and each row a
 * paired relation gains or loses taking or dropping it on the other side. A row moved under
 * a new parent leaves its old one. Values that would loop sub-items are left out.
 */
export function pairedWrites(db: Database, rows: readonly RowRef[], rowId: string, values: Record<string, DbValue>): Map<string, Record<string, DbValue>> {
  const pairs = pairsOf(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const writes = new Map<string, Record<string, DbValue>>([[rowId, { ...values }]]);
  const read = (id: string, prop: string): string[] => {
    const w = writes.get(id);
    return ids(w && prop in w ? w[prop] : byId.get(id)?.props[prop]);
  };
  const write = (id: string, prop: string, list: string[]) => writes.set(id, { ...writes.get(id), [prop]: list.length ? list : null });

  for (const [prop, value] of Object.entries(values)) {
    const pair = pairs.get(prop);
    if (!pair) continue;
    const allowed = new Set(pairChoices(db, rows, rowId, prop).map((r) => r.id));
    let next = [...new Set(ids(value))].filter((id) => id !== rowId && (allowed.has(id) || !byId.has(id)));
    if (pair.single) next = next.slice(0, 1);
    const before = ids(byId.get(rowId)?.props[prop]);
    write(rowId, prop, next);
    const partnerSingle = pairs.get(pair.partner)?.single ?? false;
    for (const gone of before.filter((id) => !next.includes(id))) {
      if (byId.has(gone)) write(gone, pair.partner, read(gone, pair.partner).filter((id) => id !== rowId));
    }
    for (const added of next.filter((id) => !before.includes(id))) {
      if (!byId.has(added)) continue;
      if (partnerSingle) {
        // The added row had another parent: that one no longer lists it.
        for (const old of read(added, pair.partner)) if (old !== rowId && byId.has(old)) write(old, prop, read(old, prop).filter((id) => id !== added));
        write(added, pair.partner, [rowId]);
      } else write(added, pair.partner, [...read(added, pair.partner).filter((id) => id !== rowId), rowId]);
    }
  }

  // Only what changes is written; the row's own values always are.
  for (const [id, w] of writes) {
    if (id === rowId) continue;
    const cur = byId.get(id)!;
    const changed = Object.entries(w).filter(([k, v]) => !same(ids(cur.props[k]), ids(v)));
    if (changed.length) writes.set(id, Object.fromEntries(changed));
    else writes.delete(id);
  }
  return writes;
}
