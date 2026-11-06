// Reading a row's cells: stored values checked against their property, and the computed
// ones (title, times, authors, unique ids, formulas, rollups) worked out.

import { isValid, parseISO } from "date-fns";
import type { DbFile, DbNumberFormat, DbOption, DbProperty, DbPropType, DbRow, DbStatusGroup, DbValue } from "../../api/types";
import { formatAggregate, KEEPS_FORMAT, rollup } from "./aggregate";
import { isDateRange, isEmpty, type CellValue, type DateRange } from "./cell";
import { relatedContext, type DbContext } from "./context";
import { formatDate, formatNumber } from "./format";
// formula.ts reads cells through cellValue and cellValue works formulas out through it:
// the two call each other, never at load time.
import { evaluateProperty, isFormulaError } from "./formula";
import { guarded } from "./guard";

export { isEmpty, isDateRange, type CellValue, type DateRange };

/** Types the database works out; a row never stores them (the unique id is set once by the API). */
export const COMPUTED_TYPES: ReadonlySet<DbPropType> = new Set(["title", "rollup", "formula", "created_time", "created_by", "edited_time", "edited_by", "unique_id"]);

/** How values of a type compare and filter. Formulas and rollups have the kind of their result. */
export type ValueKind = "text" | "number" | "select" | "status" | "list" | "checkbox" | "date";

export function kindOfType(type: DbPropType): ValueKind | null {
  switch (type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return "text";
    case "number":
    case "unique_id":
      return "number";
    case "select":
      return "select";
    case "status":
      return "status";
    case "multi_select":
    case "person":
    case "relation":
    case "ticket":
    case "files":
    case "created_by":
    case "edited_by":
      return "list";
    case "checkbox":
      return "checkbox";
    case "date":
    case "created_time":
    case "edited_time":
      return "date";
    case "formula":
    case "rollup":
      return null;
  }
}

/** The kind of a computed value; null when it is empty. */
export function kindOfValue(value: CellValue): ValueKind | null {
  if (isEmpty(value)) return null;
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  if (Array.isArray(value)) return "list";
  return "date";
}

/** The kind of a property's values: a formula's or rollup's from the first row with a value. */
export function resultKind(prop: DbProperty, rows: readonly DbRow[], ctx: DbContext): ValueKind | null {
  const fixed = kindOfType(prop.type);
  if (fixed) return fixed;
  for (const row of rows) {
    const k = kindOfValue(cellValue(row, prop, ctx));
    if (k) return k;
  }
  return null;
}

export function optionOf(prop: DbProperty, id: string): DbOption | undefined {
  return prop.options?.find((o) => o.id === id);
}

/** The status group an option is in; null for an option of no group. */
export function statusGroupOf(prop: DbProperty, optionId: string): DbStatusGroup["id"] | null {
  return prop.groups?.find((g) => g.option_ids.includes(optionId))?.id ?? null;
}

function parseDate(s: string): Date | null {
  const d = parseISO(s);
  return isValid(d) ? d : null;
}

function dateValue(v: DbValue | undefined, prop: DbProperty): DateRange | null {
  if (typeof v !== "object" || v === null || Array.isArray(v) || typeof v.start !== "string") return null;
  const start = parseDate(v.start);
  if (!start) return null;
  const end = v.end ? (parseDate(v.end) ?? undefined) : undefined;
  return { start, end, time: prop.date_time === true || v.start.includes("T") };
}

