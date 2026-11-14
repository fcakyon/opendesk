// How a member arranges the wiki's sidebar (contracts/wiki.md "Sidebar"): the order of its
// sections, the ones hidden and the ones folded. Kept per workspace in this browser, like
// the pages open in the tree.

import { useCallback, useSyncExternalStore } from "react";
import { useSession } from "@/lib/session";

/** A section of the wiki's sidebar: favorites, recent pages, a space (lib/wiki/tree SpaceKey). */
export type SectionKey = "favorites" | "recent" | "workspace" | "private" | `team:${string}`;

export type SidebarLayout = { order: SectionKey[]; hidden: SectionKey[]; folded: SectionKey[] };

const EMPTY: SidebarLayout = { order: [], hidden: [], folded: [] };
const listeners = new Set<() => void>();
const memory = new Map<string, SidebarLayout>();
const storeKey = (wid: string) => `od:wiki:sidebar:${wid}`;

function read(wid: string): SidebarLayout {
  const cached = memory.get(wid);
  if (cached) return cached;
  let out = EMPTY;
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey(wid)) ?? "null") as Partial<SidebarLayout> | null;
    if (raw) out = { order: raw.order ?? [], hidden: raw.hidden ?? [], folded: raw.folded ?? [] };
  } catch {
    // A broken value starts over.
  }
  memory.set(wid, out);
  return out;
}

function write(wid: string, next: SidebarLayout) {
  memory.set(wid, next);
  try {
    localStorage.setItem(storeKey(wid), JSON.stringify(next));
  } catch {
    // Private mode: it holds for this visit.
  }
  listeners.forEach((l) => l());
}

/**
 * The sections to show, in order: the member's order first, then any section they never
 * placed (a new teamspace) where it belongs by default.
 */
export function arrange(available: SectionKey[], layout: SidebarLayout): SectionKey[] {
  const placed = layout.order.filter((k) => available.includes(k));
  const rest = available.filter((k) => !placed.includes(k));
  const out = [...placed];
  for (const k of rest) {
    // A new section goes after the last placed one that comes before it by default.
    const before = available.slice(0, available.indexOf(k)).filter((x) => out.includes(x));
    const at = before.length ? out.indexOf(before[before.length - 1]) + 1 : 0;
    out.splice(at, 0, k);
  }
  return out;
}

export function useSidebarLayout() {
  const wid = useSession((s) => s.workspaceId) ?? "";
  const layout = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => read(wid),
    () => EMPTY,
  );
  const set = useCallback((fn: (l: SidebarLayout) => SidebarLayout) => write(wid, fn(read(wid))), [wid]);
  return {
    layout,
    setOrder: (order: SectionKey[]) => set((l) => ({ ...l, order })),
    setHidden: (key: SectionKey, hidden: boolean) => set((l) => ({ ...l, hidden: hidden ? [...new Set([...l.hidden, key])] : l.hidden.filter((k) => k !== key) })),
    toggleFold: (key: SectionKey) => set((l) => ({ ...l, folded: l.folded.includes(key) ? l.folded.filter((k) => k !== key) : [...l.folded, key] })),
    reset: () => set(() => EMPTY),
  };
}
