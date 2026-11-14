// Customize the wiki's sidebar: the sections in the order the member wants, each shown or
// hidden. Moving uses buttons (and the keyboard), so it works the same on touch screens.

import { ArrowDown, ArrowUp, Clock, Lock, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { TeamDot } from "@/components/tickets/teams";
import { arrange, useSidebarLayout, type SectionKey } from "./sidebarLayout";
import { useSections } from "./WikiTree";

export function CustomizeSidebar({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation("wiki");
  const sections = useSections();
  const { layout, setOrder, setHidden, reset } = useSidebarLayout();
  const order = arrange(
    sections.map((s) => s.key),
    layout,
  );
  const byKey = new Map(sections.map((s) => [s.key, s]));
  const shift = (key: SectionKey, by: -1 | 1) => {
    const next = [...order];
    const i = next.indexOf(key);
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };
  const label = (key: SectionKey) => {
    if (key === "favorites")
      return (
        <>
          <Star className="size-3.5 text-tone-amber" />
          {t("favorites.title")}
        </>
      );
    if (key === "recent")
      return (
        <>
          <Clock className="size-3.5 text-fg-3" />
          {t("sidebar.recent")}
        </>
      );
    if (key === "workspace") return t("sidebar.workspace");
    if (key === "private")
      return (
        <>
          <Lock className="size-3.5 text-fg-3" />
          {t("sidebar.private")}
        </>
      );
    const team = byKey.get(key)?.team;
    return (
      <>
        <TeamDot team={team} />
        {team?.name}
        {team?.private && <Lock className="size-3 text-fg-4" />}
      </>
    );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" title={t("sidebar.customize")} description={t("sidebar.customizeBody")}>
      <ul className="-mx-1 flex flex-col">
        {order.map((key, i) => {
          const shown = !layout.hidden.includes(key);
          return (
            <li key={key} className="flex h-10 items-center gap-2 rounded-md px-1 hover:bg-hover">
              <span className="flex flex-col">
                <button type="button" aria-label={t("sidebar.moveUp")} disabled={i === 0} onClick={() => shift(key, -1)} className="flex h-4 w-5 items-center justify-center rounded text-fg-4 hover:text-fg disabled:opacity-30">
                  <ArrowUp className="size-3" />
                </button>
                <button type="button" aria-label={t("sidebar.moveDown")} disabled={i === order.length - 1} onClick={() => shift(key, 1)} className="flex h-4 w-5 items-center justify-center rounded text-fg-4 hover:text-fg disabled:opacity-30">
                  <ArrowDown className="size-3" />
                </button>
              </span>
              <span className={`flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13px] ${shown ? "text-fg" : "text-fg-4"}`}>{label(key)}</span>
              <Switch checked={shown} onCheckedChange={(v) => setHidden(key, !v)} aria-label={t("sidebar.show")} />
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex justify-between">
        <Button variant="ghost" size="sm" onClick={reset}>
          {t("sidebar.reset")}
        </Button>
        <Button variant="primary" size="sm" onClick={() => onOpenChange(false)}>
          {t("sidebar.done")}
        </Button>
      </div>
    </Dialog>
  );
}
