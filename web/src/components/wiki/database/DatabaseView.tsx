// A wiki database on its page or inside another page (contracts/wiki.md "Databases"): its
// views as tabs (table, board, list, gallery, calendar, timeline, chart, form), the controls
// of the view that is open, and the view itself. On its own page, ?view=<id> opens a view
// (a form's link). Every layout gets the same rows, already
// searched, filtered and sorted, and the same writes (ViewProps).

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { BarChart3, CalendarDays, ChevronDown, ClipboardList, Copy, GanttChart, KanbanSquare, LayoutGrid, List, MoreHorizontal, Pencil, Plus, Search, Table2, Trash2, X, Repeat2, ArrowUpRight, FilePlus2 } from "lucide-react";
import { DropdownMenu as M } from "radix-ui";
import { Button } from "@/components/ui/button";
import { menuItemCls, MenuSeparator } from "@/components/ui/menu";
import { floatingPanel } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { Database, DbOption, DbProperty, DbRow, DbValue, DbView, DbViewSettings, DbViewType } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { defaultView, filterDefaults, filterRows, newViewId, searchRows, sortRows, visibleProps, type DbContext } from "@/lib/wiki/db";
import { atLeast, useRole } from "@/lib/session";
import { Tooltip } from "@/components/ui/tooltip";
import { useTitle } from "../hooks";
import { PageIcon } from "../PageTree";
import { ActiveChips, FilterMenu, GroupMenu, LayoutMenu, PropertiesMenu, SortMenu, toolButton } from "./Toolbar";
import { useDatabase, useDatabaseActions } from "./useDatabase";
import { withOption } from "./cells";
import { RowPeek } from "./RowPeek";
import { DatabaseKeys } from "./DatabaseKeys";
import "./database.css";

/** What every layout of a database gets. */
export type ViewProps = {
  /** The database page's id. */
  databaseId: string;
  db: Database;
  view: DbView;
  /** The view's rows: searched, filtered and sorted. */
  rows: DbRow[];
  /** Every row of the database. */
  allRows: DbRow[];
  /** The properties the view shows, in its order (the title first). */
  props: DbProperty[];
  ctx: DbContext;
  canEdit: boolean;
  /** The view has sorts: rows keep the sorted order and can't be dragged into another. */
  sorted: boolean;
  onOpen: (row: DbRow) => void;
  onUpdate: (rowId: string, values: Record<string, DbValue>) => void;
  onRename: (rowId: string, title: string) => void;
  onCreate: (values?: Record<string, DbValue>, opts?: { title?: string; position?: number }) => Promise<DbRow | null>;
  onTrash: (ids: string[]) => void;
  onMove: (rowId: string, position: number) => void;
  onAddOption: (prop: DbProperty, name: string) => DbOption;
  onSchema: (db: Database) => void;
  onSettings: (settings: DbViewSettings) => void;
};

const LAYOUTS: Record<DbViewType, ComponentType<ViewProps>> = {
  table: lazy(() => import("./views/TableView")),
  board: lazy(() => import("./views/BoardView")),
  list: lazy(() => import("./views/ListView")),
  gallery: lazy(() => import("./views/GalleryView")),
  calendar: lazy(() => import("./views/CalendarView")),
  timeline: lazy(() => import("./views/TimelineView")),
  chart: lazy(() => import("./views/ChartView")),
  form: lazy(() => import("./views/FormView")),
};

export const VIEW_ICONS: Record<DbViewType, typeof Table2> = { table: Table2, board: KanbanSquare, list: List, gallery: LayoutGrid, calendar: CalendarDays, timeline: GanttChart, chart: BarChart3, form: ClipboardList };
const VIEW_TYPES: DbViewType[] = ["table", "board", "list", "gallery", "calendar", "timeline", "chart", "form"];
const GROUPED: DbViewType[] = ["table", "board", "list", "gallery"];

