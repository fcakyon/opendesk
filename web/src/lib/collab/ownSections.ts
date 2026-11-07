// A member's own sidebar sections (contracts/collab.md SidebarPrefs `sections`): rows of
// anything the workspace offers, among the built-in sections, placed in `order` as
// "custom:<id>". They are a Space's sections of one workspace, so the Space model
// (lib/spaces/model.ts) changes them: `asSpace` reads them as one, `withSpace` writes it back.

import type { SidebarItem, SidebarPrefs, SidebarSection, SidebarSectionId, Space, SpaceItem } from "../api/types";
import { addItems, addSection, cleanName, findItem, hasItem, itemKey, moveItemTo, removeItem } from "../spaces/model";
import { inboxKey, parseInboxKey, type InboxScope } from "./inboxSections";
import { isHidden, sectionOrder, sectionsOffered } from "./sidebarPrefs";

export const OWN_LIMITS = { sections: 20, sectionItems: 60, items: 300, title: 40 } as const;

const PREFIX = "custom:";
export const ownKey = (id: string) => `${PREFIX}${id}`;
const ownId = (key: string) => (key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null);

/**
 * A section of the sidebar: a built-in, one of the member's own, or a ticket inbox or team shown
 * apart (lib/collab/inboxSections.ts, "mailbox:<id>" and "team:<id>" in `order`).
 */
export type SidebarEntry = { kind: "builtin"; id: SidebarSectionId } | { kind: "custom"; section: SidebarSection } | { kind: "inbox"; scope: InboxScope };
export const entryKey = (e: SidebarEntry) => (e.kind === "builtin" ? e.id : e.kind === "custom" ? ownKey(e.section.id) : inboxKey(e.scope));

/**
 * Every section in the member's order: the built-ins as `sectionOrder` places them, and each own
 * or inbox section right after the entry before it in the saved order (one with nothing before
 * it goes first; one after a built-in the app no longer knows, or an own section the order
 * lacks, goes last).
 */
export function sidebarEntries(p: SidebarPrefs): SidebarEntry[] {
  const own = new Map(p.sections.map((s) => [s.id, s]));
  const floating = new Map<string, SidebarEntry>();
  for (const key of p.order) {
    if (floating.has(key)) continue;
    const id = ownId(key);
    const sec = id === null ? undefined : own.get(id);
    if (sec) floating.set(key, { kind: "custom", section: sec });
    const scope = id === null ? parseInboxKey(key) : null;
    if (scope) floating.set(key, { kind: "inbox", scope });
  }
  const after = new Map<string, string[]>();
  const anchored = new Set<string>();
  let last = "";
  for (const key of p.order) {
    if (floating.has(key)) {
      if (!anchored.has(key)) {
        anchored.add(key);
        after.set(last, [...(after.get(last) ?? []), key]);
      }
      last = key;
    } else if (!key.includes(":")) last = key;
  }
  const out: SidebarEntry[] = [];
  const done = new Set<string>();
  const place = (key: string, entry: SidebarEntry) => {
    if (done.has(key)) return;
    done.add(key);
    out.push(entry);
    for (const k of after.get(key) ?? []) place(k, floating.get(k)!);
  };
  for (const k of after.get("") ?? []) place(k, floating.get(k)!);
  for (const id of sectionOrder(p)) place(id, { kind: "builtin", id });
  // After a built-in the order no longer names, or not in the order at all: last.
  for (const [k, e] of floating) place(k, e);
  for (const s of p.sections) place(ownKey(s.id), { kind: "custom", section: s });
  return out;
}

/** The sections that show: the built-ins offered and not hidden (without Collab, never Mail), and every own section. */
export function visibleEntries(p: SidebarPrefs, collab = true): SidebarEntry[] {
  const offered = sectionsOffered(collab);
  return sidebarEntries(p).filter((e) => (e.kind === "builtin" ? offered.includes(e.id) : true) && !isHidden(p, `section:${entryKey(e)}`));
}

/** The order as saved: every entry's key, then what the app does not know, as it was. */
function withOrder(p: SidebarPrefs, entries: SidebarEntry[]): SidebarPrefs {
  const keys = entries.map(entryKey);
  const known = new Set<string>([...sectionOrder(p), ...p.sections.map((s) => ownKey(s.id))]);
  return { ...p, order: [...keys, ...p.order.filter((k) => !known.has(k) && !keys.includes(k))] };
}

/** Moves a section, built-in or own, one place up (-1) or down (1), past the sections not offered. */
export function moveEntry(p: SidebarPrefs, key: string, dir: -1 | 1, collab = true): SidebarPrefs {
  const list = sidebarEntries(p);
  const offered = sectionsOffered(collab);
  const shown = (e: SidebarEntry) => e.kind !== "builtin" || offered.includes(e.id);
  const i = list.findIndex((e) => entryKey(e) === key);
  let j = i + dir;
  while (j >= 0 && j < list.length && !shown(list[j])) j += dir;
  if (i < 0 || j < 0 || j >= list.length) return p;
  [list[i], list[j]] = [list[j], list[i]];
  return withOrder(p, list);
}

