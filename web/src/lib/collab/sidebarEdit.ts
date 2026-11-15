// The sidebar's edit mode: the member arranges the sidebar where it is (SidebarEditor),
// dragging sections and rows, hiding and showing them, naming their own. Entered from
// Edit sidebar (a row's menu, a section's menu, the sidebar's right-click menu, the
// Customize button at the bottom, the user menu, g then e); left with Done or Escape. A
// collapsed rail opens for it and folds back after. Outside it, rows and sections still drag,
// and a double-click (or F2 on the focused row) renames one where it is.

import { create } from "zustand";
import { shell, toggleNav, useNav } from "@/app/shellStore";
import { useSession } from "@/lib/session";

/** What a key does to the focused sidebar row. */
export type RowAction = "up" | "down" | "pin" | "hide" | "remove";

/** Each mounted row's keyboard actions, by its `data-sidebar-row` id; true when it acted. */
const rowKeys = new Map<string, (action: RowAction) => boolean>();

/** Registers a row's keyboard actions while it is in the sidebar; the return takes them away. */
export function registerRowKeys(id: string, act: (action: RowAction) => boolean): () => void {
  rowKeys.set(id, act);
  return () => {
    if (rowKeys.get(id) === act) rowKeys.delete(id);
  };
}

type EditState = {
  editing: boolean;
  /** The rail was collapsed when editing began: it folds back on Done. */
  railBefore: boolean;
  /** The row or section being renamed where it is, outside edit mode too: its `data-sidebar-row` id. */
  renaming: string | null;
  /** The row or section whose emoji picker is open, by the same id. */
  picking: string | null;
  /** The member who dismissed the hint in this tab, so whatever waits for it shows at once. */
  hintClosed: string | null;
};

export const useSidebarEdit = create<EditState>(() => ({ editing: false, railBefore: false, renaming: null, picking: null, hintClosed: null }));

/** Below this width the sidebar is the drawer (md in the app's breakpoints). */
const DRAWER_BELOW = 768;

export const sidebarEdit = {
  start() {
    if (useSidebarEdit.getState().editing) return;
    const railBefore = useNav.getState().collapsed;
    if (railBefore) toggleNav(false);
    if (typeof window !== "undefined" && window.innerWidth < DRAWER_BELOW) shell.sidebar(true);
    useSidebarEdit.setState({ editing: true, railBefore, renaming: null, picking: null });
    // Having opened it, the member knows where it is: the hint goes for good.
    const uid = useSession.getState().user?.id;
    if (uid) dismissHint(uid);
  },
  stop() {
    const { editing, railBefore } = useSidebarEdit.getState();
    if (!editing) return;
    useSidebarEdit.setState({ editing: false, railBefore: false });
    if (railBefore) toggleNav(true);
  },
  toggle() {
    if (useSidebarEdit.getState().editing) sidebarEdit.stop();
    else sidebarEdit.start();
  },
  /** Renames a row or section in place (its `data-sidebar-row` id). */
  rename(id: string) {
    useSidebarEdit.setState({ renaming: id, picking: null });
  },
  /** Opens a row's or section's emoji picker in place. */
  pickIcon(id: string) {
    useSidebarEdit.setState({ picking: id, renaming: null });
  },
  done() {
    useSidebarEdit.setState({ renaming: null, picking: null });
  },
  /**
   * Renames the sidebar row or section header that has the keyboard focus, in place (F2).
   * Returns whether something was there to rename.
   */
  /**
   * Acts on the focused sidebar row from the keyboard (move, pin, hide, remove): what the row
   * can do is registered by the row itself (`rowKeys`). False when no row has the focus or it
   * can't do that, so the key is left alone.
   */
  actOnFocused(action: RowAction): boolean {
    if (typeof document === "undefined") return false;
    const id = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-sidebar-row]")?.dataset.sidebarRow;
    const act = id ? rowKeys.get(id) : undefined;
    return !!act && act(action);
  },
  renameFocused(): boolean {
    if (typeof document === "undefined") return false;
    const el = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-sidebar-row]");
    const id = el?.dataset.sidebarRow;
    if (!id || el.dataset.renamable !== "true") return false;
    sidebarEdit.rename(id);
    return true;
  },
};

// The one-time hint that the sidebar can be arranged, dismissed per person in this browser.
const hintKey = (uid: string) => `od-sidebar-hint:${uid}`;

export function hintDismissed(uid: string): boolean {
  try {
    return localStorage.getItem(hintKey(uid)) === "1";
  } catch {
    return true;
  }
}

export function dismissHint(uid: string) {
  try {
    localStorage.setItem(hintKey(uid), "1");
  } catch {
    /* storage unavailable */
  }
  useSidebarEdit.setState({ hintClosed: uid });
}
