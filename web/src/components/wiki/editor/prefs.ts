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
