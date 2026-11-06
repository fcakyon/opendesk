// Dates for the calendar and timeline layouts: the span of days a row covers and its tone, the month
// grid and how ranges stack in its weeks, the timeline's scales and header ticks, and
// moving a stored date by whole days while keeping its time of day. Pure: no React, no DOM.

import { addDays, addMonths, addQuarters, addWeeks, addYears, differenceInCalendarDays, endOfMonth, endOfWeek, format, isValid, max, min, parse, parseISO, startOfDay, startOfMonth, startOfQuarter, startOfWeek, startOfYear } from "date-fns";
import type { Database, DbDate, DbProperty, DbRow, DbTone, DbValue, DbViewSettings } from "@/lib/api/types";
import { cellValue, isDateRange, optionOf, type CellValue, type DbContext } from "@/lib/wiki/db";

/** Weeks start on Monday, as every calendar in the app does. */
export const WEEK_STARTS_ON = 1;

/** The days a row covers, both included, at local midnight. */
export type DaySpan = { start: Date; end: Date };

/** A stored day: "yyyy-MM-dd". */
export const dayKey = (d: Date) => format(d, "yyyy-MM-dd");

export const daysBetween = (a: Date, b: Date) => differenceInCalendarDays(b, a);

function firstOf(v: CellValue | undefined): Date | null {
  if (v instanceof Date) return v;
  if (isDateRange(v)) return v.start;
  return null;
}

/**
 * The days a date-like value covers. An end value (the timeline's end property) wins over
 * the date's own end; an end before the start is read as the start.
 */
export function spanOf(value: CellValue, endValue?: CellValue): DaySpan | null {
  const s = firstOf(value);
  if (!s) return null;
  const start = startOfDay(s);
  const ownEnd = isDateRange(value) ? value.end : undefined;
  const otherEnd = endValue === undefined ? undefined : isDateRange(endValue) ? (endValue.end ?? endValue.start) : (firstOf(endValue) ?? undefined);
  const e = otherEnd ?? ownEnd;
  const end = e ? startOfDay(e) : start;
  return { start, end: end < start ? start : end };
}

export const spanDays = (s: DaySpan) => daysBetween(s.start, s.end) + 1;

/** The tone of a row's chip or bar: its status option's, else its first select option's. */
export function toneOf(row: DbRow, db: Database, ctx: DbContext): DbTone | undefined {
  const props = [...db.properties.filter((p) => p.type === "status"), ...db.properties.filter((p) => p.type === "select")];
  for (const prop of props) {
    const v = cellValue(row, prop, ctx);
    if (typeof v === "string") return optionOf(prop, v)?.color;
  }
  return undefined;
}

// ─── Calendar ───────────────────────────────────────────────────────────────

/** The weeks a month's grid shows: whole weeks, from the one with the 1st to the one with the last day. */
export function monthGrid(month: Date): Date[][] {
  const first = startOfWeek(startOfMonth(month), { weekStartsOn: WEEK_STARTS_ON });
  const last = endOfWeek(endOfMonth(month), { weekStartsOn: WEEK_STARTS_ON });
  const weeks: Date[][] = [];
  for (let d = first; d <= last; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  return weeks;
}

/** A row's piece of a week: from column `col` for `len` days, on `lane`. `cutStart`/`cutEnd`: the range goes on before or after this week. */
export type WeekBar = { id: string; col: number; len: number; lane: number; cutStart: boolean; cutEnd: boolean };

/**
 * How rows sit in one week: each on the first lane free for all its days, longer ranges
 * first among those starting the same day. Rows on lanes past `lanes` aren't drawn; `hidden`
 * counts them per day for "+N more".
 */
export function layoutWeek(week: Date[], items: { id: string; span: DaySpan }[], lanes: number): { bars: WeekBar[]; hidden: number[]; byDay: string[][] } {
  const first = week[0];
  const lastCol = week.length - 1;
  const inWeek = items
    .map((it, i) => ({ ...it, i, from: daysBetween(first, it.span.start), to: daysBetween(first, it.span.end) }))
    .filter((it) => it.to >= 0 && it.from <= lastCol)
    .sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from) || a.i - b.i);
  const laneEnds: number[] = [];
  const bars: WeekBar[] = [];
  const hidden = week.map(() => 0);
  const byDay: string[][] = week.map(() => []);
  for (const it of inWeek) {
    const col = Math.max(0, it.from);
    const end = Math.min(lastCol, it.to);
    let lane = laneEnds.findIndex((e) => e < col);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = end;
    for (let c = col; c <= end; c++) byDay[c].push(it.id);
    if (lane < lanes) bars.push({ id: it.id, col, len: end - col + 1, lane, cutStart: it.from < 0, cutEnd: it.to > lastCol });
    else for (let c = col; c <= end; c++) hidden[c]++;
  }
  return { bars, hidden, byDay };
}

