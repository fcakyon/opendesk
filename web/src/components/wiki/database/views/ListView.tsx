// The list layout: a line per page, its icon and title on the left and the view's properties
// as quiet values on the right, grouped when the view groups, dragged into order when the view
// has no sort.

import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui/empty";
import type { DbRow, DbValue } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { groupRows } from "@/lib/wiki/db";
import type { ViewProps } from "../DatabaseView";
import { PageIcon } from "../../WikiTree";
import { Composer, GroupHeading, groupProp, indexAt, openKeys, regroup, RowFields, toggleCollapsed, useRowDrag, type RowDrag } from "./cards";

export default function ListView(p: ViewProps) {
  const { t } = useTranslation("wiki");
  const { db, view, rows, ctx, canEdit, onSettings } = p;
  const prop = groupProp(db, view);
  const dnd = useRowDrag(p, prop);
  const collapsed = new Set(view.settings?.collapsed_groups ?? []);

  if (!prop && !rows.length)
    return (
      <>
        <EmptyState compact art="wiki" title={t("db.noRows")} description={t("db.noRowsHint")} />
        {canEdit && <NewLine p={p} />}
      </>
    );

  const block = (key: string, list: DbRow[], values?: Record<string, DbValue>) => (
    <div onDragOver={(e) => dnd.hover(e, key, indexAt(e))} onDragLeave={dnd.leave} onDrop={(e) => dnd.drop(e, key, list)}>
      {list.map((r, i) => (
        <Line key={r.id} row={r} p={p} group={key} dnd={dnd} edge={dnd.edge(key, list, i)} />
      ))}
      {canEdit && values && <NewLine p={p} values={values} />}
    </div>
  );

  if (!prop) return block("__all__", rows, {});
  return (
    <div>
      {groupRows(rows, prop.id, ctx, view.settings).map((g) => (
        <section key={g.key}>
          <GroupHeading group={g} prop={prop} ctx={ctx} folded={collapsed.has(g.key)} onFold={() => onSettings(toggleCollapsed(view.settings, g.key))} />
          {!collapsed.has(g.key) && block(g.key, g.rows, regroup(prop, g.key) ?? undefined)}
        </section>
      ))}
    </div>
  );
}

function Line({ row, p, group, dnd, edge }: { row: DbRow; p: ViewProps; group: string; dnd: RowDrag; edge: "before" | "after" | null }) {
  const { t } = useTranslation("wiki");
  return (
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
        "flex h-9 min-w-0 cursor-default items-center gap-2 rounded-md px-2 outline-none transition-[background-color,opacity] hover:bg-hover focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]",
        dnd.dragging(row, group) && "opacity-40",
        edge === "before" && "shadow-[inset_0_2px_0_var(--tone-blue-solid)]",
        edge === "after" && "shadow-[inset_0_-2px_0_var(--tone-blue-solid)]",
      )}
    >
      <PageIcon icon={row.icon} />
      <span className={cn("min-w-0 max-w-[60%] shrink-0 truncate text-[13px] font-medium", row.title.trim() ? "text-fg" : "text-fg-4")}>{row.title.trim() || t("untitled")}</span>
      <RowFields row={row} props={p.props} ctx={p.ctx} inline />
    </div>
  );
}

function NewLine({ p, values }: { p: ViewProps; values?: Record<string, DbValue> }) {
  const { t } = useTranslation("wiki");
  const [typing, setTyping] = useState(false);
  if (typing)
    return (
      <div className="flex h-9 items-center gap-2 px-2">
        <Plus className="size-3.5 shrink-0 text-fg-4" />
        <Composer className="h-7 flex-1" onClose={() => setTyping(false)} onSubmit={(title) => p.onCreate(values, { title })} />
      </div>
    );
  return (
    <button type="button" onClick={() => setTyping(true)} className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-[13px] text-fg-4 transition-colors hover:bg-hover hover:text-fg-2">
      <Plus className="size-3.5" />
      {t("db.new")}
    </button>
  );
}
