// The shortcuts that work anywhere in the app (lib/shortcuts.ts, scope "global" and
// "sidebar"): going to each area, back and forward, the sidebar, today's note and the graph.
// The palette, the ? sheet and c stay in AppLayout beside the state they read.

import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useOpenToday } from "@/components/wiki/journal";
import { sidebarEdit, type RowAction } from "@/lib/collab/sidebarEdit";
import { isTypingTarget, keyName } from "@/lib/hotkeys";
import { useProducts } from "@/lib/products";
import { bindingOf, useShortcuts, type ShortcutId } from "@/lib/shortcuts";
import { useSyncShortcuts } from "@/lib/shortcutSync";
import { toggleNav } from "./shellStore";

/** The main sidebar's scrolling list of rows. */
const sidebarList = () => document.querySelector<HTMLElement>('nav[aria-label="Main"] .overflow-y-auto') ?? document.querySelector<HTMLElement>('nav[aria-label="Main"]');

/** The rows of the main sidebar a person can move between: its links and row buttons, in order, shown. */
function sidebarRows(): HTMLElement[] {
  const list = sidebarList();
  if (!list) return [];
  return [...list.querySelectorAll<HTMLElement>("a[href], [role='treeitem']")].filter((el) => el.getClientRects().length > 0 && !el.closest("[role='treeitem'] a"));
}

/** Moves the focus into the sidebar: the open row, else the first. */
export function focusSidebar() {
  const rows = sidebarRows();
  const here = rows.find((r) => r.getAttribute("aria-current") === "page" || r.dataset.status === "active" || r.getAttribute("aria-selected") === "true");
  (here ?? rows[0])?.focus();
}

export function useGlobalShortcuts(onMail: boolean) {
  const navigate = useNavigate();
  const router = useRouter();
  const products = useProducts();
  const openToday = useOpenToday("pages");
  const area = (to: string) => () => void navigate({ to });
  useShortcuts({
    "global.back": () => router.history.back(),
    "global.forward": () => router.history.forward(),
    "sidebar.toggle": () => toggleNav(),
    "sidebar.edit": () => sidebarEdit.toggle(),
    "sidebar.focus": focusSidebar,
    "go.inbox": () =>
      onMail || !products.tickets
        ? void navigate({ to: "/mail/$box/{-$threadId}", params: { box: "inbox", threadId: undefined }, search: (prev: { account?: string }) => ({ account: prev.account }) })
        : void navigate({ to: "/inbox/$folder/{-$ticketId}", params: { folder: "unassigned", ticketId: undefined } }),
    "go.mine": products.tickets && (() => void navigate({ to: "/inbox/$folder/{-$ticketId}", params: { folder: "mine", ticketId: undefined } })),
    "go.mail": products.mail && (() => void navigate({ to: "/mail/$box/{-$threadId}", params: { box: "inbox", threadId: undefined }, search: {} })),
    "go.pages": products.pages && area("/pages"),
    "go.today": products.pages && (() => void openToday()),
    "go.graph": products.pages && area("/pages/graph"),
    "go.wiki": area("/wiki"),
    "go.contacts": () => void navigate({ to: "/contacts/{-$contactId}", params: { contactId: undefined } }),
    "go.kb": area("/kb"),
    "go.reports": area("/reports"),
    "go.settings": area("/settings"),
    "go.shortcuts": area("/settings/shortcuts"),
  });
  useSidebarKeys();
  useSyncShortcuts(true);
}

/** The keys that act on the focused row itself, and what each does. */
const ROW_ACTIONS: Partial<Record<ShortcutId, RowAction>> = {
  "sidebar.moveUp": "up",
  "sidebar.moveDown": "down",
  "sidebar.pin": "pin",
  "sidebar.hide": "hide",
  "sidebar.remove": "remove",
};

/**
 * The sidebar's keys while one of its rows has the focus: the arrows move between rows, F2
 * renames the row in place, and the row's own keys move, pin, hide or remove it. They are
 * heard before the page's own keys, so an arrow moves in the sidebar rather than down the
 * ticket list, and h hides the row rather than snoozing a ticket.
 */
function useSidebarKeys() {
  useEffect(() => {
    const ids: ShortcutId[] = ["sidebar.next", "sidebar.previous", "sidebar.rename", ...(Object.keys(ROW_ACTIONS) as ShortcutId[])];
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || isTypingTarget(e.target)) return;
      const list = sidebarList();
      if (!list || !(e.target instanceof Element) || !list.contains(e.target)) return;
      const name = keyName(e);
      const id = ids.find((x) => bindingOf(x) === name);
      if (!id) return;
      // F2 on something that can't be renamed (a live count, a plain link) leaves the key alone.
      if (id === "sidebar.rename") {
        if (sidebarEdit.renameFocused()) e.preventDefault();
        return;
      }
      const action = ROW_ACTIONS[id];
      if (action) {
        // Taken in the sidebar even when the row can't do it: the page behind never hears it.
        e.preventDefault();
        sidebarEdit.actOnFocused(action);
        return;
      }
      e.preventDefault();
      step(id === "sidebar.next" ? 1 : -1);
    };
    const step = (by: 1 | -1) => {
      const rows = sidebarRows();
      const at = rows.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
      rows[Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + by))]?.focus();
    };
    // On the document, so it is heard before the page's shortcuts on the window.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
