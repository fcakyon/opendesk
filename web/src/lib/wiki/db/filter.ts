// A view's filter and the search box: which rows show. As in Notion, a rule still being
// written (no value yet) or naming a removed property is ignored, not failed.

import { addDays, addMonths, endOfMonth, endOfWeek, endOfYear, startOfDay, startOfMonth, startOfWeek, startOfYear, subDays, subMonths, isValid, parseISO } from "date-fns";
import type { DbFilterGroup, DbFilterRule, DbProperty, DbPropType, DbRow, DbValue } from "../../api/types";
import { endOf, isEmpty, startOf, type CellValue } from "./cell";
import type { DbContext } from "./context";
import { fold } from "./format";
import { cellText, cellValue, kindOfType, kindOfValue, resultKind, statusGroupOf, type ValueKind } from "./values";

const EMPTINESS = ["is_empty", "is_not_empty"] as const;
const TEXT_OPS = ["is", "is_not", "contains", "does_not_contain", "starts_with", "ends_with", ...EMPTINESS] as const;
const NUMBER_OPS = ["eq", "neq", "gt", "lt", "gte", "lte", ...EMPTINESS] as const;
const SELECT_OPS = ["is", "is_not", ...EMPTINESS] as const;
const STATUS_OPS = ["is", "is_not", "group_is", ...EMPTINESS] as const;
const LIST_OPS = ["contains", "does_not_contain", ...EMPTINESS] as const;
const CHECKBOX_OPS = ["is"] as const;
const DATE_OPS = ["is", "before", "after", "on_or_before", "on_or_after", "is_relative", ...EMPTINESS] as const;

/** Values of a date rule's is_relative, against the context's now. Weeks start on Monday; past and next weeks and months run from today. */
export const RELATIVE_DATES = ["today", "tomorrow", "yesterday", "this_week", "past_week", "next_week", "this_month", "past_month", "next_month", "this_year"] as const;
export type RelativeDate = (typeof RELATIVE_DATES)[number];

const OPS_BY_KIND: Record<ValueKind, readonly string[]> = {
  text: TEXT_OPS,
  number: NUMBER_OPS,
  select: SELECT_OPS,
  status: STATUS_OPS,
  list: LIST_OPS,
  checkbox: CHECKBOX_OPS,
  date: DATE_OPS,
};

const union = (...lists: (readonly string[])[]): readonly string[] => [...new Set(lists.flat())];
const COMPUTED_OPS = union(TEXT_OPS, NUMBER_OPS, DATE_OPS, CHECKBOX_OPS);

/** The operators each type offers. A formula or rollup offers those of its result's kind: see filterOpsFor. */
export const FILTER_OPS: Record<DbPropType, readonly string[]> = {
  title: TEXT_OPS,
  text: TEXT_OPS,
  url: TEXT_OPS,
  email: TEXT_OPS,
  phone: TEXT_OPS,
  number: NUMBER_OPS,
  unique_id: NUMBER_OPS,
  select: SELECT_OPS,
  status: STATUS_OPS,
  multi_select: LIST_OPS,
  person: LIST_OPS,
  relation: LIST_OPS,
  ticket: LIST_OPS,
  files: LIST_OPS,
  created_by: LIST_OPS,
  edited_by: LIST_OPS,
  checkbox: CHECKBOX_OPS,
  date: DATE_OPS,
  created_time: DATE_OPS,
  edited_time: DATE_OPS,
  formula: COMPUTED_OPS,
  rollup: union(COMPUTED_OPS, LIST_OPS),
};

/** The operators a property offers, a formula's or rollup's by what it gives for these rows. */
export function filterOpsFor(prop: DbProperty, rows: readonly DbRow[], ctx: DbContext): readonly string[] {
  if (prop.type !== "formula" && prop.type !== "rollup") return FILTER_OPS[prop.type];
  const kind = resultKind(prop, rows, ctx);
  return kind ? OPS_BY_KIND[kind] : FILTER_OPS[prop.type];
}

// Ops that hold for a row without a value: "is not X" includes the empty ones.
const NEGATIVE = new Set(["is_not", "does_not_contain", "neq"]);

