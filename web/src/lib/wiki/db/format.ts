// Numbers, dates and text the way cells, calculations and search show them, in the
// reader's locale: nothing here is English.

import type { DbNumberFormat } from "../../api/types";

const formats = new Map<string, Intl.NumberFormat>();

function nf(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let f = formats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(undefined, options);
    formats.set(key, f);
  }
  return f;
}

/** A number in a property's format; percent reads 0.42 as 42%, as Notion does. */
export function formatNumber(n: number, format: DbNumberFormat = "number"): string {
  if (!Number.isFinite(n)) return "";
  switch (format) {
    case "number":
      return nf({ useGrouping: false, maximumFractionDigits: 8 }).format(n);
    case "comma":
      return nf({ maximumFractionDigits: 8 }).format(n);
    case "percent":
      return nf({ style: "percent", maximumFractionDigits: 2 }).format(n);
    default:
      return nf({ style: "currency", currency: format.toUpperCase() }).format(n);
  }
}

/** A count: whole, grouped. */
export function formatCount(n: number): string {
  return nf({ maximumFractionDigits: 0 }).format(n);
}

/** A fraction as a percentage: 0.42 → 42%. */
export function formatPercent(f: number): string {
  return nf({ style: "percent", maximumFractionDigits: 1 }).format(f);
}

/** A length of time in days ("3 days"), or hours under a day. */
export function formatDays(days: number): string {
  if (days !== 0 && Math.abs(days) < 1) {
    return nf({ style: "unit", unit: "hour", unitDisplay: "long", maximumFractionDigits: 0 }).format(days * 24);
  }
  return nf({ style: "unit", unit: "day", unitDisplay: "long", maximumFractionDigits: 0 }).format(days);
}

const dateFormats = new Map<boolean, Intl.DateTimeFormat>();

/** A short date, with the time of day when asked. */
export function formatDate(d: Date, withTime = false): string {
  if (Number.isNaN(d.getTime())) return "";
  let f = dateFormats.get(withTime);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
    dateFormats.set(withTime, f);
  }
  return f.format(d);
}

/** Text folded for matching: lower case, without accents. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
