// What a drop does in the sidebar's edit mode (SidebarEditor), kept pure so it is tested:
// sections reorder among themselves; a row reorders inside its section, goes into Favorites
// (pinned, or a page starred), or into a section of the member's own (added, or moved there
// from another of their sections). Built-in sections take only their own rows back.

import type { SidebarPin, SidebarPrefs, Space, SpaceItem } from "../api/types";
import { itemKey, moveItemTo, reorderItems, reorderSections } from "../spaces/model";
import { asSpace, entryKey, hasRoom, reorderEntries, sectionOf, sidebarEntries, withSpace } from "./ownSections";
import type { OwnRow } from "./ownSectionsUi";
import { isOrdered, moveRow } from "./rowOrder";
import { isPinned, MAX_PINS } from "./sidebarPrefs";

/** Something being dragged: a whole section by its key, or a row of one. */
export type EditSource =
  | { kind: "section"; key: string }
  | {
      kind: "row";
      /** The key of the section it is in ("favorites", a built-in id, "custom:<id>", or a Space section's id). */
      from: string;
      /** The row's key in that section (a hidden-id, a pin's "kind:id", a Space row's key). */
      key: string;
      /** What it is as a row of the member's own sections, when it can be one. */
      row?: OwnRow;
      /** What it is as a favorite, when it can be one. */
      pin?: SidebarPin;
      /** A wiki page: starred to land in Favorites. */
      page?: string;
    };

export type EditTarget = { kind: "section"; before: string | null } | { kind: "row"; section: string; before: string | null };

/** The result of a drop: new prefs, or a page to star or the starred pages' new order (the wiki keeps those). */
export type EditResult = { prefs: SidebarPrefs } | { star: string; before: string | null } | { stars: string[] };

export const FAVORITES = "favorites";
const isOwn = (key: string) => key.startsWith("custom:");
const ownId = (key: string) => key.slice("custom:".length);
export const pinKey = (p: SidebarPin) => `${p.kind}:${p.id}`;
const STAR = "star:";
export const starKey = (id: string) => `${STAR}${id}`;

/**
 * Where `key` goes among `keys` to sit before `before` (or last), once. Before itself, or before
 * something not among them, it stays where it is.
 */
export function placed(keys: readonly string[], key: string, before: string | null): string[] {
  if (before !== null && (before === key || !keys.includes(before))) return keys.includes(key) ? [...keys] : [...keys, key];
  const out = keys.filter((k) => k !== key);
  const i = before === null ? -1 : out.indexOf(before);
  out.splice(i < 0 ? out.length : i, 0, key);
  return out;
}

/** Whether a drop is allowed there. `rows` gives the keys of the rows a built-in section shows, in order. */
export function canDrop(p: SidebarPrefs, wid: string, s: EditSource, t: EditTarget): boolean {
  if (s.kind === "section") return t.kind === "section";
  if (t.kind !== "row") return false;
  if (t.section === s.from) return s.from === FAVORITES || isOrdered(s.from) || isOwn(s.from);
  if (t.section === FAVORITES) return !!s.page || (!!s.pin && (isPinned(p, s.pin) || p.pinned.length < MAX_PINS));
  if (isOwn(t.section)) {
    if (!s.row) return false;
    const moving = !!sectionOf(p, wid, s.row);
    return hasRoom(p, ownId(t.section), moving);
  }
  return false;
}

export function dropOnSidebar(p: SidebarPrefs, wid: string, s: EditSource, t: EditTarget, rows: (section: string) => string[]): EditResult | null {
  if (!canDrop(p, wid, s, t)) return null;
  if (s.kind === "section" && t.kind === "section") {
    const keys = sidebarEntries(p).map(entryKey);
    return { prefs: reorderEntries(p, placed(keys, s.key, t.before)) };
  }
  if (s.kind !== "row" || t.kind !== "row") return null;

  if (t.section === FAVORITES) {
    if (s.page && !s.pin) {
      // Starred pages follow the pins; moving one among them reorders the stars.
      const stars = rows(FAVORITES).filter((k) => k.startsWith(STAR));
      if (s.from === FAVORITES) return { stars: placed(stars, starKey(s.page), t.before?.startsWith(STAR) ? t.before : null).map((k) => k.slice(STAR.length)) };
      return { star: s.page, before: t.before?.startsWith(STAR) ? t.before.slice(STAR.length) : null };
    }
    if (!s.pin) return null;
    const pins = p.pinned.map(pinKey);
    const order = placed(pins, pinKey(s.pin), t.before && pins.includes(t.before) ? t.before : null);
    const all = [...p.pinned, ...(isPinned(p, s.pin) ? [] : [s.pin])];
    return { prefs: { ...p, pinned: order.map((k) => all.find((x) => pinKey(x) === k)!).filter(Boolean) } };
  }

  if (isOrdered(t.section) && s.from === t.section) {
    const keys = rows(t.section);
    const i = t.before === null ? keys.length : keys.filter((k) => k !== s.key).indexOf(t.before);
    return { prefs: moveRow(p, t.section, keys, s.key, i < 0 ? keys.length : i) };
  }

  if (isOwn(t.section) && s.row) {
    const sectionId = ownId(t.section);
    let space = asSpace(p, wid);
    const item: SpaceItem = { workspace_id: wid, kind: s.row.kind, id: s.row.id };
    const key = itemKey(item);
    const at = sectionOf(p, wid, s.row);
    if (!at) space = { ...space, sections: space.sections.map((x) => (x.id === sectionId ? { ...x, items: [...x.items, item] } : x)) };
    else if (at.id !== sectionId) space = moveItemTo(space, key, sectionId);
    const keys = (space.sections.find((x) => x.id === sectionId)?.items ?? []).map(itemKey);
    return { prefs: withSpace(p, reorderItems(space, sectionId, placed(keys, key, t.before))) };
  }
  return null;
}

/** The same drops in a Space: its sections reorder, its rows move within and between them. */
export function dropInSpace(space: Space, s: EditSource, t: EditTarget): Space | null {
  if (s.kind === "section" && t.kind === "section") {
    const ids = space.sections.map((x) => x.id);
    return reorderSections(space, placed(ids, s.key, t.before));
  }
  if (s.kind !== "row" || t.kind !== "row") return null;
  if (!space.sections.some((x) => x.id === t.section)) return null;
  const moved = s.from === t.section ? space : moveItemTo(space, s.key, t.section);
  const keys = (moved.sections.find((x) => x.id === t.section)?.items ?? []).map(itemKey);
  return reorderItems(moved, t.section, placed(keys, s.key, t.before));
}