// ─── Moving stored dates ────────────────────────────────────────────────────

/** A stored date moved by whole days: a day stays a day, a moment keeps its time of day. */
export function shiftStored(s: string, days: number): string {
  if (s.length <= 10) {
    const d = parse(s, "yyyy-MM-dd", new Date());
    return isValid(d) ? dayKey(addDays(d, days)) : s;
  }
  const d = parseISO(s);
  return isValid(d) ? addDays(d, days).toISOString() : s;
}

function asDate(v: DbValue | undefined): DbDate | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as DbDate).start === "string" ? (v as DbDate) : null;
}

/** Whether a property holds dates a person sets (not computed ones). */
export const editableDate = (p: DbProperty | undefined) => p?.type === "date";

export type DateEdit = "move" | "start" | "end";

/**
 * The values that move a row's dates by `days`: the whole span, its start or its end. With an
 * end property the end is that property's date; without one it is the date's own end. A range
 * whose end comes back to its start day becomes a single day. Null when there's nothing to move.
 */
export function editDates(props: Record<string, DbValue>, startProp: string, endProp: string | undefined, edit: DateEdit, days: number): Record<string, DbValue> | null {
  const start = asDate(props[startProp]);
  if (!start || days === 0) return null;
  const shift = (d: DbDate): DbDate => ({ start: shiftStored(d.start, days), ...(d.end ? { end: shiftStored(d.end, days) } : {}) });
  if (endProp) {
    const end = asDate(props[endProp]);
    if (edit === "move") return { [startProp]: shift(start), ...(end ? { [endProp]: shift(end) } : {}) };
    // A single day stretched from its start keeps its day as the end.
    if (edit === "start") return { [startProp]: { ...start, start: shiftStored(start.start, days) }, ...(end ? {} : { [endProp]: { start: start.start } }) };
    return { [endProp]: end ? { ...end, start: shiftStored(end.start, days) } : { start: shiftStored(start.start, days) } };
  }
  if (edit === "move") return { [startProp]: shift(start) };
  const next: DbDate = edit === "start" ? { start: shiftStored(start.start, days), end: start.end ?? start.start } : { start: start.start, end: shiftStored(start.end ?? start.start, days) };
  if (next.end && next.end.slice(0, 10) === next.start.slice(0, 10)) delete next.end;
  return { [startProp]: next };
}

/** The values that give a row without dates the days from `day` for `days` days. */
export function placeDates(startProp: string, endProp: string | undefined, day: Date, days: number): Record<string, DbValue> {
  const start = dayKey(day);
  if (days <= 1) return { [startProp]: { start } };
  const end = dayKey(addDays(day, days - 1));
  return endProp ? { [startProp]: { start }, [endProp]: { start: end } } : { [startProp]: { start, end } };
}

// ─── Timeline ───────────────────────────────────────────────────────────────

export type Scale = NonNullable<DbViewSettings["timeline_scale"]>;
export const SCALES: Scale[] = ["day", "week", "month", "quarter"];

/** Pixels per day at each zoom. */
export const DAY_WIDTH: Record<Scale, number> = { day: 40, week: 20, month: 5, quarter: 2 };

