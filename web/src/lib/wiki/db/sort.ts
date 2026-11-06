// A view's sorts: by each key in turn, empty values last whichever the direction, and the
// rows' own order (their position) for ties.

import type { DbProperty, DbRow, DbSort } from "../../api/types";
import { isDateRange, isEmpty, type CellValue } from "./cell";
import type { DbContext } from "./context";
import { cellText, cellValue, statusGroupOf } from "./values";

/** What a value sorts by: a number, text, or numbers in turn (a status's group then option). */
export type SortKey = number | string | number[];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const STATUS_GROUPS = ["todo", "doing", "done"];

function optionIndex(prop: DbProperty, id: string): number {
  const i = prop.options?.findIndex((o) => o.id === id) ?? -1;
  return i < 0 ? Infinity : i;
}

/** Where a status option stands: its group (to do, in progress, done), then its place there. */
export function statusRank(prop: DbProperty, id: string): number[] {
  const group = statusGroupOf(prop, id);
  const g = group ? STATUS_GROUPS.indexOf(group) : STATUS_GROUPS.length;
  const within = prop.groups?.find((x) => x.id === group)?.option_ids.indexOf(id) ?? -1;
  return [g, within < 0 ? optionIndex(prop, id) : within];
}

/** A value's sort key; null for an empty one. */
export function sortKey(value: CellValue, prop: DbProperty, ctx: DbContext): SortKey | null {
  if (typeof value === "boolean") return Number(value);
  if (isEmpty(value) || value === null) return null;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (isDateRange(value)) return value.start.getTime();
  switch (prop.type) {
    case "select":
      return optionIndex(prop, value as string);
    case "status":
      return statusRank(prop, value as string);
    case "multi_select":
      return (value as string[]).map((id) => optionIndex(prop, id));
  }
  return typeof value === "string" ? value : cellText(value, prop, ctx);
}

export function compareKeys(a: SortKey, b: SortKey): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return collator.compare(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }
  // A formula giving numbers on some rows and text on others: numbers first.
  const rank = (k: SortKey) => (typeof k === "number" ? 0 : Array.isArray(k) ? 1 : 2);
  return rank(a) - rank(b);
}

/** Rows in a view's order; without sorts, in their own order. */
export function sortRows(rows: DbRow[], sorts: DbSort[] | undefined, ctx: DbContext): DbRow[] {
  const keys = (sorts ?? []).flatMap((s) => {
    const prop = ctx.db.properties.find((p) => p.id === s.property);
    return prop ? [{ prop, dir: s.dir === "desc" ? -1 : 1 }] : [];
  });
  // Each cell is worked out once, not at every comparison: formulas can be slow.
  const decorated = rows.map((row, i) => ({ row, i, keys: keys.map((k) => sortKey(cellValue(row, k.prop, ctx), k.prop, ctx)) }));
  decorated.sort((a, b) => {
    for (let k = 0; k < keys.length; k++) {
      const x = a.keys[k];
      const y = b.keys[k];
      if (x === null || y === null) {
        if (x === y) continue;
        return x === null ? 1 : -1;
      }
      const c = compareKeys(x, y);
      if (c) return c * keys[k].dir;
    }
    return a.row.position - b.row.position || a.i - b.i;
  });
  return decorated.map((d) => d.row);
}
