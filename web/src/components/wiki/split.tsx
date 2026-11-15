// Split view (contracts/wiki.md "Split view", Obsidian's panes): a second page open beside the
// one in the address, `?beside=<page id>`. Pages open there from "Open beside" in a page's
// menus, a picker ("Open a page beside"), and Alt-click (Option-click) on any link to a page;
// Mod-click stays the browser's new tab. A link followed inside the side page opens there, as
// a pane of its own. The layout itself is WikiPageView's.

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/dialog";
import { pickerSearch } from "@/components/ui/picker";
import { ancestorsOf } from "@/lib/wiki/tree";
import { besideOf, closed, isBesideClick, pageIdOfHref, swapped, type PageSearch } from "@/lib/wiki/split";
import { useOpenPageId, useTitle, useWikiTree } from "./hooks";
import { PageIcon } from "./PageTree";

const NONE: PageSearch = {};

/** Wide enough for two pages side by side; narrower, the side page is a peek over the page. */
const WIDE = "(min-width: 1024px)";

export function useWideScreen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = typeof matchMedia === "undefined" ? null : matchMedia(WIDE);
      m?.addEventListener("change", cb);
      return () => m?.removeEventListener("change", cb);
    },
    () => (typeof matchMedia === "undefined" ? true : matchMedia(WIDE).matches),
    () => true,
  );
}

/** Opening, swapping and closing the side page: each a change of the address. */
export function useSplit() {
  const navigate = useNavigate();
  const main = useOpenPageId();
  const search = useRouterState({ select: (s) => (s.location.search as PageSearch | undefined) ?? NONE });
  const go = useCallback(
    (to: { pageId: string; search: PageSearch }, replace = false) => void navigate({ to: "/wiki/$pageId", params: { pageId: to.pageId }, search: to.search, replace }),
    [navigate],
  );
  return useMemo(
    () => ({
      /** Opens a page beside the open one; with no page open, opens it. */
      open: (id: string) => (main ? go(besideOf(main, search, id)) : go({ pageId: id, search: {} })),
      swap: () => main && search.beside && go(swapped(main, search.beside)),
      close: () => main && go({ pageId: main, search: closed(search) }),
      /** The side page becomes the only one. */
      promote: () => search.beside && go({ pageId: search.beside, search: {} }),
      available: !!main,
    }),
    [go, main, search],
  );
}

/** Marks the side page, whose links open in it. */
export const BESIDE_ATTR = "data-wiki-beside";

const plainClick = (e: MouseEvent) => e.button === 0 && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;

/** Alt-click on a link to a page opens it beside, and so does a click inside the side page (mount once, in the wiki's frame). */
export function useBesideClicks() {
  const split = useSplit();
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const inside = plainClick(e) && !!target?.closest?.(`[${BESIDE_ATTR}]`);
      if (!isBesideClick(e) && !inside) return;
      const a = target?.closest?.("a[href]");
      const id = pageIdOfHref(a?.getAttribute("href"));
      if (!id) return;
      // A link in text being edited only places the caret, as anywhere in the editor.
      if (inside && a?.closest("[contenteditable]")?.getAttribute("contenteditable") === "true") return;
      // Before the link's own handler, and instead of the browser's Alt-click (a download).
      e.preventDefault();
      e.stopPropagation();
      split.open(id);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [split]);
}

/** Picks a page of the tree to open beside the one open. */
export function OpenBesideDialog({ open, onOpenChange, exclude }: { open: boolean; onOpenChange: (o: boolean) => void; exclude: string[] }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const { tree } = useWikiTree();
  const split = useSplit();
  const [query, setQuery] = useState("");
  const pages = useMemo(() => (open ? [...tree.byId.values()].filter((n) => !exclude.includes(n.id) && !n.template) : []), [open, tree, exclude]);
  const close = () => {
    onOpenChange(false);
    setQuery("");
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())} size="sm" title={t("split.pickTitle")} description={t("split.pickDescription")}>
      <Command loop className="-mx-2 flex flex-col">
        <div className="mx-2 rounded-md border border-line p-1">
          <Command.Input
            aria-label={t("split.search")}
            autoFocus={open && !window.matchMedia?.("(pointer: coarse)").matches}
            value={query}
            onValueChange={setQuery}
            placeholder={t("split.search")}
            className={pickerSearch.input}
          />
        </div>
        <Command.List className="max-h-[min(360px,50vh)] overflow-y-auto px-1 pt-1.5">
          <Command.Empty className="px-2 py-5 text-center text-xs text-fg-3">{t("split.none")}</Command.Empty>
          {pages.map((n) => {
            const path = ancestorsOf(tree, n.id).map((a) => title(a.title));
            return (
              <Command.Item
                key={n.id}
                value={`${title(n.title)} ${n.id}`}
                keywords={[...path, ...(n.aliases ?? [])]}
                onSelect={() => {
                  close();
                  split.open(n.id);
                }}
                className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[12.5px] text-fg data-[selected=true]:bg-hover [@media(pointer:coarse)]:h-10"
              >
                <PageIcon icon={n.icon} kind={n.kind} />
                <span className="min-w-0 flex-1 truncate">
                  {title(n.title)}
                  {path.length > 0 && <span className="ml-1.5 text-[11.5px] text-fg-4">{path.join(" / ")}</span>}
                </span>
              </Command.Item>
            );
          })}
        </Command.List>
      </Command>
    </Dialog>
  );
}
