// What a chart view plots: the rows grouped by its x property (groupRows), each group's
// value (a count, or the sum or average of a number property), the order the groups show
// in, the tail folded into one "other" group, and clean axis ticks. Pure: no React, no DOM.

import type { DbNumberFormat, DbProperty, DbRow, DbTone, DbViewSettings } from "@/lib/api/types";
import { cellValue, formatCount, formatNumber, formatPercent, groupRows, NO_VALUE, numberFormatOf, rollup, type DbContext } from "@/lib/wiki/db";

export type ChartSettings = NonNullable<DbViewSettings["chart"]>;

export type ChartPoint = {
  key: string;
  label: string;
  /** The option's tone when the x property has options; grey for "no value" there. */
  tone?: DbTone;
  value: number;
  rows: DbRow[];
};

export type ChartData = {
  x: DbProperty;
  y?: DbProperty;
  fn: "count" | "sum" | "avg";
  points: ChartPoint[];
  /** A value exactly: counts whole, sums and averages in the y property's format. */
  format: (n: number) => string;
  /** A value on a mark: the same unit, without cents on whole amounts, compact from 10,000. */
  short: (n: number) => string;
  /** An axis tick: as short, compact from 1,000 so the ticks of one axis read alike. */
  tick: (n: number) => string;
};

/** What the UI calls groups the engine leaves unnamed. */
export type ChartLabels = { none: string; checked: string; unchecked: string };

const OPTION_TYPES = new Set(["select", "multi_select", "status"]);
const ORDERED_TYPES = new Set(["select", "multi_select", "status", "checkbox", "date", "created_time", "edited_time"]);

/** Groups whose order means something (options, checkbox, dates) keep it; others go largest first. */
export function chartData(rows: DbRow[], chart: ChartSettings | undefined, ctx: DbContext, labels: ChartLabels, lang?: string): ChartData | null {
  const x = chart?.x ? ctx.db.properties.find((p) => p.id === chart.x) : undefined;
  if (!x || !rows.length) return null;
  const y = chart?.y ? ctx.db.properties.find((p) => p.id === chart.y!.property) : undefined;
  const fn = y ? (chart?.y?.fn ?? "sum") : "count";
  const measure = (list: DbRow[]) => measureRows(list, y, fn, ctx);
  const options = OPTION_TYPES.has(x.type);
  let points: ChartPoint[] = groupRows(rows, x.id, ctx)
    .filter((g) => !(g.key === NO_VALUE && g.empty))
    .map((g) => ({
      key: g.key,
      label: g.key === NO_VALUE ? labels.none : x.type === "checkbox" ? (g.key === "true" ? labels.checked : labels.unchecked) : g.label,
      tone: options ? (g.color ?? "gray") : undefined,
      value: measure(g.rows),
      rows: g.rows,
    }));
  if (!ORDERED_TYPES.has(x.type)) points = [...points].sort((a, b) => b.value - a.value);
  const numberFormat = y ? numberFormatOf(y, ctx) : undefined;
  const format = (n: number) => (fn === "count" ? formatCount(n) : formatNumber(fn === "avg" ? Math.round(n * 100) / 100 : n, numberFormat));
  const unit = fn === "count" ? "number" : (numberFormat ?? "number");
  return { x, y, fn, points, format, short: (n) => shortNumber(n, unit, lang), tick: (n) => shortNumber(n, unit, lang, 1000) };
}

const shorts = new Map<string, Intl.NumberFormat>();

/** A number for a mark or an axis tick: whole amounts without cents, compact from `compactFrom`, percentages as such. */
export function shortNumber(n: number, format: DbNumberFormat, lang?: string, compactFrom = 10_000): string {
  if (format === "percent") return formatPercent(n);
  const big = Math.abs(n) >= compactFrom;
  const currency = format !== "number" && format !== "comma";
  const whole = big || Number.isInteger(n);
  const options: Intl.NumberFormatOptions = {
    notation: big ? "compact" : "standard",
    minimumFractionDigits: whole || !currency ? 0 : 2,
    maximumFractionDigits: big ? 1 : whole ? 0 : 2,
    ...(currency ? { style: "currency", currency: format.toUpperCase() } : {}),
  };
  const key = `${lang}|${JSON.stringify(options)}`;
  let f = shorts.get(key);
  if (!f) {
    f = new Intl.NumberFormat(lang, options);
    shorts.set(key, f);
  }
  return f.format(n);
}

/** A group's value: its row count, or the sum or average of the y property's numbers (0 with none). */
export function measureRows(rows: DbRow[], y: DbProperty | undefined, fn: "count" | "sum" | "avg", ctx: DbContext): number {
  if (!y || fn === "count") return rows.length;
  const r = rollup(
    rows.map((row) => cellValue(row, y, ctx)),
    fn,
  );
  return typeof r === "number" && Number.isFinite(r) ? r : 0;
}

/**
 * At most `keep` groups: the rest become one "other" group measured over their rows
 * together (an average of averages would be wrong), each row once.
 */
export function foldTail(data: ChartData, keep: number, label: string, ctx: DbContext): ChartPoint[] {
  if (data.points.length <= keep) return data.points;
  const head = data.points.slice(0, keep - 1);
  const rest = data.points.slice(keep - 1);
  const rows = [...new Set(rest.flatMap((p) => p.rows))];
  return [...head, { key: "__other__", label, tone: rest[0].tone ? "gray" : undefined, value: measureRows(rows, data.y, data.fn, ctx), rows }];
}

/** Axis ticks over [lo, hi] in 1, 2 or 5 steps, always including 0. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  const a = Math.min(0, lo);
  const b = Math.max(0, hi);
  if (a === b) return [0, 1];
  const raw = (b - a) / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(a / step) * step; v <= Math.ceil(b / step) * step + step / 2; v += step) out.push(Math.round(v * 1e9) / 1e9);
  return out;
}
