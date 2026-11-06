// The shape of a cell's value once read, whatever the property's type.

import type { DbFile } from "../../api/types";

/** A date property's value. `time`: the value has a time of day worth showing. */
export type DateRange = { start: Date; end?: Date; time: boolean };

/**
 * A cell's value, by property type:
 * - string: title, text, url, email, phone; the option id of a select or status;
 *   a formula's text.
 * - number: number, unique_id (the prefix is only added in text), rollup sums and counts
 *   (percentages as fractions, 0.42).
 * - boolean: checkbox (never empty), a formula's yes or no.
 * - Date: created_time, edited_time, earliest/latest rollups, a formula's date.
 * - DateRange: date, a formula's date range.
 * - string[]: ids of multi_select options, people (person, created_by, edited_by),
 *   related pages and tickets; a show_original rollup's values as text.
 * - DbFile[]: files.
 * - null: no value.
 */
export type CellValue = string | number | boolean | Date | DateRange | string[] | DbFile[] | null;

export function isDateRange(v: unknown): v is DateRange {
  return typeof v === "object" && v !== null && !(v instanceof Date) && !Array.isArray(v) && (v as DateRange).start instanceof Date;
}

/** Empty as filters, calculations and grouping see it; false and 0 are values. */
export function isEmpty(value: CellValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** The moment a date-like value starts at, else null. */
export function startOf(value: CellValue): Date | null {
  if (value instanceof Date) return value;
  if (isDateRange(value)) return value.start;
  return null;
}

/** The moment a date-like value ends at: a range's end, else its start. */
export function endOf(value: CellValue): Date | null {
  if (isDateRange(value)) return value.end ?? value.start;
  return startOf(value);
}