export function DatabaseView({ databaseId, viewId, onViewChange, inline }: { databaseId: string; viewId?: string; onViewChange?: (id: string) => void; inline?: boolean }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const navigate = useNavigate();
  const canEdit = atLeast(useRole(), "agent");
  const { page, db, rows, templates, ctx, isLoading, isError } = useDatabase(databaseId);
  const act = useDatabaseActions(databaseId);
  // A view's link (a form shared with teammates) opens it on the database's own page.
  const linked = useLocation({ select: (l) => (inline ? undefined : (l.search as Record<string, unknown>).view) });
  const [localView, setLocalView] = useState<string | undefined>(viewId ?? (typeof linked === "string" ? linked : undefined));
  useEffect(() => {
    if (typeof linked === "string") setLocalView(linked);
  }, [linked]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [peek, setPeek] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { ref: tabsRef, fade: tabsFade, update: fadeTabs } = useEdgeFade();

  const view = db?.views.find((v) => v.id === (viewId ?? localView)) ?? db?.views[0];
  // The open view's tab stays in sight when the tabs don't fit.
  useEffect(() => {
    const list = tabsRef.current;
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !tab) return;
    const box = list.getBoundingClientRect();
    const at = tab.getBoundingClientRect();
    if (at.left < box.left) list.scrollLeft -= box.left - at.left + 24;
    else if (at.right > box.right) list.scrollLeft += at.right - box.right + 24;
    fadeTabs();
  }, [view?.id, db?.views.length, tabsRef, fadeTabs]);
  const shown = useMemo(() => {
    if (!db || !view || !ctx) return [];
    let list = filterRows(rows, view.settings?.filter, ctx);
    if (query.trim()) list = searchRows(list, query, ctx);
    return sortRows(list, view.settings?.sorts, ctx);
  }, [db, view, ctx, rows, query]);

  if (isLoading)
    return (
      <div className="flex flex-col gap-2 py-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  if (isError || !db || !view || !ctx) return <p className="py-4 text-[12.5px] text-fg-3">{t("db.loadFailed")}</p>;

  const pick = (id: string) => {
    setLocalView(id);
    onViewChange?.(id);
  };
  const saveView = (next: DbView) => act.saveSchema({ ...db, views: db.views.map((v) => (v.id === next.id ? next : v)) });
  const onSettings = (s: DbViewSettings) => saveView({ ...view, settings: s });
  const onAddOption = (prop: DbProperty, name: string) => {
    const made = withOption(db, prop.id, name);
    void act.saveSchema(made.db);
    return made.option;
  };
  const addView = (type: DbViewType) => {
    const v = defaultView(type, db);
    const named = { ...v, id: newViewId(db), name: t(`db.view.${type}`) };
    void act.saveSchema({ ...db, views: [...db.views, named] });
    pick(named.id);
  };
  const open = (row: DbRow) => (view.settings?.open_in === "page" ? void navigate({ to: "/wiki/$pageId", params: { pageId: row.id } }) : setPeek(row.id));
  const create = async (values?: Record<string, DbValue>, opts?: { title?: string; position?: number }) => {
    setCreating(true);
    const row = await act.createRow({ ...filterDefaults(view.settings?.filter, db), ...values }, opts);
    setCreating(false);
    return row;
  };
  const Layout = LAYOUTS[view.type];
  // A form asks for a new row: no filters, sorts, search or new button around it.
  const isForm = view.type === "form";
  const props: ViewProps = {
    databaseId,
    db,
    view,
    rows: shown,
    allRows: rows,
    props: visibleProps(db, view),
    ctx,
    canEdit,
    sorted: !!view.settings?.sorts?.length,
    onOpen: open,
    onUpdate: (id, values) => void act.updateRow(id, values),
    onRename: (id, name) => void act.renameRow(id, name),
    onCreate: create,
    onTrash: (ids) => void act.trashRows(ids),
    onMove: (id, pos) => void act.moveRow(id, pos),
    onAddOption,
    onSchema: (next) => void act.saveSchema(next),
    onSettings,
  };

  return (
    <div className={cn("wiki-db @container/db min-w-0", inline && "my-2")}>
      {!inline && (
        <DatabaseKeys
          onNewRow={canEdit && !isForm ? async () => {
            const row = await create();
            if (row) open(row);
          } : undefined}
          onView={(by) => {
            const at = db.views.findIndex((v) => v.id === view.id);
            const next = db.views[(at + by + db.views.length) % db.views.length];
            if (next) pick(next.id);
          }}
          onFilter={isForm ? undefined : () => setFilterOpen(true)}
          onSearch={isForm ? undefined : () => setSearching(true)}
        />
      )}
      {inline && page && (
        <div className="group mb-1 flex items-center gap-1.5">
          <PageIcon icon={page.icon} className="size-5 text-[17px]" />
          {canEdit ? (
            <input
              key={page.title}
              defaultValue={page.title}
              placeholder={t("untitled")}
              aria-label={t("db.name")}
              maxLength={200}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name !== page.title) void act.renameRow(page.id, name);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.currentTarget.value = page.title;
                  e.currentTarget.blur();
                }
              }}
              className="field-sizing-content min-w-24 max-w-full rounded-md bg-transparent text-[17px] font-semibold tracking-[-0.01em] text-fg outline-none placeholder:text-fg-4 focus-visible:shadow-none"
            />
          ) : (
            <span className="truncate text-[17px] font-semibold tracking-[-0.01em] text-fg">{title(page.title)}</span>
          )}
          <Tooltip content={t("db.openAsPage")}>
            <button
              type="button"
              aria-label={t("db.openAsPage")}
              onClick={() => void navigate({ to: "/wiki/$pageId", params: { pageId: page.id } })}
              className="flex size-6 items-center justify-center rounded-md text-fg-4 opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
            >
              <ArrowUpRight className="size-3.5" />
            </button>
          </Tooltip>
        </div>
      )}
      <div className="flex items-center gap-2 border-b border-line">
        <div ref={tabsRef} onScroll={fadeTabs} className={cn("flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]", tabsFade)} role="tablist" aria-label={t("db.views")}>
          {db.views.map((v) => (
            <ViewTab key={v.id} v={v} active={v.id === view.id} canEdit={canEdit} onPick={() => pick(v.id)} db={db} onSchema={(next) => void act.saveSchema(next)} onPicked={pick} />
          ))}
          {canEdit && (
            <M.Root>
              <M.Trigger asChild>
                <button type="button" aria-label={t("db.addView")} className="mb-px flex size-7 shrink-0 items-center justify-center rounded-md text-fg-4 hover:bg-hover hover:text-fg">
                  <Plus className="size-3.5" />
                </button>
              </M.Trigger>
              <M.Portal>
                <M.Content align="start" sideOffset={6} className={cn(floatingPanel, "min-w-[200px] p-1")}>
                  <div className="label-caps px-2 pb-1 pt-1.5">{t("db.addView")}</div>
                  {VIEW_TYPES.map((ty) => {
                    const Icon = VIEW_ICONS[ty];
                    return (
                      <M.Item key={ty} className={menuItemCls} onSelect={() => addView(ty)}>
                        <Icon />
                        <span className="flex-1">{t(`db.view.${ty}`)}</span>
                      </M.Item>
                    );
                  })}
                </M.Content>
              </M.Portal>
            </M.Root>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pb-1">
          {!isForm && <FilterMenu db={db} view={view} onChange={onSettings} canEdit={canEdit} open={filterOpen} onOpenChange={setFilterOpen} />}
          {!isForm && <SortMenu db={db} view={view} onChange={onSettings} canEdit={canEdit} />}
          {GROUPED.includes(view.type) && <GroupMenu db={db} view={view} onChange={onSettings} required={view.type === "board"} />}
          {view.type !== "chart" && !isForm && <PropertiesMenu db={db} view={view} onChange={onSettings} />}
          {canEdit && <LayoutMenu db={db} view={view} databaseId={databaseId} onChange={onSettings} onSchema={(next) => void act.saveSchema(next)} />}
          {isForm ? null : searching ? (
            <span className="flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-1.5">
              <Search className="size-3.5 text-fg-4" />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (setQuery(""), setSearching(false))} placeholder={t("db.searchRows")} className="w-32 bg-transparent text-[12.5px] outline-none" />
              <button type="button" aria-label={t("db.closeSearch")} onClick={() => (setQuery(""), setSearching(false))}>
                <X className="size-3.5 text-fg-4 hover:text-fg" />
              </button>
            </span>
          ) : (
            <button type="button" aria-label={t("db.searchRows")} className={toolButton} onClick={() => setSearching(true)}>
              <Search />
            </button>
          )}
          {canEdit && !isForm && (
            <span className="ml-1 flex">
              <Button
                size="sm"
                variant="primary"
                className="rounded-r-none"
                loading={creating}
                onClick={async () => {
                  const row = await create();
                  if (row) open(row);
                }}
              >
                {t("db.new")}
              </Button>
              <M.Root>
                <M.Trigger asChild>
                  <Button size="sm" variant="primary" square aria-label={t("db.newFrom")} className="rounded-l-none border-l border-white/20">
                    <ChevronDown className="size-3.5" />
                  </Button>
                </M.Trigger>
                <M.Portal>
                  <M.Content align="end" sideOffset={6} className={cn(floatingPanel, "min-w-[220px] p-1")}>
                    <div className="label-caps px-2 pb-1 pt-1.5">{t("db.templates")}</div>
                    {templates.map((tpl) => (
                      <M.Item
                        key={tpl.id}
                        className={menuItemCls}
                        onSelect={async () => {
                          const row = await act.createRow(filterDefaults(view.settings?.filter, db), { template: tpl.id, title: title(tpl.title) });
                          if (row) open(row);
                        }}
                      >
                        <PageIcon icon={tpl.icon} />
                        <span className="flex-1 truncate">{title(tpl.title)}</span>
                        <button type="button" onClick={(e) => (e.preventDefault(), e.stopPropagation(), setPeek(tpl.id))} className="text-[11px] text-fg-4 hover:text-fg">
                          {t("templatesPage.edit")}
                        </button>
                      </M.Item>
                    ))}
                    {!templates.length && <p className="px-2 py-1.5 text-[12px] text-fg-4">{t("db.noTemplates")}</p>}
                    <MenuSeparator />
                    <M.Item
                      className={menuItemCls}
                      onSelect={async () => {
                        const tpl = await act.createTemplate();
                        if (tpl) setPeek(tpl);
                      }}
                    >
                      <FilePlus2 />
                      <span className="flex-1">{t("db.newTemplate")}</span>
                    </M.Item>
                  </M.Content>
                </M.Portal>
              </M.Root>
            </span>
          )}
        </div>
      </div>
      <div className="pt-2">
        {!isForm && <ActiveChips db={db} view={view} onChange={onSettings} onOpenFilter={() => setFilterOpen(true)} />}
        <Suspense fallback={<Spinner className="m-4 size-4" />}>
          <Layout {...props} />
        </Suspense>
      </div>
      <RowPeek id={peek} onClose={() => setPeek(null)} />
    </div>
  );
}

