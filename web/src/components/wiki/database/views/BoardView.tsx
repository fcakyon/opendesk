// The board layout: a column per value of the property the view groups by (a status's
// columns in its groups' order, then "No value"), a card per page in its column. Cards are
// dragged into another column to change that value, and into place when the view has no
// sort; a column folds into a thin strip. Cards show the page's cover or the start of its
// text when the view asks, and the view's properties that have a value.

import { ChevronsLeftRight, ChevronsRightLeft, Plus } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { DbProperty, DbRow, DbViewSettings } from "@/lib/api/types";
import { EmptyState } from "@/components/ui/empty";
import { cn } from "@/lib/cn";
import { formatCount, groupRows, NO_VALUE, type Group } from "@/lib/wiki/db";
import type { ViewProps } from "../DatabaseView";
import { PageIcon } from "../../PageTree";
import { CardPreview, Composer, GroupLabel, groupProp, indexAt, openKeys, regroup, RowFields, toggleCollapsed, useGroupName, useRowDrag, type RowDrag } from "./cards";

const COLUMN_W = { small: 220, medium: 264, large: 320 } as const;

export default function BoardView(p: ViewProps) {
  const { t } = useTranslation("wiki");
  const { db, view, rows, ctx, onSettings } = p;
  const prop = groupProp(db, view);
  const dnd = useRowDrag(p, prop);
  if (!prop)
    return (
      <EmptyState compact art="wiki" title={t("db.board.pickGroup")} description={t("db.board.pickGroupHint")} />
    );
  const s = view.settings ?? {};
  const width = COLUMN_W[s.card_size ?? "medium"];
  const collapsed = new Set(s.collapsed_groups ?? []);
  const groups = groupRows(rows, prop.id, ctx, s);
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-3">
      <div className="flex min-w-max items-start gap-2.5" style={{ "--col": `${width}px` } as CSSProperties}>
        {groups.map((g) =>
          collapsed.has(g.key) ? (
            <FoldedColumn key={g.key} group={g} prop={prop} dnd={dnd} onUnfold={() => onSettings(toggleCollapsed(s, g.key))} />
          ) : (
            <Column key={g.key} group={g} prop={prop} p={p} dnd={dnd} settings={s} onFold={() => onSettings(toggleCollapsed(s, g.key))} />
          ),
        )}
      </div>
    </div>
  );
}

/** A column's tint: its option's tone, a quiet grey otherwise. */
const toneOf = (g: Group) => (g.color ? `db-bar-${g.color}` : "db-bar-gray");

function Column({ group, prop, p, dnd, settings, onFold }: { group: Group; prop: DbProperty; p: ViewProps; dnd: RowDrag; settings: DbViewSettings; onFold: () => void }) {
  const { t } = useTranslation("wiki");
  const name = useGroupName()(group, prop);
  const values = p.canEdit ? regroup(prop, group.key) : null;
  // The column already says a single value; a card repeats only what it doesn't.
  const single = prop.type === "select" || prop.type === "status" || prop.type === "checkbox";
  const [adding, setAdding] = useState<"top" | "bottom" | null>(null);
  const target = dnd.over?.group === group.key && dnd.drag?.from !== group.key;
  const add = (title: string) => p.onCreate(values ?? undefined, { title, ...(adding === "top" && !p.sorted && group.rows[0] ? { position: p.allRows.findIndex((r) => r.id === group.rows[0].id) } : {}) });
  return (
    <section
      aria-label={name}
      onDragOver={(e) => dnd.hover(e, group.key, indexAt(e))}
      onDragLeave={dnd.leave}
      onDrop={(e) => dnd.drop(e, group.key, group.rows)}
      className={cn(
        "group/col flex w-[var(--col)] shrink-0 flex-col rounded-lg bg-[color-mix(in_srgb,var(--db-bar)_4%,var(--sunken))] shadow-[inset_0_0_0_1px_var(--line-soft)] transition-shadow",
        toneOf(group),
        target && "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--db-bar)_45%,transparent)]",
      )}
    >
      <header className="flex h-10 items-center gap-1.5 pl-2.5 pr-1.5">
        <span className="flex min-w-0 items-center">
          <GroupLabel group={group} prop={prop} ctx={p.ctx} />
        </span>
        <span className="mono text-[11.5px] text-fg-4">{formatCount(group.rows.length)}</span>
        <span className="ml-auto flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/col:opacity-100 [@media(hover:none)]:opacity-100">
          <button type="button" aria-label={t("db.board.fold", { name })} title={t("db.board.fold", { name })} onClick={onFold} className="flex size-6 items-center justify-center rounded-md text-fg-4 hover:bg-hover hover:text-fg">
            <ChevronsRightLeft className="size-3.5" />
          </button>
          {values && (
            <button type="button" aria-label={t("db.board.addTo", { name })} title={t("db.board.addTo", { name })} onClick={() => setAdding("top")} className="flex size-6 items-center justify-center rounded-md text-fg-4 hover:bg-hover hover:text-fg">
              <Plus className="size-3.5" />
            </button>
          )}
        </span>
      </header>
      <div className="flex min-h-10 flex-col gap-1.5 px-1.5 pb-1.5">
        {adding === "top" && <NewCard onClose={() => setAdding(null)} onSubmit={add} />}
        {group.rows.map((r, i) => (
          <Card key={r.id} row={r} p={p} group={group.key} dnd={dnd} settings={settings} edge={dnd.edge(group.key, group.rows, i)} skip={single ? prop.id : undefined} />
        ))}
        {!group.rows.length && dnd.over?.group === group.key && <span className="h-0.5 rounded-full bg-tone-blue-solid" />}
        {adding === "bottom" ? (
          <NewCard onClose={() => setAdding(null)} onSubmit={add} />
        ) : (
          values && (
            <button type="button" onClick={() => setAdding("bottom")} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-4 transition-colors hover:bg-hover hover:text-fg-2">
              <Plus className="size-3.5" />
              {t("db.new")}
            </button>
          )
        )}
      </div>
    </section>
  );
}

