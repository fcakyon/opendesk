// The sidebar's edit mode: the member arranges the sidebar where it is (SidebarEditor),
// dragging sections and rows, hiding and showing them, naming their own. Entered from
// Edit sidebar (a row's menu, a section's menu, the sidebar's right-click menu, the
// Customize button at the bottom, the user menu, g then e); left with Done or Escape. A
// collapsed rail opens for it and folds back after. Outside it, rows and sections still drag,
// and a double-click (or F2 on the focused row) renames one where it is.

import { create } from "zustand";
import { shell, toggleNav, useNav } from "@/app/shellStore";
import { useSession } from "@/lib/session";

type EditState = {
  editing: boolean;
  /** The rail was collapsed when editing began: it folds back on Done. */
  railBefore: boolean;
  /** The row or section being renamed where it is, outside edit mode too: its `data-sidebar-row` id. */
  renaming: string | null;
  /** The row or section whose emoji picker is open, by the same id. */
  picking: string | null;
};

export const useSidebarEdit = create<EditState>(() => ({ editing: false, railBefore: false, renaming: null, picking: null }));

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
}