/** Puts the sections in the order of `keys`; one the list lacks keeps its place after them. */
export function reorderEntries(p: SidebarPrefs, keys: string[]): SidebarPrefs {
  const list = sidebarEntries(p);
  const byKey = new Map(list.map((e) => [entryKey(e), e]));
  const out = keys.map((k) => byKey.get(k)).filter((e): e is SidebarEntry => !!e);
  for (const e of list) if (!keys.includes(entryKey(e))) out.push(e);
  return withOrder(p, out);
}

/** The own sections as a Space of the open workspace, for the Space model and its row renderers. */
export function asSpace(p: SidebarPrefs, wid: string): Space {
  return {
    id: "sidebar",
    name: "",
    icon: "",
    color: "grey",
    marks: false,
    sections: p.sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, workspace_id: wid })) })),
  };
}

const toItem = ({ workspace_id: _w, ...rest }: SpaceItem): SidebarItem => rest as SidebarItem;

/**
 * Writes a Space made with `asSpace` back. A new section goes where `at` says (after that
 * section's key) or last; a section gone leaves the order.
 */
export function withSpace(p: SidebarPrefs, space: Space, at?: string): SidebarPrefs {
  const sections: SidebarSection[] = space.sections.map((s) => ({ id: s.id, title: cleanName(s.title), collapsed: s.collapsed, ...(s.icon ? { icon: s.icon } : {}), items: s.items.map(toItem) }));
  const before = new Set(p.sections.map((s) => s.id));
  const after = new Set(sections.map((s) => s.id));
  let order = sidebarEntries(p)
    .map(entryKey)
    .filter((k) => {
      const id = ownId(k);
      return id === null || after.has(id);
    });
  for (const s of sections) {
    if (before.has(s.id)) continue;
    const i = at ? order.indexOf(at) : -1;
    if (i >= 0) order.splice(i + 1, 0, ownKey(s.id));
    else order.push(ownKey(s.id));
  }
  const known = new Set<string>([...sectionOrder(p), ...[...before].map(ownKey)]);
  order = [...order, ...p.order.filter((k) => !known.has(k) && !order.includes(k))];
  return { ...p, sections, order };
}

/** The own section a row sits in, if any. */
export function sectionOf(p: SidebarPrefs, wid: string, item: Pick<SidebarItem, "kind" | "id">): SidebarSection | null {
  const at = findItem(asSpace(p, wid), itemKey({ workspace_id: wid, ...item }));
  return at ? (p.sections.find((s) => s.id === at.section.id) ?? null) : null;
}

/** How many rows the own sections hold in all. */
export const ownCount = (p: SidebarPrefs) => p.sections.reduce((n, s) => n + s.items.length, 0);

/** Whether a row can go into this section: room in it and in all (a row already in another section moves). */
export function hasRoom(p: SidebarPrefs, sectionId: string, moving = false): boolean {
  const sec = p.sections.find((s) => s.id === sectionId);
  return !!sec && sec.items.length < OWN_LIMITS.sectionItems && (moving || ownCount(p) < OWN_LIMITS.items);
}

/**
 * Puts a row in an own section: added at its end, or moved there from the section it was in;
 * in that section already, it is taken out (the menus' check marks toggle).
 */
export function toggleInSection(p: SidebarPrefs, wid: string, sectionId: string, item: Pick<SidebarItem, "kind" | "id">): SidebarPrefs {
  const space = asSpace(p, wid);
  const full: SpaceItem = { workspace_id: wid, kind: item.kind, id: item.id };
  const key = itemKey(full);
  const at = findItem(space, key);
  if (at?.section.id === sectionId) return withSpace(p, removeItem(space, key));
  if (at) return hasRoom(p, sectionId, true) ? withSpace(p, moveItemTo(space, key, sectionId)) : p;
  return hasRoom(p, sectionId) ? withSpace(p, addItems(space, sectionId, [full])) : p;
}

/** Adds an own section, with a row in it when one is given; it goes after `at` (a section's key) or last. */
export function newOwnSection(p: SidebarPrefs, wid: string, title: string, item?: Pick<SidebarItem, "kind" | "id">, at?: string): { prefs: SidebarPrefs; id: string } {
  let space = asSpace(p, wid);
  const full = item ? ({ workspace_id: wid, kind: item.kind, id: item.id } as SpaceItem) : null;
  // A row already in another section moves into the new one.
  if (full && hasItem(space, full)) space = removeItem(space, itemKey(full));
  const made = addSection(space, title, full ? [full] : []);
  return { prefs: withSpace(p, made.space, at), id: made.id };
}