function ViewTab({ v, active, canEdit, onPick, db, onSchema, onPicked }: { v: DbView; active: boolean; canEdit: boolean; onPick: () => void; db: Database; onSchema: (db: Database) => void; onPicked: (id: string) => void }) {
  const { t } = useTranslation("wiki");
  const [renaming, setRenaming] = useState(false);
  const Icon = VIEW_ICONS[v.type];
  const save = (next: DbView) => onSchema({ ...db, views: db.views.map((x) => (x.id === v.id ? next : x)) });
  if (renaming)
    return (
      <input
        autoFocus
        defaultValue={v.name}
        onBlur={(e) => {
          const name = e.target.value.trim();
          if (name && name !== v.name) save({ ...v, name });
          setRenaming(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setRenaming(false);
        }}
        className="mb-1 h-7 w-32 rounded-md border border-line px-2 text-[12.5px] outline-none focus:border-fg-3"
      />
    );
  return (
    <span className="group/tab relative flex shrink-0 items-center">
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onPick}
        onDoubleClick={() => canEdit && setRenaming(true)}
        className={cn("flex h-9 items-center gap-1.5 px-2 text-[12.5px] transition-colors", active ? "font-medium text-fg" : "text-fg-3 hover:text-fg")}
      >
        <Icon className="size-3.5" />
        {v.name}
      </button>
      {active && <span className="absolute inset-x-1.5 -bottom-px h-[1.5px] rounded-full bg-fg" />}
      {active && canEdit && (
        <M.Root>
          <M.Trigger asChild>
            <button type="button" aria-label={t("db.viewMenu")} className="-ml-1 mr-0.5 flex size-5 items-center justify-center rounded text-fg-4 opacity-0 hover:bg-hover hover:text-fg group-hover/tab:opacity-100 data-[state=open]:opacity-100">
              <MoreHorizontal className="size-3.5" />
            </button>
          </M.Trigger>
          <M.Portal>
            <M.Content align="start" sideOffset={6} className={cn(floatingPanel, "min-w-[200px] p-1")}>
              <M.Item className={menuItemCls} onSelect={() => setRenaming(true)}>
                <Pencil />
                <span className="flex-1">{t("db.renameView")}</span>
              </M.Item>
              <M.Sub>
                <M.SubTrigger className={menuItemCls}>
                  <Repeat2 />
                  <span className="flex-1">{t("db.layout")}</span>
                </M.SubTrigger>
                <M.Portal>
                  <M.SubContent sideOffset={6} className={cn(floatingPanel, "min-w-[180px] p-1")}>
                    {VIEW_TYPES.map((ty) => {
                      const I = VIEW_ICONS[ty];
                      return (
                        <M.Item key={ty} className={cn(menuItemCls, ty === v.type && "font-medium")} onSelect={() => save({ ...defaultView(ty, db), id: v.id, name: v.name, settings: { ...defaultView(ty, db).settings, filter: v.settings?.filter, sorts: v.settings?.sorts, hidden: v.settings?.hidden, order: v.settings?.order } })}>
                          <I />
                          <span className="flex-1">{t(`db.view.${ty}`)}</span>
                        </M.Item>
                      );
                    })}
                  </M.SubContent>
                </M.Portal>
              </M.Sub>
              <M.Item
                className={menuItemCls}
                onSelect={() => {
                  const copy = { ...v, id: newViewId(db), name: t("db.viewCopy", { name: v.name }) };
                  const i = db.views.findIndex((x) => x.id === v.id);
                  onSchema({ ...db, views: [...db.views.slice(0, i + 1), copy, ...db.views.slice(i + 1)] });
                  onPicked(copy.id);
                }}
              >
                <Copy />
                <span className="flex-1">{t("db.duplicateView")}</span>
              </M.Item>
              {db.views.length > 1 && (
                <>
                  <MenuSeparator />
                  <M.Item
                    className={cn(menuItemCls, "text-danger-fg [&_svg]:text-danger-fg")}
                    onSelect={() => {
                      const rest = db.views.filter((x) => x.id !== v.id);
                      onSchema({ ...db, views: rest });
                      onPicked(rest[0].id);
                    }}
                  >
                    <Trash2 />
                    <span className="flex-1">{t("db.deleteView")}</span>
                  </M.Item>
                </>
              )}
            </M.Content>
          </M.Portal>
        </M.Root>
      )}
    </span>
  );
}

/** A row that scrolls sideways fades at the edges with more beyond them. */
function useEdgeFade() {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = { start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
    setEdges((cur) => (cur.start === next.start && cur.end === next.end ? cur : next));
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update]);
  const fade =
    edges.start && edges.end
      ? "[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]"
      : edges.end
        ? "[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]"
        : edges.start
          ? "[mask-image:linear-gradient(to_right,transparent,black_24px)]"
          : "";
  return { ref, fade, update };
}
