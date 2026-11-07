// The sidebar's edit mode: the member arranges the sidebar where it is (SidebarEditor),
// dragging sections and rows, hiding and showing them, naming their own. Entered from
// Edit sidebar (a row's menu, the sidebar's right-click menu, the user menu, Shift+B);
// left with Done or Escape. A collapsed rail opens for it and folds back after.

import { create } from "zustand";
import { shell, toggleNav, useNav } from "@/app/shellStore";

type EditState = {
  editing: boolean;
  /** The rail was collapsed when editing began: it folds back on Done. */
  railBefore: boolean;
};

export const useSidebarEdit = create<EditState>(() => ({ editing: false, railBefore: false }));

/** Below this width the sidebar is the drawer (md in the app's breakpoints). */
const DRAWER_BELOW = 768;

export const sidebarEdit = {
  start() {
    if (useSidebarEdit.getState().editing) return;
    const railBefore = useNav.getState().collapsed;
    if (railBefore) toggleNav(false);
    if (typeof window !== "undefined" && window.innerWidth < DRAWER_BELOW) shell.sidebar(true);
    useSidebarEdit.setState({ editing: true, railBefore });
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
