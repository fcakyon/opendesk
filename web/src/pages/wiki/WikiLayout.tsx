// The frame of the wiki and of Pages (contracts/pages.md): the area's page tree on the left,
// the page or the area's home beside it. On narrow screens the tree is a sheet opened from the
// page's header (PagesButton). On wide ones the same button shows or hides the tree, remembered
// per area in this browser; until the member chooses, Pages' is hidden while the main sidebar
// has the Pages section, which holds the same tree, and the wiki's shows.

import { Outlet } from "@tanstack/react-router";
import { ListTree, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { WikiTree } from "@/components/wiki/WikiTree";
import { useBesideClicks } from "@/components/wiki/split";
import { useCollab, useSidebarPrefs } from "@/lib/collab/hooks";
import { visibleSections } from "@/lib/collab/sidebarPrefs";
import { AreaProvider, useArea } from "@/lib/wiki/area";

const COLUMN_KEY = "od-wiki-column";

type Frame = { openSheet: () => void; column: boolean; toggleColumn: () => void };
const FrameCtx = createContext<Frame>({ openSheet: () => {}, column: true, toggleColumn: () => {} });

function readColumn(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    return v === "shown" ? true : v === "hidden" ? false : null;
  } catch {
    return null;
  }
}

/** Opens the page tree on narrow screens, and shows or hides it beside the page on wide ones. */
export function PagesButton() {
  const { t } = useTranslation("wiki");
  const { openSheet, column, toggleColumn } = useContext(FrameCtx);
  const label = column ? t("tree.hideColumn") : t("tree.showColumn");
  return (
    <>
      <Button square variant="ghost" size="sm" className="md:hidden" aria-label={t("tree.open")} onClick={openSheet}>
        <ListTree className="size-4" />
      </Button>
      <Tooltip content={label}>
        <Button square variant="ghost" size="sm" className="hidden md:inline-flex" aria-label={label} aria-pressed={column} onClick={toggleColumn}>
          {column ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
        </Button>
      </Tooltip>
    </>
  );
}

/** The wiki's frame; Pages' is the same in Pages' area (PagesLayout). */
export default function WikiLayout() {
  return (
    <AreaProvider area="wiki">
      <AreaFrame />
    </AreaProvider>
  );
}

export function AreaFrame() {
  const { t } = useTranslation("wiki");
  const area = useArea();
  const key = area === "pages" ? COLUMN_KEY : `${COLUMN_KEY}:wiki`;
  const [sheet, setSheet] = useState(false);
  const [chosen, setChosen] = useState(() => readColumn(key));
  const pagesInSidebar = visibleSections(useSidebarPrefs(), useCollab().enabled).includes("pages");
  const column = chosen ?? (area === "wiki" || !pagesInSidebar);
  const toggleColumn = () => {
    setChosen(!column);
    try {
      localStorage.setItem(key, column ? "hidden" : "shown");
    } catch {
      /* storage unavailable */
    }
  };
  // Alt-click on a link to a page opens it beside the open one (contracts/wiki.md "Split view").
  useBesideClicks();

  return (
    <FrameCtx.Provider value={{ openSheet: () => setSheet(true), column, toggleColumn }}>
      <div className="flex h-full min-h-0">
        {column && (
          <aside aria-label={t("tree.label")} className="hidden w-[264px] shrink-0 border-r border-line md:block">
            <WikiTree />
          </aside>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
      <Drawer open={sheet} onOpenChange={setSheet} title={area === "pages" ? t("pages.title") : t("title")} width={340}>
        <WikiTree onNavigate={() => setSheet(false)} />
      </Drawer>
    </FrameCtx.Provider>
  );
}
