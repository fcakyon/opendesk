// What people read about the shortcuts: each one's label, the list of those offered in this
// workspace, and the scope of the page they are on. The ? sheet, Settings › Shortcuts and
// the command menu read these, so the three always agree.

import { useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDisplay } from "@/components/tickets/fields";
import { useProducts } from "./products";
import { SCOPES, SHORTCUT_LIST, type ShortcutDef, type ShortcutScope } from "./shortcuts";

/** A shortcut's label in the person's language; a ticket's finish follows the workspace's words. */
export function useShortcutLabels() {
  const { t } = useTranslation("shortcuts");
  const finish = useDisplay().finishWords;
  return (s: ShortcutDef): string => {
    if (s.id === "tickets.solve") return finish.listShortcut();
    if (s.id === "ticket.solve") return finish.shortcut();
    const [group, name] = s.id.split(".");
    return t(`items.${group}.${name}` as never);
  };
}

/** The shortcuts this workspace offers: Tickets', Mail's and Pages' only while each is on. */
export function useOfferedShortcuts(): readonly ShortcutDef[] {
  const products = useProducts();
  return useMemo(() => SHORTCUT_LIST.filter((s) => !s.needs || products[s.needs]), [products]);
}

/** The scopes of the page the person is on, the most particular first. */
export function useHereScopes(): ShortcutScope[] {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return useMemo(() => scopesOf(path), [path]);
}

export function scopesOf(path: string): ShortcutScope[] {
  const [first = "", second = "", third] = path.split("/").filter(Boolean);
  if (first === "mail") return ["mail"];
  if (first === "inbox" || first === "views" || first === "teams") return third ? ["ticket", "tickets"] : ["tickets"];
  if (first === "tickets") return ["ticket"];
  if ((first === "pages" || first === "wiki") && second && !["graph", "tags", "templates", "trash"].includes(second)) return ["page", "editor", "database", "canvas"];
  if (first === "settings" && path.includes("/bots")) return ["bots"];
  return [];
}

/** Scopes in the order the sheet lists them: this page's first. */
export function orderedScopes(here: readonly ShortcutScope[]): ShortcutScope[] {
  return [...here, ...SCOPES.filter((s) => !here.includes(s))];
}
