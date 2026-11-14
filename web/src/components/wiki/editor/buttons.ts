// Button blocks (Notion's buttons, contracts/wiki.md "Blocks"): what a button does, and the
// values a "new row" button presets, read back from the block's data-props. Pure, so the view
// and its tests share them.

import type { DbProperty, DbValue } from "@/lib/api/types";
import { isUuid } from "@/lib/wiki/desk";

export const BUTTON_ACTIONS = ["template", "todo", "link", "row"] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];
export const isButtonAction = (v: unknown): v is ButtonAction => BUTTON_ACTIONS.includes(v as ButtonAction);

/** The longest label the API keeps (hd.SanitizeWiki), and the longest data-props. */
export const MAX_LABEL = 100;
export const MAX_PROPS = 1000;

/** A label as kept: no control characters (line breaks, tabs), at most MAX_LABEL characters. */
export function cleanLabel(v: string | null | undefined): string {
  return [...(v ?? "")]
    .filter((c) => {
      const n = c.codePointAt(0)!;
      return n > 31 && n !== 127;
    })
    .join("")
    .slice(0, MAX_LABEL);
}

export type ButtonAttrs = { label: string; action: ButtonAction | ""; template: string; database: string; url: string; title: string; props: string };

/** Whether a button has what its action needs: a template, a link, a database. */
export function buttonReady(a: ButtonAttrs): boolean {
  switch (a.action) {
    case "template":
      return isUuid(a.template);
    case "link":
      return /^https:\/\/[^\s"'<>]+$/i.test(a.url);
    case "row":
      return isUuid(a.database);
    case "todo":
      return true;
    default:
      return false;
  }
}

/** The property types a button can preset, and how each value is checked. */
const PRESETS: Partial<Record<DbProperty["type"], (v: unknown, p: DbProperty) => boolean>> = {
  text: (v) => typeof v === "string",
  url: (v) => typeof v === "string" && /^https?:\/\//i.test(v),
  email: (v) => typeof v === "string",
  phone: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  checkbox: (v) => typeof v === "boolean",
  select: (v, p) => typeof v === "string" && !!p.options?.some((o) => o.id === v),
  status: (v, p) => typeof v === "string" && !!p.options?.some((o) => o.id === v),
};

export const presettable = (p: DbProperty) => p.type in PRESETS;

/** A button's stored values (data-props), as an object; anything else is none. */
export function parsePresets(raw: string): Record<string, unknown> {
  if (!raw || raw.length > MAX_PROPS + 2) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The values a new row starts with: those of the stored presets that fit the database's
 * properties as they are now (a property deleted or retyped since, or an option removed,
 * is left out). Empty strings are no value.
 */
export function cleanPresets(raw: string, properties: readonly DbProperty[]): Record<string, DbValue> {
  const stored = parsePresets(raw);
  const out: Record<string, DbValue> = {};
  for (const p of properties) {
    const check = PRESETS[p.type];
    const v = stored[p.id];
    if (!check || v === undefined || v === null || v === "") continue;
    if (check(v, p)) out[p.id] = v as DbValue;
  }
  return out;
}

/** Presets as stored: only set values, and nothing when there are none or they don't fit. */
export function storePresets(values: Record<string, DbValue>): string {
  const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  if (!Object.keys(set).length) return "";
  const s = JSON.stringify(set);
  return s.length <= MAX_PROPS + 2 ? s : "";
}
