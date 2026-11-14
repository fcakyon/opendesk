// A member's order of the rows inside built-in sidebar sections (contracts/collab.md "Row
// order"): row keys spelled like `hidden`'s, by section. Rows the order does not name keep
// their usual order after the ones it does; keys naming nothing are kept, and skipped.

import type { SidebarPrefs, SidebarSectionId } from "../api/types";

/** The built-in sections whose rows a member orders. Views follow the workspace's view order, Pages the shared page tree. */
export const ORDERED_SECTIONS = ["inbox", "mail", "teams", "workspace"] as const satisfies readonly SidebarSectionId[];
export type OrderedSection = (typeof ORDERED_SECTIONS)[number];

export const isOrdered = (id: string): id is OrderedSection => (ORDERED_SECTIONS as readonly string[]).includes(id);

/** The rows in the member's order: the ones the order names first, in its order, then the rest as they came. */
export function applyRowOrder<T>(rows: readonly T[], key: (row: T) => string, order: readonly string[] | undefined): T[] {
  if (!order?.length) return [...rows];
  const at = new Map(order.map((k, i) => [k, i]));
  const named = rows.filter((r) => at.has(key(r))).sort((a, b) => (at.get(key(a)) ?? 0) - (at.get(key(b)) ?? 0));
  return [...named, ...rows.filter((r) => !at.has(key(r)))];
}

/**
 * Saves `keys` (the rows as they now show) as a section's order. Keys of rows that do not
 * show here (hidden, or gone) stay in the saved order where they were, so nothing is lost.
 */
export function setRowOrder(p: SidebarPrefs, section: OrderedSection, keys: readonly string[]): SidebarPrefs {
  const saved = p.row_order[section] ?? [];
  const rest = saved.filter((k) => !keys.includes(k));
  return { ...p, row_order: { ...p.row_order, [section]: [...keys, ...rest] } };
}

/** Moves `key` to `index` among `keys` (the rows as they show), and saves the section's order. */
export function moveRow(p: SidebarPrefs, section: OrderedSection, keys: readonly string[], key: string, index: number): SidebarPrefs {
  const list = keys.filter((k) => k !== key);
  list.splice(Math.max(0, Math.min(index, list.length)), 0, key);
  return setRowOrder(p, section, list);
}
