// Summing up a list of cell values: a rollup over related pages, and a view's
// calculation over its rows, both the way Notion counts.

import { differenceInMinutes } from "date-fns";
import type { DbCalc, DbNumberFormat } from "../../api/types";
import { endOf, isDateRange, isEmpty, startOf, type CellValue } from "./cell";
import { formatCount, formatDate, formatDays, formatNumber, formatPercent } from "./format";

/** A way to sum values up: a calculation or a rollup function, without "none" and "show_original". */
export type AggregateFn = Exclude<DbCalc, "none">;

const COUNTS: ReadonlySet<AggregateFn> = new Set(["count", "count_values", "count_unique", "count_empty", "count_not_empty", "checked", "unchecked"]);
const PERCENTS: ReadonlySet<AggregateFn> = new Set(["percent_empty", "percent_not_empty", "percent_checked"]);

/** Functions whose result is in the values' own unit, so it keeps their number format. */
export const KEEPS_FORMAT: ReadonlySet<AggregateFn> = new Set(["sum", "avg", "median", "min", "max", "range"]);

function uniqueKeys(v: CellValue): string[] {
  if (isEmpty(v)) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : x.url));
  if (v instanceof Date) return [`d${v.getTime()}`];
  if (isDateRange(v)) return [`r${v.start.getTime()}-${v.end?.getTime() ?? ""}`];
  return [`${typeof v}:${String(v)}`];
}

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Sums values up. Counts and sums of nothing are 0; averages, extremes and dates of
 * nothing are null. Percentages are fractions. min, max and range work on dates as
 * well, a date range in days.
 */
export function rollup(values: readonly CellValue[], fn: AggregateFn): number | Date | null {
  const total = values.length;
  const filled = values.filter((v) => !isEmpty(v)).length;
  const checked = values.filter((v) => v === true).length;
  switch (fn) {
    case "count":
      return total;
    case "count_values":
      return values.reduce<number>((n, v) => n + (isEmpty(v) ? 0 : Array.isArray(v) ? v.length : 1), 0);
    case "count_unique":
      return new Set(values.flatMap(uniqueKeys)).size;
    case "count_empty":
      return total - filled;
    case "count_not_empty":
      return filled;
    case "percent_empty":
      return total ? (total - filled) / total : 0;
    case "percent_not_empty":
      return total ? filled / total : 0;
    case "checked":
      return checked;
    case "unchecked":
      return values.filter((v) => v === false).length;
    case "percent_checked":
      return total ? checked / total : 0;
  }
  const numbers = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const starts = values.map(startOf).filter((d): d is Date => d !== null);
  if (!numbers.length && starts.length && fn !== "sum" && fn !== "avg" && fn !== "median") {
    const earliest = new Date(Math.min(...starts.map((d) => d.getTime())));
    const ends = values.map(endOf).filter((d): d is Date => d !== null);
    const latest = new Date(Math.max(...ends.map((d) => d.getTime())));
    if (fn === "range") return differenceInMinutes(latest, earliest) / (24 * 60);
    return fn === "earliest" || fn === "min" ? earliest : latest;
  }
  if (fn === "sum") return numbers.reduce((a, b) => a + b, 0);
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  switch (fn) {
    case "avg":
      return numbers.reduce((a, b) => a + b, 0) / numbers.length;
    case "median":
      return median(sorted);
    case "min":
      return sorted[0];
    case "max":
      return sorted[sorted.length - 1];
    case "range":
      return sorted[sorted.length - 1] - sorted[0];
    default:
      // earliest and latest of values that aren't dates.
      return null;
  }
}

export type AggregateText = {
  /** The values were dates: a range is a length of time. */
  dates: boolean;
  /** The values' number format, for results in their unit. */
  format?: DbNumberFormat;
  /** Dates have a time of day. */
  time?: boolean;
};

/** A summed-up value as a view shows it: counts whole, percentages, sums in the values' format. */
export function formatAggregate(result: number | Date | null, fn: AggregateFn, opts: AggregateText): string {
  if (result === null) return "";
  if (result instanceof Date) return formatDate(result, opts.time);
  if (PERCENTS.has(fn)) return formatPercent(result);
  if (COUNTS.has(fn)) return formatCount(result);
  if (fn === "range" && opts.dates) return formatDays(result);
  return formatNumber(result, opts.format ?? "number");
}
