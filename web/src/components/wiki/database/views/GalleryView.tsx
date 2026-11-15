// The gallery layout: a card per page in a grid that fills the width, each with its cover or
// the start of its text above its title and the view's properties, in sections when the view
// groups. Cards are dragged into place when the view has no sort, and into another section to
// change the value the view groups by.

import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui/empty";
import type { DbRow, DbValue, DbViewSettings } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { groupRows } from "@/lib/wiki/db";
import type { ViewProps } from "../DatabaseView";
import { PageIcon } from "../../PageTree";
import { CardPreview, Composer, GroupHeading, groupProp, indexAt, openKeys, regroup, RowFields, toggleCollapsed, useRowDrag, type RowDrag } from "./cards";

const MIN_W = { small: 180, medium: 240, large: 320 } as const;
const PREVIEW_H = { small: "h-24", medium: "h-32", large: "h-44" } as const;

export default function GalleryView(p: ViewProps) {
  const { t } = useTranslation("wiki");
  const { db, view, rows, ctx, canEdit, onSettings } = p;
  const s = view.settings ?? {};
  const prop = groupProp(db, view);
  const dnd = useRowDrag(p, prop);
  const collapsed = new Set(s.collapsed_groups ?? []);

  const grid = (key: string, list: DbRow[], values: Record<string, DbValue> | null) => (
    <div
      onDragOver={(e) => dnd.hover(e, key, indexAt(e, true))}
      onDragLeave={dnd.leave}
      onDrop={(e) => dnd.drop(e, key, list)}
      className="grid gap-3 pb-1 pt-1"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${MIN_W[s.card_size ?? "medium"]}px), 1fr))` }}
    >
      {list.map((r, i) => (
        <Card key={r.id} row={r} p={p} group={key} dnd={dnd} settings={s} edge={dnd.edge(key, list, i)} />
      ))}
      {canEdit && values && <NewCard p={p} values={values} settings={s} />}
    </div>
  );

  if (!prop)
    return !rows.length ? (
      <>
        <EmptyState compact art="wiki" title={t("db.noRows")} description={t("db.noRowsHint")} />
        {canEdit && grid("__all__", rows, {})}
      </>
    ) : (
      grid("__all__", rows, {})
    );
  return (
    <div className="flex flex-col gap-1">
      {groupRows(rows, prop.id, ctx, s).map((g) => (
        <section key={g.key}>
          <GroupHeading group={g} prop={prop} ctx={ctx} folded={collapsed.has(g.key)} onFold={() => onSettings(toggleCollapsed(s, g.key))} />
          {!collapsed.has(g.key) && grid(g.key, g.rows, regroup(prop, g.key))}
        </section>
      ))}
    </div>
  );
}

function Card({ row, p, group, dnd, settings, edge }: { row: DbRow; p: ViewProps; group: string; dnd: RowDrag; settings: DbViewSettings; edge: "before" | "after" | null }) {
  const { t } = useTranslation("wiki");
  const preview = settings.card_preview ?? "cover";
  const size = settings.card_size ?? "medium";
  const shows = preview === "cover" ? !!row.cover : preview === "content";
  return (
    <div className="relative">
      {edge && <span aria-hidden className={cn("pointer-events-none absolute inset-y-1 z-10 w-0.5 rounded-full bg-tone-blue-solid", edge === "before" ? "-left-[7px]" : "-right-[7px]")} />}
      <div
        data-card
        role="button"
        tabIndex={0}
        draggable={dnd.canDrag}
        onDragStart={(e) => dnd.start(e, row, group)}
        onDragEnd={dnd.end}
        onClick={() => p.onOpen(row)}
        onKeyDown={openKeys(() => p.onOpen(row))}
        className={cn(
          "group/card flex h-full cursor-default flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xs outline-none transition-[border-color,box-shadow,opacity] hover:border-line-strong focus-visible:shadow-[0_0_0_2px_var(--focus)]",
          dnd.dragging(row, group) && "opacity-40",
        )}
      >
        {preview !== "none" &&
          (shows ? (
            <CardPreview row={row} preview={preview} fit={settings.card_fit} className={PREVIEW_H[size]} />
          ) : (
            // No cover yet: a quiet plate with the page's icon keeps the grid even.
            <div className={cn("flex items-center justify-center border-b border-line-soft bg-sunken", PREVIEW_H[size])}>
              <PageIcon icon={row.icon} className={cn("opacity-80", row.icon ? "size-8 text-[26px]" : "size-6 text-fg-4/70")} />
            </div>
          ))}
        <div className="flex flex-col gap-1.5 px-3 py-2.5">
          <span className="flex min-w-0 items-start gap-1.5">
            {row.icon && (preview === "none" || shows) && <PageIcon icon={row.icon} className="mt-px" />}
            <span className={cn("line-clamp-2 min-w-0 break-words text-[13px] font-medium leading-[18px]", row.title.trim() ? "text-fg" : "text-fg-4")}>{row.title.trim() || t("untitled")}</span>
          </span>
          <RowFields row={row} props={p.props} ctx={p.ctx} />
        </div>
      </div>
    </div>
  );
}

function NewCard({ p, values, settings }: { p: ViewProps; values: Record<string, DbValue>; settings: DbViewSettings }) {
  const { t } = useTranslation("wiki");
  const [typing, setTyping] = useState(false);
  const preview = (settings.card_preview ?? "cover") !== "none";
  if (typing)
    return (
      <div className="flex min-h-[84px] flex-col justify-end overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
        {preview && <div className={cn("border-b border-line-soft bg-sunken", PREVIEW_H[settings.card_size ?? "medium"])} />}
        <div className="px-3 py-2.5">
          <Composer className="h-5 w-full" onClose={() => setTyping(false)} onSubmit={(title) => p.onCreate(values, { title })} />
        </div>
      </div>
    );
  return (
    <button
      type="button"
      onClick={() => setTyping(true)}
      className="flex min-h-[84px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line text-[12.5px] text-fg-4 transition-colors hover:border-line-strong hover:bg-hover hover:text-fg-2"
    >
      <Plus className="size-4" />
      {t("db.new")}
    </button>
  );
}
