// A board's columns and a table's or list's groups. Options keep their order, status
// options sit in their group's (to do, in progress, done), and rows without a value
// gather in a last "no value" group.

import { differenceInCalendarDays, format, startOfDay } from "date-fns";
import type { DbOption, DbProperty, DbRow, DbTone, DbViewSettings } from "../../api/types";
import { isEmpty, startOf, type CellValue } from "./cell";
import type { DbContext } from "./context";
import { formatDate } from "./format";
import { compareKeys, sortKey, statusRank, type SortKey } from "./sort";
import { cellTexts, cellValue } from "./values";

export type Group = {
  key: string;
  /** The value as text; "" for the no-value group, which the UI names. */
  label: string;
  color?: DbTone;
  option?: DbOption;
  rows: DbRow[];
  /** No row is in it. */
  empty: boolean;
};

/** The key of the group of rows without a value. */
export const NO_VALUE = "__none__";

type Entry = { key: string; label: string; sort: SortKey };

/** The groups one value puts its row in; [] for none. */
function entries(value: CellValue, prop: DbProperty, ctx: DbContext): Entry[] {
  if (isEmpty(value) || value === null) return [];
  const d = startOf(value);
  if (d) {
    const day = startOfDay(d);
    return [{ key: format(day, "yyyy-MM-dd"), label: formatDate(day), sort: day.getTime() }];
  }
  if (Array.isArray(value)) {
    // One group per person, page, ticket or file, named as shown.
    return value.map((x) => {
      const label = typeof x === "string" ? (cellTexts([x], prop, ctx)[0] ?? "") : x.name;
      return { key: typeof x === "string" ? x : x.url, label, sort: label };
    });
  }
  const label = cellTexts(value, prop, ctx)[0] ?? "";
  const key = typeof value === "boolean" ? String(value) : typeof value === "number" ? String(value) : label;
  return [{ key, label, sort: sortKey(value, prop, ctx) ?? label }];
}

// cellValue already dropped ids of removed options.
function optionIds(value: CellValue): string[] {
  return Array.isArray(value) ? (value as string[]) : typeof value === "string" ? [value] : [];
}

function optionGroups(prop: DbProperty): DbOption[] {
  const options = prop.options ?? [];
  if (prop.type !== "status") return options;
  return [...options].sort((a, b) => compareKeys(statusRank(prop, a.id), statusRank(prop, b.id)));
}

/** Rows by a property's values, in the rows' order within each group. */
export function groupRows(rows: DbRow[], propId: string, ctx: DbContext, settings?: DbViewSettings): Group[] {
  const prop = ctx.db.properties.find((p) => p.id === propId);
  if (!prop) return [{ key: "__all__", label: "", rows, empty: !rows.length }];
  const groups = new Map<string, Group & { sort: SortKey }>();
  const none: Group = { key: NO_VALUE, label: "", rows: [], empty: true };
  const fixed = prop.type === "select" || prop.type === "multi_select" || prop.type === "status";

  // Options and the two checkbox states are columns even before a row has them.
  if (fixed) {
    optionGroups(prop).forEach((o, i) => groups.set(o.id, { key: o.id, label: o.name, color: o.color, option: o, rows: [], empty: true, sort: i }));
  } else if (prop.type === "checkbox") {
    groups.set("false", { key: "false", label: "false", rows: [], empty: true, sort: 0 });
    groups.set("true", { key: "true", label: "true", rows: [], empty: true, sort: 1 });
  }

  for (const row of rows) {
    const value = cellValue(row, prop, ctx);
    const found = fixed ? optionIds(value).map((id) => ({ key: id, label: "", sort: 0 })) : entries(value, prop, ctx);
    if (!found.length) none.rows.push(row);
    for (const e of found) {
      let g = groups.get(e.key);
      if (!g) {
        g = { key: e.key, label: e.label, rows: [], empty: true, sort: e.sort };
        groups.set(e.key, g);
      }
      // A value listed twice in one row puts it in its group once.
      if (g.rows[g.rows.length - 1] !== row) g.rows.push(row);
    }
  }

  const list: Group[] = [...groups.values()]
    .sort((a, b) => compareKeys(a.sort, b.sort))
    .map(({ sort: _sort, ...g }) => g);
  if (prop.type !== "checkbox") list.push(none);
  for (const g of list) g.empty = g.rows.length === 0;
  return settings?.hide_empty_groups ? list.filter((g) => !g.empty) : list;
}

/** Where a date stands from today, for grouping by relative dates. */
export type DateBucket = "today" | "yesterday" | "tomorrow" | "past_7" | "past_30" | "older" | "next_7" | "next_30" | "later";

export function dateBucket(date: Date, now: Date): DateBucket {
  const days = differenceInCalendarDays(date, now);
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  if (days < 0) return days >= -7 ? "past_7" : days >= -30 ? "past_30" : "older";
  return days <= 7 ? "next_7" : days <= 30 ? "next_30" : "later";
}
