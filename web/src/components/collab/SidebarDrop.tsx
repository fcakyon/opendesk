// Where the sidebar takes what is dragged in from the page (lib/collab/sidebarDrag.ts):
// Favorites pins it (a page is starred), a section of the member's own adds it where it is
// dropped (OwnSection), and while such a drag runs a spot at the end offers a new section
// named after it.

import { Plus } from "lucide-react";
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { useFavorites, useWikiTree } from "@/components/wiki/hooks";
import { cn } from "@/lib/cn";
import { newOwnSection, OWN_LIMITS, sectionOf } from "@/lib/collab/ownSections";
import { carriesSidebarRow, readSidebarDrag, SIDEBAR_DRAG, type SidebarDragItem } from "@/lib/collab/sidebarDrag";
import { isPinned, MAX_PINS, togglePin } from "@/lib/collab/sidebarPrefs";
import type { SidebarPin } from "@/lib/api/types";
import { useOwnSidebar } from "./AddToSidebar";

const PIN_KINDS: readonly string[] = ["ticket_folder", "team", "view", "box", "account", "folder"];

/** Whether something is being dragged toward the sidebar anywhere in the window. */
export function useSidebarDragging(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const start = (e: globalThis.DragEvent) => setOn(!!e.dataTransfer?.types.includes(SIDEBAR_DRAG));
    const end = () => setOn(false);
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, []);
  return on;
}

/** Drop handlers that take a dragged row, and whether one is over the element. */
function useDrop(take: (item: SidebarDragItem) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!carriesSidebarRow(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!over) setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        setOver(false);
        const item = readSidebarDrag(e);
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        take(item);
      },
    },
  };
}

/** Favorites as a drop target: a pinnable row is pinned, a page starred. */
export function FavoritesDrop({ children }: { children: ReactNode }) {
  const { t } = useTranslation("collab");
  const { prefs, change } = useOwnSidebar();
  const fav = useFavorites();
  const { tree } = useWikiTree();
  const { over, props } = useDrop((item) => {
    if (item.kind === "wiki_page") {
      const node = tree.byId.get(item.id);
      if (node && !fav.has(node.id)) fav.toggle(node);
      return;
    }
    if (!PIN_KINDS.includes(item.kind)) return;
    const pin = { kind: item.kind, id: item.id } as SidebarPin;
    if (isPinned(prefs, pin)) return;
    if (prefs.pinned.length >= MAX_PINS) return void toast.error(t("customize.pinLimit"));
    change(togglePin(prefs, pin));
  });
  return (
    <div {...props} className={cn("rounded-lg transition-colors duration-150", over && "bg-chrome-hover shadow-[inset_0_0_0_1px_var(--tone-blue-solid)]")}>
      {children}
    </div>
  );
}

/** At the end of the sidebar while a row is dragged in: drop it for a new section named after it. */
export function NewSectionDrop() {
  const { t } = useTranslation("collab");
  const { prefs, wid, change } = useOwnSidebar();
  const dragging = useSidebarDragging();
  const { over, props } = useDrop((item) => {
    if (prefs.sections.length >= OWN_LIMITS.sections) return void toast.error(t("ownSections.tooMany"));
    const moving = !!sectionOf(prefs, wid, item);
    if (!moving && prefs.sections.reduce((n, s) => n + s.items.length, 0) >= OWN_LIMITS.items) return void toast.error(t("ownSections.full"));
    change(newOwnSection(prefs, wid, item.label.slice(0, OWN_LIMITS.title), { kind: item.kind, id: item.id }).prefs);
  });
  if (!dragging) return null;
  return (
    <div
      {...props}
      className={cn(
        "mx-2.5 mt-4 flex h-9 items-center gap-2 rounded-md border border-dashed px-2.5 text-[12.5px] transition-colors duration-150 [&>svg]:size-3.5",
        over ? "border-tone-blue-solid bg-chrome-hover text-fg" : "border-line-strong text-fg-3",
      )}
    >
      <Plus />
      <span className="truncate">{t("edit.dropNew")}</span>
    </div>
  );
}
