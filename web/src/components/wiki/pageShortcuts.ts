// A page's keys (lib/shortcuts.ts, scope "page"): what its header and its menu do, from the
// keyboard. The page screen passes what it can do; a key whose action the page doesn't
// offer (a viewer's, a template's) does nothing.

import { useTranslation } from "react-i18next";
import { shell } from "@/app/shellStore";
import { useShortcuts } from "@/lib/shortcuts";

export type PageKeyActions = {
  newPage?: () => void;
  newSubpage?: () => void;
  parent?: () => void;
  favorite?: () => void;
  duplicate?: () => void;
  move?: () => void;
  copyLink?: () => void;
  beside?: () => void;
  history?: () => void;
  publish?: () => void;
  /** Opens the page's menu at Export, where the format is picked. */
  exportMenu?: () => void;
  lock?: () => void;
};

/** Focuses the wiki column's page search; answers whether there was one to focus. */
function focusPageSearch(placeholder: string) {
  const el = [...document.querySelectorAll<HTMLInputElement>("[data-wiki-panel] input, aside input")].find((x) => x.placeholder === placeholder && x.getClientRects().length > 0);
  if (!el) return false;
  el.focus();
  el.select();
  return true;
}

export function usePageShortcuts(a: PageKeyActions, enabled = true) {
  const { t } = useTranslation("wiki");
  useShortcuts(
    {
      "page.new": a.newPage,
      "page.newSubpage": a.newSubpage,
      "page.parent": a.parent,
      "page.favorite": a.favorite,
      "page.duplicate": a.duplicate,
      "page.move": a.move,
      "page.copyLink": a.copyLink,
      "page.beside": a.beside,
      "page.history": a.history,
      "page.publish": a.publish,
      "page.export": a.exportMenu,
      "page.lock": a.lock,
      // Without the wiki column, search finds pages from the command menu.
      "page.search": () => focusPageSearch(t("tree.search")) || shell.palette(),
    },
    enabled,
  );
}
