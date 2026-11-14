// Moving views in Settings → Views: a view dragged within its list, into another section or out
// of its section to the top level, and a whole section among the top-level entries. Every view
// is then numbered in sidebar order, sections unfolded, as reordering always did, and a view
// that joins a section takes the section's spelling and icon (lib/viewSections.ts), as the API
// gives it.

import type { View } from "@/lib/api/types";
import { cleanSection, groupViews, orderViews, sectionKey, type ViewEntry } from "@/lib/viewSections";

/** A top-level entry's id: a loose view's own, or `section:<key>`. */
export const entryId = (e: ViewEntry) => (e.kind === "view" ? e.view.id : `section:${e.key}`);

/** What moves: one view, or a section with its views. */
export type Dragged = { view: string } | { section: string };

/**
 * Where it lands. With `section` (a section's key), in that section before the view `before`, or
 * at its end for null. Without, at the top level before the entry `before` (an `entryId`), or at
 * the end for null.
 */
export type ViewSpot = { section: string | null; before: string | null };

/** `item` in place of the element `id` (or added), before the element `before` (null: at the end). */
function insert<T>(list: readonly T[], idOf: (x: T) => string, id: string, item: T, before: string | null): T[] {
  const from = list.findIndex((x) => idOf(x) === id);
  let at = before === null ? -1 : list.findIndex((x) => idOf(x) === before);
  if (at < 0) at = list.length;
  const out = list.filter((_, i) => i !== from);
  if (from >= 0 && from < at) at -= 1;
  out.splice(at, 0, item);
  return out;
}

const flatten = (entries: readonly ViewEntry[]): View[] =>
  entries.flatMap((e) => (e.kind === "view" ? [e.view] : e.views)).map((v, i) => (v.position === i ? v : { ...v, position: i }));

/** The views, numbered in sidebar order, after `dragged` lands on `spot`. */
export function placeViews(views: readonly View[], dragged: Dragged, spot: ViewSpot): View[] {
  const entries = groupViews(views);
  if ("section" in dragged) {
    // A section moves among the top-level entries only.
    const id = `section:${dragged.section}`;
    const entry = entries.find((e) => entryId(e) === id);
    if (!entry || spot.section !== null) return flatten(entries);
    return flatten(insert(entries, entryId, id, entry, spot.before));
  }
  const moving = views.find((v) => v.id === dragged.view);
  if (!moving) return flatten(entries);
  // Out of where it is; a section it leaves empty drops out with it.
  const rest = entries.map((e) => (e.kind === "section" ? { ...e, views: e.views.filter((v) => v.id !== moving.id) } : e));
  if (spot.section === null) {
    const loose: ViewEntry = { kind: "view", view: cleanSection(moving.section) ? { ...moving, section: null, section_icon: null } : moving };
    return flatten(insert(rest, entryId, moving.id, loose, spot.before));
  }
  const target = entries.find((e) => e.kind === "section" && e.key === spot.section);
  if (!target || target.kind !== "section") return flatten(entries);
  const joined = sectionKey(moving.section ?? "") === target.key ? moving : { ...moving, section: target.name, section_icon: target.icon };
  const into = insert(target.views, (v) => v.id, moving.id, joined, spot.before);
  return flatten(rest.filter((e) => !(e.kind === "view" && e.view.id === moving.id)).map((e) => (e.kind === "section" && e.key === target.key ? { ...e, views: into } : e)));
}

/** True when both lists read the same in the sidebar: the same order, each view in the same section. */
export function sameLayout(a: readonly View[], b: readonly View[]): boolean {
  const read = (vs: readonly View[]) => orderViews(vs).map((v) => `${v.id}\u0000${sectionKey(v.section ?? "")}`).join("\u0001");
  return read(a) === read(b);
}

/** One PATCH per view that moved: its new position, and its section when that changed. */
export type ViewPatch = { id: string; position: number; section?: string | null };

export function viewPatches(before: readonly View[], after: readonly View[]): ViewPatch[] {
  const was = new Map(before.map((v) => [v.id, v]));
  const out: ViewPatch[] = [];
  for (const v of after) {
    const o = was.get(v.id);
    if (!o) continue;
    const section = cleanSection(o.section) !== cleanSection(v.section);
    if (o.position === v.position && !section) continue;
    out.push(section ? { id: v.id, position: v.position, section: cleanSection(v.section) || null } : { id: v.id, position: v.position });
  }
  return out;
}