function ids(v: DbValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function isFile(v: unknown): v is DbFile {
  return typeof v === "object" && v !== null && typeof (v as DbFile).url === "string" && typeof (v as DbFile).name === "string";
}

/** A row's value of a property, stored or worked out. */
export function cellValue(row: DbRow, prop: DbProperty, ctx: DbContext): CellValue {
  const v = row.props[prop.id];
  switch (prop.type) {
    case "title":
      return row.title;
    case "text":
    case "url":
    case "email":
    case "phone":
      return typeof v === "string" && v !== "" ? v : null;
    case "number":
    case "unique_id":
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    case "select":
    case "status":
      // A value of an option since removed reads as none.
      return typeof v === "string" && optionOf(prop, v) ? v : null;
    case "multi_select":
      return ids(v).filter((id) => optionOf(prop, id));
    case "person":
    case "relation":
    case "ticket":
      return ids(v);
    case "checkbox":
      return v === true;
    case "date":
      return dateValue(v, prop);
    case "files":
      return Array.isArray(v) ? v.filter(isFile) : [];
    case "created_time":
      return parseDate(row.created_at);
    case "edited_time":
      return parseDate(row.updated_at);
    case "created_by": {
      const id = row.created_by?.id ?? row.created_by_id;
      return id ? [id] : [];
    }
    case "edited_by":
      return row.updated_by ? [row.updated_by.id] : [];
    case "formula": {
      const r = evaluateProperty(row, prop, ctx);
      return isFormulaError(r) ? null : r;
    }
    case "rollup":
      return rollupValue(row, prop, ctx);
  }
}

/** The pages a row's relation names, in its order; pages not loaded are left out. */
export function relatedRows(row: DbRow, relation: DbProperty, ctx: DbContext): DbRow[] {
  if (relation.type !== "relation" || !relation.database_id) return [];
  const rows = ctx.rowsByDb.get(relation.database_id) ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids(row.props[relation.id]).flatMap((id) => byId.get(id) ?? []);
}

const TITLE: DbProperty = { id: "title", name: "Name", type: "title" };

/** What a rollup reads: its relation, the related database's property, and that database's context. */
export function rollupSource(prop: DbProperty, ctx: DbContext): { relation: DbProperty; target: DbProperty; ctx: DbContext } | null {
  const r = prop.rollup;
  if (prop.type !== "rollup" || !r) return null;
  const relation = ctx.db.properties.find((p) => p.id === r.relation && p.type === "relation");
  if (!relation?.database_id) return null;
  const sub = relatedContext(ctx, relation.database_id);
  const target = sub?.db.properties.find((p) => p.id === r.property);
  if (sub && target) return { relation, target, ctx: sub };
  // Every database has a title, even when its schema isn't loaded.
  if (r.property !== "title") return null;
  return { relation, target: TITLE, ctx: sub ?? { ...ctx, db: { properties: [TITLE], views: [], next_id: 1 } } };
}

function rollupValue(row: DbRow, prop: DbProperty, ctx: DbContext): CellValue {
  const src = rollupSource(prop, ctx);
  const fn = prop.rollup?.fn;
  if (!src || !fn) return null;
  return guarded(
    `${row.id}:${prop.id}`,
    () => {
      const values = relatedRows(row, src.relation, ctx).map((r) => cellValue(r, src.target, src.ctx));
      if (fn === "show_original") return values.flatMap((v) => cellTexts(v, src.target, src.ctx));
      return rollup(values, fn);
    },
    () => null,
  );
}

/** The number format a property's numbers show in. */
export function numberFormatOf(prop: DbProperty, ctx: DbContext): DbNumberFormat | undefined {
  if (prop.type === "number") return prop.number_format;
  const fn = prop.rollup?.fn;
  if (prop.type === "rollup" && fn && fn !== "show_original" && KEEPS_FORMAT.has(fn)) return rollupSource(prop, ctx)?.target.number_format;
  return undefined;
}

function hasTime(d: Date): boolean {
  return d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0;
}

function dateText(d: Date, prop: DbProperty): string {
  switch (prop.type) {
    case "created_time":
    case "edited_time":
      return formatDate(d, true);
    case "date":
      return formatDate(d, prop.date_time === true || hasTime(d));
    default:
      return formatDate(d, hasTime(d));
  }
}

function titleText(row: DbRow | undefined, ctx: DbContext): string {
  return row?.title || ctx.untitled || "Untitled";
}

function idText(id: string, prop: DbProperty, ctx: DbContext): string | null {
  switch (prop.type) {
    case "multi_select":
      return optionOf(prop, id)?.name ?? null;
    case "person":
    case "created_by":
    case "edited_by":
      return ctx.members.get(id)?.name ?? null;
    case "relation": {
      const row = prop.database_id ? ctx.rowsByDb.get(prop.database_id)?.find((r) => r.id === id) : undefined;
      return row ? titleText(row, ctx) : null;
    }
    case "ticket": {
      const t = ctx.tickets?.get(id);
      return t ? `#${t.number} ${t.subject}` : null;
    }
    default:
      return id;
  }
}

function scalarText(value: string | number | boolean | Date | DateRange, prop: DbProperty, ctx: DbContext): string {
  if (typeof value === "string") return prop.type === "select" || prop.type === "status" ? (optionOf(prop, value)?.name ?? "") : value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return dateText(value, prop);
  if (isDateRange(value)) {
    const start = formatDate(value.start, value.time);
    return value.end ? `${start} → ${formatDate(value.end, value.time)}` : start;
  }
  if (prop.type === "unique_id") return prop.prefix ? `${prop.prefix}-${value}` : String(value);
  if (prop.type === "rollup" && prop.rollup && prop.rollup.fn !== "show_original") {
    const target = rollupSource(prop, ctx)?.target;
    const dates = target ? kindOfType(target.type) === "date" : false;
    return formatAggregate(value, prop.rollup.fn, { dates, format: numberFormatOf(prop, ctx) });
  }
  return formatNumber(value, numberFormatOf(prop, ctx));
}

/** A value's parts as text: one per option, person, page, ticket or file; a single one otherwise. Unknown ids are left out. */
export function cellTexts(value: CellValue, prop: DbProperty, ctx: DbContext): string[] {
  if (isEmpty(value) || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((x) => {
      const s = typeof x === "string" ? idText(x, prop, ctx) : x.name;
      return s === null ? [] : [s];
    });
  }
  return [scalarText(value, prop, ctx)];
}

/** A value as plain text: what a cell shows, search matches and an export writes. */
export function cellText(value: CellValue, prop: DbProperty, ctx: DbContext): string {
  return cellTexts(value, prop, ctx).join(", ");
}