/** How many days a row placed by a click on its track gets at each zoom. */
export const PLACE_DAYS: Record<Scale, number> = { day: 1, week: 7, month: 7, quarter: 14 };

/** Days of room around the rows and today, and how far the axis grows when scrolled to an edge. */
export const PAD_DAYS: Record<Scale, number> = { day: 28, week: 70, month: 190, quarter: 380 };

export type TickUnit = "day" | "week" | "month" | "quarter" | "year";

/** The header's two rows at each zoom: the coarse unit over the fine one. */
export const HEADER: Record<Scale, [TickUnit, TickUnit]> = { day: ["month", "day"], week: ["month", "week"], month: ["year", "month"], quarter: ["quarter", "month"] };

const START: Record<TickUnit, (d: Date) => Date> = {
  day: startOfDay,
  week: (d) => startOfWeek(d, { weekStartsOn: WEEK_STARTS_ON }),
  month: startOfMonth,
  quarter: startOfQuarter,
  year: startOfYear,
};
const NEXT: Record<TickUnit, (d: Date) => Date> = {
  day: (d) => addDays(d, 1),
  week: (d) => addWeeks(d, 1),
  month: (d) => addMonths(d, 1),
  quarter: (d) => addQuarters(d, 1),
  year: (d) => addYears(d, 1),
};

/** The axis: its first and last day. */
export type Axis = { from: Date; to: Date };

/** The days the axis covers: every span and today with room around them, from a week's start to a week's end. */
export function axisOf(spans: DaySpan[], today: Date, scale: Scale, grow: { before: number; after: number } = { before: 0, after: 0 }): Axis {
  const pad = PAD_DAYS[scale];
  const lo = min([startOfDay(today), ...spans.map((s) => s.start)]);
  const hi = max([startOfDay(today), ...spans.map((s) => s.end)]);
  return {
    from: startOfWeek(addDays(lo, -pad * (1 + grow.before)), { weekStartsOn: WEEK_STARTS_ON }),
    to: endOfWeek(addDays(hi, pad * (1 + grow.after)), { weekStartsOn: WEEK_STARTS_ON }),
  };
}

/** One header cell: the unit starting at `start`, `x` px from the axis start, clipped to the axis. */
export type Tick = { start: Date; x: number; width: number };

export function ticks(axis: Axis, unit: TickUnit, dayWidth: number): Tick[] {
  const out: Tick[] = [];
  const end = addDays(axis.to, 1);
  for (let d = START[unit](axis.from); d < end; d = NEXT[unit](d)) {
    const a = d < axis.from ? axis.from : d;
    const n = NEXT[unit](d);
    const b = n > end ? end : n;
    out.push({ start: d, x: daysBetween(axis.from, a) * dayWidth, width: daysBetween(a, b) * dayWidth });
  }
  return out;
}

/** Where a span's bar sits on the axis, in px. */
export function barOf(span: DaySpan, axis: Axis, dayWidth: number): { x: number; width: number } {
  return { x: daysBetween(axis.from, span.start) * dayWidth, width: spanDays(span) * dayWidth };
}

/** The day at `x` px from the axis start. */
export const dayAt = (axis: Axis, x: number, dayWidth: number) => addDays(axis.from, Math.floor(x / dayWidth));

// ─── Formatting ─────────────────────────────────────────────────────────────

const formats = new Map<string, Intl.DateTimeFormat>();

/** A date in the app's language, with Intl's options. */
export function formatIn(lang: string, d: Date, opts: Intl.DateTimeFormatOptions): string {
  const key = lang + JSON.stringify(opts);
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(lang, opts);
    } catch {
      f = new Intl.DateTimeFormat(undefined, opts);
    }
    formats.set(key, f);
  }
  return f.format(d);
}

/** Monday to Sunday, from any week. */
export const weekdays = () => {
  const monday = startOfWeek(new Date(2026, 0, 7), { weekStartsOn: WEEK_STARTS_ON });
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
};