/** Alt+ArrowUp/Down: one place up or down within its list (its section, or the top level); null at either end. */
export function stepSpot(views: readonly View[], dragged: Dragged, dir: -1 | 1): ViewSpot | null {
  const entries = groupViews(views);
  if ("view" in dragged) {
    const section = entries.find((e) => e.kind === "section" && e.views.some((v) => v.id === dragged.view));
    if (section?.kind === "section") {
      const i = section.views.findIndex((v) => v.id === dragged.view);
      if (dir < 0) return i > 0 ? { section: section.key, before: section.views[i - 1].id } : null;
      return i < section.views.length - 1 ? { section: section.key, before: section.views[i + 2]?.id ?? null } : null;
    }
  }
  const id = "view" in dragged ? dragged.view : `section:${dragged.section}`;
  const j = entries.findIndex((e) => entryId(e) === id);
  if (j < 0) return null;
  if (dir < 0) return j > 0 ? { section: null, before: entryId(entries[j - 1]) } : null;
  return j < entries.length - 1 ? { section: null, before: entries[j + 2] ? entryId(entries[j + 2]) : null } : null;
}

/**
 * Where "Move to section" sends a view: the end of the section `key`, or for null (No section)
 * the top level right after the section it leaves, so it stays near where it was.
 */
export function sectionSpot(views: readonly View[], id: string, key: string | null): ViewSpot {
  if (key !== null) return { section: key, before: null };
  const entries = groupViews(views);
  const i = entries.findIndex((e) => (e.kind === "view" ? e.view.id === id : e.views.some((v) => v.id === id)));
  const next = i >= 0 ? entries[i + 1] : undefined;
  return { section: null, before: next ? entryId(next) : null };
}

/** A row of the list as the drag reads it: a section's header or a view, top to bottom, with its box (the dragged rows left out). */
export type DropRow = { kind: "header" | "view"; id: string; section: string | null; top: number; bottom: number };

/** A row's top-level entry. */
const rowEntry = (r: DropRow) => (r.kind === "header" ? `section:${r.id}` : r.section ? `section:${r.section}` : r.id);

/** The first top-level entry after row `i` (null: none, the end). */
function nextEntry(rows: readonly DropRow[], i: number): string | null {
  const own = rowEntry(rows[i]);
  for (let j = i + 1; j < rows.length; j++) if (rowEntry(rows[j]) !== own) return rowEntry(rows[j]);
  return null;
}

/**
 * Where a drop at `y` lands, from the rows on screen (the dragged ones left out). On a view of a
 * section: before it (upper half) or after it, in that section; at the bottom of a section's last
 * view, out of the section, after it. On a section's header: before the section (its top part)
 * or into it, first. On a loose view: before or after it. A section moves only among the
 * top-level entries. Null over `self`, the place the dragged rows leave: it stays.
 */
export function dropSpot(rows: readonly DropRow[], dragged: Dragged, y: number, self?: { top: number; bottom: number }): ViewSpot | null {
  if (!rows.length || (self && y >= self.top && y < self.bottom)) return null;
  if (y < rows[0].top) return { section: null, before: rowEntry(rows[0]) };
  if (y >= rows[rows.length - 1].bottom) return { section: null, before: null };
  if ("section" in dragged) {
    // The entry under the pointer, across all its rows.
    const i = rows.findIndex((r) => y >= r.top && y < r.bottom);
    if (i < 0) return null;
    const id = rowEntry(rows[i]);
    const own = rows.filter((r) => rowEntry(r) === id);
    const top = own[0].top;
    const bottom = own[own.length - 1].bottom;
    if (y < (top + bottom) / 2) return { section: null, before: id };
    return { section: null, before: nextEntry(rows, rows.lastIndexOf(own[own.length - 1])) };
  }
  const i = rows.findIndex((r) => y >= r.top && y < r.bottom);
  if (i < 0) return null;
  const r = rows[i];
  const at = (y - r.top) / Math.max(1, r.bottom - r.top);
  if (r.kind === "header") {
    if (at < 0.4) return { section: null, before: `section:${r.id}` };
    const first = rows[i + 1]?.kind === "view" && rows[i + 1].section === r.id ? rows[i + 1].id : null;
    return { section: r.id, before: first };
  }
  if (!r.section) return at < 0.5 ? { section: null, before: r.id } : { section: null, before: nextEntry(rows, i) };
  if (at < 0.5) return { section: r.section, before: r.id };
  const next = rows[i + 1]?.kind === "view" && rows[i + 1].section === r.section ? rows[i + 1].id : null;
  if (next === null && at >= 0.75) return { section: null, before: nextEntry(rows, i) };
  return { section: r.section, before: next };
}
