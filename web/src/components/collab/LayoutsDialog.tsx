// "Start from a layout": a few arrangements of the built-in sections, each previewed as the
// sidebar would look with it (the member's own sections where they would land), applied in
// one click and undone from the toast.

import { Check } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { buildRow, useRowLabels } from "@/components/spaces/rows";
import { useFavorites } from "@/components/wiki/hooks";
import { useWorkspacesData } from "@/lib/spaces/hooks";
import { applyRowOrder, isOrdered } from "@/lib/collab/rowOrder";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useCollab } from "@/lib/collab/hooks";
import { applyLayout, hasLayout, LAYOUTS, type Layout, type LayoutId } from "@/lib/collab/layouts";
import { entryKey, visibleEntries } from "@/lib/collab/ownSections";
import { useInboxNames } from "@/components/tickets/inboxes/inboxNames";
import { isHidden, livePins } from "@/lib/collab/sidebarPrefs";
import { useProducts } from "@/lib/products";
import { useOwnSidebar } from "./AddToSidebar";
import { useSidebarItems } from "./sidebarItems";

const useLayoutsUi = create<{ open: boolean }>(() => ({ open: false }));
export const layoutsUi = {
  open: () => useLayoutsUi.setState({ open: true }),
  close: () => useLayoutsUi.setState({ open: false }),
};

/** The sidebar as a layout would leave it: section titles and the first few rows of each. */
function Preview({ layout }: { layout: Layout }) {
  const { t } = useTranslation("collab");
  const { prefs, wid } = useOwnSidebar();
  const collab = useCollab().enabled;
  const products = useProducts();
  const labels = useRowLabels();
  const { itemsOf, pinLabel } = useSidebarItems();
  const fav = useFavorites();
  const inboxNames = useInboxNames();
  const d = useWorkspacesData(wid ? [wid] : [], { folders: () => true, wiki: () => true }).get(wid);
  const next = applyLayout(prefs, layout);
  const entries = visibleEntries(next, collab).filter((e) =>
    e.kind === "custom"
      ? true
      : e.kind === "inbox"
        ? products.tickets && !!inboxNames(e.scope)
        : (products.tickets || (e.id !== "inbox" && e.id !== "teams" && e.id !== "views")) && (products.pages || e.id !== "pages"),
  );
  const rowsOf = (e: (typeof entries)[number]): string[] => {
    if (e.kind === "custom") return e.section.items.map((i) => i.name || (d && buildRow(i, d, { labels })?.label) || "").filter(Boolean);
    if (e.kind === "inbox") return [];
    if (e.id === "favorites") return [...livePins(next, (p) => pinLabel(p)).map((x) => x.target), ...fav.list.map((n) => n.title.trim() || labels.untitled)];
    const rows = itemsOf(e.id).filter((x) => !x.depth && !x.key.startsWith("every:") && !(x.hideId && isHidden(next, x.hideId)));
    return (isOrdered(e.id) ? applyRowOrder(rows, (x) => x.hideId ?? x.key, next.row_order[e.id]) : rows).map((x) => x.label);
  };
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto rounded-lg bg-chrome p-3 shadow-[inset_0_0_0_1px_var(--chrome-line)]">
      {entries.map((e) => {
        const rows = rowsOf(e);
        const title = e.kind === "custom" ? e.section.title || t("ownSections.untitled") : e.kind === "inbox" ? (inboxNames(e.scope)?.title ?? "") : labels.section(e.id, collab);
        return (
          <div key={entryKey(e)}>
            <p className="label-caps mb-1 truncate px-1.5">{title}</p>
            <div className="flex flex-col gap-px">
              {rows.slice(0, 3).map((r, i) => (
                <span key={`${r}-${i}`} className="truncate rounded px-1.5 py-[3px] text-[12px] text-fg-2">
                  {r}
                </span>
              ))}
              {rows.length > 3 && <span className="px-1.5 text-[11px] text-fg-4">{t("layouts.more", { count: rows.length - 3 })}</span>}
              {!rows.length && <span className="mx-1.5 my-1 h-1.5 w-16 rounded-full bg-chrome-active" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function LayoutsDialog() {
  const { t } = useTranslation("collab");
  const open = useLayoutsUi((s) => s.open);
  const { prefs, change } = useOwnSidebar();
  const [picked, setPicked] = useState<LayoutId>("support");
  const layout = LAYOUTS.find((l) => l.id === picked) ?? LAYOUTS[0];
  const use = () => {
    const before = prefs;
    change(applyLayout(prefs, layout));
    layoutsUi.close();
    toast.undo(t("layouts.applied", { name: t(`layouts.${layout.id}.name`) }), () => change(before), t("edit.undo"));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && layoutsUi.close()}
      size="lg"
      title={t("layouts.title")}
      description={t("layouts.description")}
      footer={
        <>
          <Button variant="ghost" onClick={() => layoutsUi.close()}>
            {t("layouts.cancel")}
          </Button>
          <Button variant="primary" disabled={hasLayout(prefs, layout)} onClick={use}>
            {t("layouts.use")}
          </Button>
        </>
      }
    >
      <div className="grid h-[min(400px,56vh)] grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
        <div role="radiogroup" aria-label={t("layouts.title")} className="flex flex-col gap-1.5">
          {LAYOUTS.map((l) => {
            const on = l.id === picked;
            const current = hasLayout(prefs, l);
            return (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPicked(l.id)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border px-3.5 py-3 text-left outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--focus)]",
                  on ? "border-fg/30 bg-hover" : "border-line hover:bg-hover/60",
                )}
              >
                <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", on ? "border-fg bg-fg text-surface" : "border-line-strong")}>
                  {on && <Check className="size-2.5" strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    {t(`layouts.${l.id}.name`)}
                    {current && <span className="rounded bg-sunken px-1.5 py-px text-[10.5px] font-normal text-fg-3">{t("layouts.current")}</span>}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-fg-3">{t(`layouts.${l.id}.hint`)}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="hidden min-h-0 flex-col gap-1.5 sm:flex">
          <p className="label-caps">{t("layouts.preview")}</p>
          <div className="min-h-0 flex-1">
            <Preview layout={layout} />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