/** A folded column: a thin strip with its name running down, still a place to drop cards. */
function FoldedColumn({ group, prop, dnd, onUnfold }: { group: Group; prop: DbProperty; dnd: RowDrag; onUnfold: () => void }) {
  const { t } = useTranslation("wiki");
  const name = useGroupName()(group, prop);
  const target = dnd.over?.group === group.key;
  return (
    <button
      type="button"
      onClick={onUnfold}
      aria-label={t("db.board.unfold", { name })}
      title={t("db.board.unfold", { name })}
      onDragOver={(e) => dnd.hover(e, group.key, group.rows.length)}
      onDragLeave={dnd.leave}
      onDrop={(e) => dnd.drop(e, group.key, group.rows)}
      className={cn(
        "flex w-10 shrink-0 flex-col items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--db-bar)_4%,var(--sunken))] py-2.5 shadow-[inset_0_0_0_1px_var(--line-soft)] transition-[background-color,box-shadow] hover:bg-hover",
        toneOf(group),
        target && "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--db-bar)_45%,transparent)]",
      )}
    >
      <ChevronsLeftRight className="size-3.5 shrink-0 text-fg-4" />
      <span className="mono text-[11.5px] text-fg-4">{formatCount(group.rows.length)}</span>
      <span className="flex max-h-[240px] min-h-0 items-center overflow-hidden [writing-mode:vertical-rl]">
        <span className={cn("truncate text-[12.5px] font-medium", group.key === NO_VALUE ? "text-fg-3" : "text-fg")}>
          {group.color && <span className={cn("mb-1.5 inline-block size-2 rounded-full", `db-dot-${group.color}`)} />}
          {name}
        </span>
      </span>
    </button>
  );
}

const PREVIEW_H = { small: "h-20", medium: "h-28", large: "h-36" } as const;

function Card({ row, p, group, dnd, settings, edge, skip }: { row: DbRow; p: ViewProps; group: string; dnd: RowDrag; settings: DbViewSettings; edge: "before" | "after" | null; skip?: string }) {
  const { t } = useTranslation("wiki");
  const preview = settings.card_preview ?? "none";
  const hasPreview = (preview === "cover" && !!row.cover) || (preview === "content" && !!row.excerpt.trim());
  return (
    <div className="relative">
      {edge === "before" && <DropLine className="-top-[4.5px]" />}
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
          "flex cursor-default flex-col overflow-hidden rounded-md border border-line bg-surface shadow-xs outline-none transition-[border-color,box-shadow,opacity] hover:border-line-strong focus-visible:shadow-[0_0_0_2px_var(--focus)]",
          dnd.dragging(row, group) && "opacity-40",
        )}
      >
        {hasPreview && <CardPreview row={row} preview={preview} fit={settings.card_fit} className={PREVIEW_H[settings.card_size ?? "medium"]} />}
        <div className="flex flex-col gap-1.5 px-2.5 py-2">
          <span className="flex min-w-0 items-start gap-1.5">
            {row.icon && <PageIcon icon={row.icon} className="mt-px" />}
            <span className={cn("line-clamp-3 min-w-0 break-words text-[13px] font-medium leading-[18px]", row.title.trim() ? "text-fg" : "text-fg-4")}>{row.title.trim() || t("untitled")}</span>
          </span>
          <RowFields row={row} props={p.props} ctx={p.ctx} skip={skip} />
        </div>
      </div>
      {edge === "after" && <DropLine className="-bottom-[4.5px]" />}
    </div>
  );
}

function DropLine({ className }: { className: string }) {
  return <span aria-hidden className={cn("pointer-events-none absolute inset-x-0.5 z-10 h-0.5 rounded-full bg-tone-blue-solid", className)} />;
}

function NewCard({ onSubmit, onClose }: { onSubmit: (title: string) => Promise<unknown>; onClose: () => void }) {
  return (
    <div className="rounded-md border border-line bg-surface px-2.5 py-2 shadow-xs">
      <Composer className="h-5 w-full" onClose={onClose} onSubmit={onSubmit} />
    </div>
  );
}
