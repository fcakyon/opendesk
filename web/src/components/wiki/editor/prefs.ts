// A person's own choices about the wiki editor, kept in this browser.

import { useCallback, useSyncExternalStore } from "react";

const KEY = "od:wiki:toolbar";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

/** Whether the formatting bar shows above a page's text (on unless turned off). */
export function useToolbarPref(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    read,
    () => true,
  );
  const set = useCallback((v: boolean) => {
    try {
      localStorage.setItem(KEY, v ? "on" : "off");
    } catch {
      // Private mode: it holds until the page closes.
    }
    listeners.forEach((l) => l());
  }, []);
  return [on, set];
}

export type PanelTab = "outline" | "links" | "graph" | "comments" | "info";
const PANEL_KEY = "od:wiki:panel";
const PANEL_TABS: PanelTab[] = ["outline", "links", "graph", "comments", "info"];

// Private mode refuses storage: the choice then holds in memory until the tab closes.
let panelMemory: PanelTab | null = null;

function readPanel(): PanelTab | null {
  try {
    const v = localStorage.getItem(PANEL_KEY);
    return PANEL_TABS.includes(v as PanelTab) ? (v as PanelTab) : null;
  } catch {
    return panelMemory;
  }
}

/** The page panel's open tab, or null when it is closed; kept in this browser. */
export function usePanelPref(): [PanelTab | null, (tab: PanelTab | null) => void] {
  const tab = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    readPanel,
    () => null,
  );
  const set = useCallback((v: PanelTab | null) => {
    panelMemory = v;
    try {
      if (v) localStorage.setItem(PANEL_KEY, v);
      else localStorage.removeItem(PANEL_KEY);
    } catch {
      // Private mode: it holds until the page closes.
    }
    listeners.forEach((l) => l());
  }, []);
  return [tab, set];
}
