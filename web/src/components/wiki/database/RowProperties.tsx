// A database row's properties, under its title on its page (Notion's): each with its icon
// and name, its value editable in place, and a way to add a property to the database. With
// dependencies, a row that starts before a row blocking it ends says so under "Blocked by".

import { AlertTriangle, Plus } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Database, DbProperty, DbRow, WikiPage } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { addProperty, cellValue, dependencyEdges, isEmpty, lateBlockers, type DbContext } from "@/lib/wiki/db";
import { Cell } from "./Cell";
import { PropIcon, withOption } from "./cells";
import { PropertyMenu } from "./PropertyMenu";
import { useDatabase, useDatabaseActions } from "./useDatabase";
import { spanOf } from "./views/time";

export function RowProperties({ page, canEdit }: { page: WikiPage; canEdit: boolean }) {
  const { t } = useTranslation("wiki");
  const dbId = page.parent_id ?? "";
  const { db, rows, ctx } = useDatabase(dbId);
  const act = useDatabaseActions(dbId);
  const [showEmpty, setShowEmpty] = useState(false);
  if (!db || !ctx) return null;
  const row = rows.find((r) => r.id === page.id);
  if (!row) return null;
  const list = db.properties.filter((p) => p.type !== "title");
  const filled = list.filter((p) => p.type === "checkbox" || !isEmpty(cellValue(row, p, ctx)));
  const hidden = list.length - filled.length;
  const shown = showEmpty || hidden <= 3 ? list : filled;
  const addOption = (prop: DbProperty, name: string) => {
    const made = withOption(db, prop.id, name);
    void act.saveSchema(made.db);
    return made.option;
  };
  const late = lateNames(db, rows, row, ctx, t("untitled"));
  return (
    <section aria-label={t("db.properties")} className="mt-5 flex flex-col gap-px">
      {shown.map((p) => (
        <Fragment key={p.id}>
          <div className="grid grid-cols-[minmax(120px,180px)_minmax(0,1fr)] items-start gap-2">
            <PropertyMenu
              db={db}
              prop={p}
              canEdit={canEdit}
              onSave={(next) => void act.saveSchema(next)}
              trigger={
                <button type="button" className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] text-fg-3 transition-colors hover:bg-hover hover:text-fg-2">
                  <PropIcon type={p.type} />
                  <span className="truncate">{p.name}</span>
                </button>
              }
            />
            <Cell prop={p} row={row} ctx={ctx} canEdit={canEdit} variant="page" placeholder={t("db.empty")} onChange={(v) => void act.updateRow(row.id, { [p.id]: v })} onAddOption={addOption} />
          </div>
          {p.id === db.dependencies?.blocked_by && late.length > 0 && (
            <div className="grid grid-cols-[minmax(120px,180px)_minmax(0,1fr)] gap-2 pb-1">
              <span />
              <p role="note" className="flex items-center gap-1.5 px-2 text-[12.5px] text-tone-red">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                {t("db.dependencies.late", { names: late.join(", ") })}
              </p>
            </div>
          )}
        </Fragment>
      ))}
      <div className="flex items-center gap-1 pt-0.5">
        {hidden > 3 && (
          <button type="button" onClick={() => setShowEmpty(!showEmpty)} className="h-7 rounded-md px-1.5 text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg">
            {showEmpty ? t("db.hideEmpty") : t("db.showEmpty", { count: hidden })}
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => void act.saveSchema(addProperty(db, "text", t("db.prop.newName")).db)}
            className={cn("flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg")}
          >
            <Plus className="size-3.5" />
            {t("db.addProperty")}
          </button>
        )}
      </div>
      <div className="mt-3 h-px bg-line-soft" />
    </section>
  );
}

/**
 * The titles of the rows blocking this one that end after it starts, by the dates the
 * database's first timeline places rows by (or its first date property).
 */
function lateNames(db: Database, rows: DbRow[], row: DbRow, ctx: DbContext, untitled: string): string[] {
  if (!db.dependencies) return [];
  const timeline = db.views.find((v) => v.type === "timeline" && v.settings?.date_property)?.settings;
  const start = db.properties.find((p) => p.id === timeline?.date_property) ?? db.properties.find((p) => p.type === "date");
  if (!start) return [];
  const end = timeline?.end_property ? db.properties.find((p) => p.id === timeline.end_property) : undefined;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const span = (id: string) => {
    const r = byId.get(id);
    return r ? spanOf(cellValue(r, start, ctx), end ? cellValue(r, end, ctx) : undefined) : null;
  };
  return lateBlockers(row.id, dependencyEdges(db, rows), span).map((id) => byId.get(id)?.title.trim() || untitled);
}
