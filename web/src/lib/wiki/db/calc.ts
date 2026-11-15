// The calculations under a table's columns and a group's header, as Notion offers them.

import type { DbCalc, DbProperty, DbPropType, DbRow } from "../../api/types";
import { formatAggregate, rollup } from "./aggregate";
import { startOf } from "./cell";
import type { DbContext } from "./context";
import { cellValue, numberFormatOf, resultKind, type ValueKind } from "./values";

export { rollup, type AggregateFn } from "./aggregate";

const COUNTS = ["none", "count", "count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty"] as const;
const NUMBERS = [...COUNTS, "sum", "avg", "median", "min", "max", "range"] as const;
const DATES = [...COUNTS, "earliest", "latest", "range"] as const;
const CHECKS = ["none", "count", "checked", "unchecked", "percent_checked"] as const;
const ANY: readonly DbCalc[] = [...new Set<DbCalc>([...NUMBERS, ...DATES, ...CHECKS])];

/** The calculations each type offers. A formula or rollup offers those of its result's kind: see calcsFor. */
export const CALCS_FOR: Record<DbPropType, readonly DbCalc[]> = {
  title: COUNTS,
  text: COUNTS,
  url: COUNTS,
  email: COUNTS,
  phone: COUNTS,
  number: NUMBERS,
  unique_id: NUMBERS,
  select: COUNTS,
  multi_select: COUNTS,
  status: COUNTS,
  person: COUNTS,
  relation: COUNTS,
  ticket: COUNTS,
  files: COUNTS,
  created_by: COUNTS,
  edited_by: COUNTS,
  checkbox: CHECKS,
  date: DATES,
  created_time: DATES,
  edited_time: DATES,
  formula: ANY,
  rollup: ANY,
};

const BY_KIND: Record<ValueKind, readonly DbCalc[]> = { text: COUNTS, select: COUNTS, status: COUNTS, list: COUNTS, number: NUMBERS, date: DATES, checkbox: CHECKS };

/** The calculations a property offers, a formula's or rollup's by what it gives for these rows. */
export function calcsFor(prop: DbProperty, rows: readonly DbRow[], ctx: DbContext): readonly DbCalc[] {
  if (prop.type !== "formula" && prop.type !== "rollup") return CALCS_FOR[prop.type];
  const kind = resultKind(prop, rows, ctx);
  return kind ? BY_KIND[kind] : CALCS_FOR[prop.type];
}

/** A column's calculation over rows, as text: "12", "42%", "€1,250.00", "3 days"; "" for none. */
export function calculate(rows: readonly DbRow[], prop: DbProperty, calc: DbCalc, ctx: DbContext): string {
  if (calc === "none") return "";
  const values = rows.map((r) => cellValue(r, prop, ctx));
  const dates = values.some((v) => startOf(v) !== null);
  const time = prop.type === "created_time" || prop.type === "edited_time" || prop.date_time === true;
  return formatAggregate(rollup(values, calc), calc, { dates, time, format: numberFormatOf(prop, ctx) });
}