function asList(v: unknown): string[] {
  if (typeof v === "string") return v === "" ? [] : [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

function matchText(hay: string, op: string, needle: string): boolean | null {
  const h = fold(hay);
  const n = fold(needle);
  switch (op) {
    case "is":
      return h === n;
    case "is_not":
      return h !== n;
    case "contains":
      return h.includes(n);
    case "does_not_contain":
      return !h.includes(n);
    case "starts_with":
      return h.startsWith(n);
    case "ends_with":
      return h.endsWith(n);
  }
  return null;
}

function matchNumber(value: CellValue, op: string, target: number): boolean | null {
  const n = typeof value === "number" ? value : null;
  if (op === "neq") return n !== target;
  if (n === null) return NUMBER_OPS.includes(op as (typeof NUMBER_OPS)[number]) ? false : null;
  switch (op) {
    case "eq":
      return n === target;
    case "gt":
      return n > target;
    case "lt":
      return n < target;
    case "gte":
      return n >= target;
    case "lte":
      return n <= target;
  }
  return null;
}

/** The days [from, to] a relative date names. */
export function relativeRange(rel: RelativeDate, now: Date): [Date, Date] {
  const today = startOfDay(now);
  const week = { weekStartsOn: 1 } as const;
  switch (rel) {
    case "today":
      return [today, today];
    case "tomorrow":
      return [addDays(today, 1), addDays(today, 1)];
    case "yesterday":
      return [subDays(today, 1), subDays(today, 1)];
    case "this_week":
      return [startOfWeek(today, week), startOfDay(endOfWeek(today, week))];
    case "past_week":
      return [subDays(today, 7), today];
    case "next_week":
      return [today, addDays(today, 7)];
    case "this_month":
      return [startOfMonth(today), startOfDay(endOfMonth(today))];
    case "past_month":
      return [subMonths(today, 1), today];
    case "next_month":
      return [today, addMonths(today, 1)];
    case "this_year":
      return [startOfYear(today), startOfDay(endOfYear(today))];
  }
}

function ruleDay(v: unknown): number | null {
  if (typeof v !== "string" || v === "") return null;
  const d = parseISO(v);
  return isValid(d) ? startOfDay(d).getTime() : null;
}

// Dates compare by day, as a calendar reads them; a range is its start, and "is" any day within it.
function matchDate(value: CellValue, op: string, ruleValue: unknown, now: Date): boolean | null {
  const start = startOf(value);
  const end = endOf(value);
  if (op === "is_relative") {
    if (!(RELATIVE_DATES as readonly unknown[]).includes(ruleValue)) return null;
    if (!start || !end) return false;
    const [from, to] = relativeRange(ruleValue as RelativeDate, now);
    return startOfDay(start) <= to && startOfDay(end) >= from;
  }
  const day = ruleDay(ruleValue);
  if (day === null) return null;
  if (!start || !end) return false;
  const s = startOfDay(start).getTime();
  switch (op) {
    case "is":
      return s <= day && day <= startOfDay(end).getTime();
    case "before":
      return s < day;
    case "after":
      return s > day;
    case "on_or_before":
      return s <= day;
    case "on_or_after":
      return s >= day;
  }
  return null;
}

// Ids are matched exactly; text lists (files, rollups) by their words.
function matchList(value: CellValue, op: string, ruleValue: unknown, prop: DbProperty): boolean | null {
  const needles = asList(ruleValue);
  if (!needles.length) return null;
  let has: boolean;
  if (prop.type === "files" || prop.type === "rollup") {
    const items = (Array.isArray(value) ? value : []).map((x) => fold(typeof x === "string" ? x : x.name));
    has = needles.some((n) => items.some((w) => w.includes(fold(n))));
  } else {
    const items = Array.isArray(value) ? (value as string[]) : [];
    has = needles.some((n) => items.includes(n));
  }
  if (op === "contains") return has;
  if (op === "does_not_contain") return !has;
  return null;
}

/** Whether a row passes one rule; null when the rule is ignored. */
function matchRule(row: DbRow, rule: DbFilterRule, ctx: DbContext): boolean | null {
  const prop = ctx.db.properties.find((p) => p.id === rule.property);
  if (!prop) return null;
  const value = cellValue(row, prop, ctx);
  if (rule.op === "is_empty") return isEmpty(value);
  if (rule.op === "is_not_empty") return !isEmpty(value);
  const kind = kindOfType(prop.type) ?? kindOfValue(value);
  if (kind === "checkbox" && rule.op === "is") {
    if (typeof rule.value === "boolean") return value === rule.value;
    if (rule.value === "true" || rule.value === "false") return value === (rule.value === "true");
    return null;
  }
  if (rule.value === undefined || rule.value === null || rule.value === "" || (Array.isArray(rule.value) && !rule.value.length)) return null;
  // A formula or rollup without a value has no kind: only "not" rules hold.
  if (!kind) return NEGATIVE.has(rule.op);
  switch (kind) {
    case "text":
      return typeof rule.value === "string" ? matchText(typeof value === "string" ? value : "", rule.op, rule.value) : null;
    case "number": {
      const target = typeof rule.value === "number" ? rule.value : typeof rule.value === "string" ? Number(rule.value) : NaN;
      return Number.isFinite(target) ? matchNumber(value, rule.op, target) : null;
    }
    case "select":
    case "status": {
      const v = typeof value === "string" ? value : null;
      if (rule.op === "group_is") return v !== null && statusGroupOf(prop, v) === rule.value;
      const ids = asList(rule.value);
      if (rule.op === "is") return v !== null && ids.includes(v);
      if (rule.op === "is_not") return v === null || !ids.includes(v);
      return null;
    }
    case "list":
      return matchList(value, rule.op, rule.value, prop);
    case "date":
      return matchDate(value, rule.op, rule.value, ctx.now);
    case "checkbox":
      return null;
  }
}

function isGroup(r: DbFilterRule | DbFilterGroup): r is DbFilterGroup {
  return Array.isArray((r as DbFilterGroup).rules);
}

function matchGroup(row: DbRow, group: DbFilterGroup, ctx: DbContext): boolean | null {
  let counted = false;
  for (const r of group.rules) {
    const m = isGroup(r) ? matchGroup(row, r, ctx) : matchRule(row, r, ctx);
    if (m === null) continue;
    counted = true;
    if (group.op === "or" && m) return true;
    if (group.op !== "or" && !m) return false;
  }
  if (!counted) return null;
  return group.op !== "or";
}

/** Whether a row passes a view's filter: groups of rules joined by and/or, nested. */
export function matchesFilter(row: DbRow, group: DbFilterGroup | undefined, ctx: DbContext): boolean {
  return !group || matchGroup(row, group, ctx) !== false;
}

export function filterRows(rows: DbRow[], group: DbFilterGroup | undefined, ctx: DbContext): DbRow[] {
  return group ? rows.filter((r) => matchesFilter(r, group, ctx)) : rows;
}

/** Rows with every word of the query in their cells' text, ignoring case and accents. */
export function searchRows(rows: DbRow[], query: string, ctx: DbContext, props: readonly DbProperty[] = ctx.db.properties): DbRow[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((row) => {
    const hay = props.map((p) => fold(cellText(cellValue(row, p, ctx), p, ctx))).join("\n");
    return words.every((w) => hay.includes(w));
  });
}

/** The values a new row starts with so it shows in a view, as in Notion: from the rules an
 * "and" filter needs (directly, not inside or-groups) that name one value of a stored property. */
export function filterDefaults(group: DbFilterGroup | undefined, db: { properties: DbProperty[] }): Record<string, DbValue> {
  const out: Record<string, DbValue> = {};
  if (!group || group.op !== "and") return out;
  for (const r of group.rules) {
    if ("rules" in r || r.value === undefined || r.value === "") continue;
    const prop = db.properties.find((p) => p.id === r.property);
    if (!prop) continue;
    const v = r.value;
    switch (prop.type) {
      case "text":
      case "url":
      case "email":
      case "phone":
        if (r.op === "is" && typeof v === "string") out[prop.id] = v;
        break;
      case "number":
        if (r.op === "eq" && Number.isFinite(Number(v))) out[prop.id] = Number(v);
        break;
      case "select":
      case "status":
        if (r.op === "is" && typeof v === "string" && prop.options?.some((o) => o.id === v)) out[prop.id] = v;
        break;
      case "multi_select":
      case "person":
        if (r.op === "contains" && typeof v === "string") out[prop.id] = [...((out[prop.id] as string[] | undefined) ?? []), v];
        break;
      case "checkbox":
        if (r.op === "is") out[prop.id] = v === true || v === "true";
        break;
      case "date":
        if (r.op === "is" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) out[prop.id] = { start: v };
        break;
    }
  }
  return out;
}
