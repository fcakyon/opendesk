// The table layout: a column per property (resized and reordered by dragging, each with its
// menu), a row per page with its title opening it beside the database, cells edited in place,
// rows dragged into order when the view has no sort, picked to delete together, grouped when
// the view groups, sub-items nested under their parent item, and a calculation under each
// column (count, sum, average…).

import { ChevronRight, GripVertical, Maximize2, Plus, Trash2, X } from "lucide-react";
import { DropdownMenu as M } from "radix-ui";
import { Fragment, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { menuItemCls } from "@/components/ui/menu";
import { floatingPanel } from "@/components/ui/popover";
import type { DbCalc, DbProperty, DbRow, DbValue } from "@/lib/api/types";
import type { FlatRow } from "@/lib/wiki/db";
import { cn } from "@/lib/cn";
import { addProperty, calculate, CALCS_FOR, groupRows, type Group } from "@/lib/wiki/db";
import type { ViewProps } from "../DatabaseView";
import { Composer, ROW_TYPE } from "./cards";
import { AddSubItem, Disclosure, INDENT, useNesting, type Nesting } from "./nesting";
import { Cell } from "../Cell";
import { OptionPill, PropIcon, StatusPill } from "../cells";
import { PropertyMenu } from "../PropertyMenu";
import { PageIcon } from "../../PageTree";

const TITLE_W = 280;
const CELL_W = 180;
const SELECT_W = 32;

export default function TableView(p: ViewProps) {
  const { t } = useTranslation("wiki");
  const { db, view, props, rows, canEdit, onSettings } = p;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragCol, setDragCol] = useState<string | null>(null);
  const nest = useNesting(p);
  const widths = view.settings?.widths ?? {};
  const width = (prop: DbProperty) => widths[prop.id] ?? (prop.type === "title" ? TITLE_W : CELL_W);
  const cols = `${SELECT_W}px ${props.map((x) => `${width(x)}px`).join(" ")} minmax(80px,1fr)`;
  const groupBy = view.settings?.group_by ? db.properties.find((x) => x.id === view.settings!.group_by) : undefined;
  const groups: Group[] | null = groupBy ? groupRows(rows, groupBy.id, p.ctx, view.settings) : null;
  const collapsed = new Set(view.settings?.collapsed_groups ?? []);

  const resize = (prop: DbProperty, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const w0 = width(prop);
    let w = w0;
    const head = (e.currentTarget as HTMLElement).closest("[data-table]") as HTMLElement | null;
    const move = (ev: PointerEvent) => {
      w = Math.max(80, Math.min(800, w0 + ev.clientX - start));
      head?.style.setProperty("--cols", `${SELECT_W}px ${props.map((x) => `${x.id === prop.id ? w : width(x)}px`).join(" ")} minmax(80px,1fr)`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (w !== w0) onSettings({ ...view.settings, widths: { ...widths, [prop.id]: w } });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const order = props.map((x) => x.id);
  const dropCol = (target: string) => {
    if (!dragCol || dragCol === target || target === "title") return;
    const next = order.filter((x) => x !== dragCol);
    next.splice(next.indexOf(target), 0, dragCol);
    onSettings({ ...view.settings, order: next });
  };

  const toggleSelect = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const allIds = rows.map((r) => r.id);

  const body = (list: DbRow[], groupValue?: Record<string, DbValue>) => (
    <>
      {nest.lines(list).map((l, i) =>
        l.kind === "row" ? (
          <TableRow key={l.line.row.id} row={l.line.row} line={l.line} nest={nest} index={i} p={p} cols={cols} selected={selected.has(l.line.row.id)} onSelect={() => toggleSelect(l.line.row.id)} />
        ) : (
          <div key={`add-${l.parentId}`} className="flex h-9 items-center border-b border-line-soft pr-2" style={{ paddingLeft: SELECT_W + 8 + l.depth * INDENT + 26 }}>
            <Composer className="h-7 flex-1" onClose={nest.stopAdding} onSubmit={(title) => nest.create(l.parentId, title, groupValue)} />
          </div>
        ),
      )}
      {canEdit && <NewRow p={p} values={groupValue} />}
    </>
  );

  return (
    <div className="relative">
      {selected.size > 0 && (
        <div className="absolute -top-1 left-8 z-20 flex h-8 items-center gap-1 rounded-lg border border-line bg-raised px-1.5 shadow-pop animate-pop-in">
          <span className="px-1.5 text-[12.5px] text-fg-2">{t("db.selected", { count: selected.size })}</span>
          {canEdit && (
            <button type="button" onClick={() => (p.onTrash([...selected]), setSelected(new Set()))} className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-danger-fg hover:bg-hover">
              <Trash2 className="size-3.5" />
              {t("db.delete")}
            </button>
          )}
          <button type="button" aria-label={t("db.clearSelection")} onClick={() => setSelected(new Set())} className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-hover">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className="overflow-x-auto pb-2">
        <div data-table role="grid" aria-rowcount={rows.length + 1} className="min-w-max text-[13px]" style={{ "--cols": cols } as CSSProperties}>
          <div role="row" className="sticky top-0 z-10 grid border-y border-line bg-surface text-fg-3" style={{ gridTemplateColumns: "var(--cols)" }}>
            <span className="flex items-center justify-center">
              <SelectBox checked={selected.size > 0 && selected.size === allIds.length} partial={selected.size > 0 && selected.size < allIds.length} onChange={(on) => setSelected(on ? new Set(allIds) : new Set())} label={t("db.selectAll")} />
            </span>
            {props.map((prop) => (
              <div
                key={prop.id}
                role="columnheader"
                draggable={canEdit && prop.type !== "title"}
                onDragStart={() => setDragCol(prop.id)}
                onDragEnd={() => setDragCol(null)}
                onDragOver={(e) => dragCol && e.preventDefault()}
                onDrop={() => dropCol(prop.id)}
                className={cn("relative flex h-8 min-w-0 items-center border-l border-line-soft first-of-type:border-l-0", dragCol === prop.id && "opacity-40")}
              >
                <PropertyMenu
                  db={db}
                  prop={prop}
                  view={view}
                  canEdit={canEdit}
                  onSave={p.onSchema}
                  onSort={(dir) => onSettings({ ...view.settings, sorts: [{ property: prop.id, dir }] })}
                  onFilter={() => onSettings({ ...view.settings, filter: { op: view.settings?.filter?.op ?? "and", rules: [...(view.settings?.filter?.rules ?? []), { property: prop.id, op: "is_not_empty" }] } })}
                  onHide={() => onSettings({ ...view.settings, hidden: [...(view.settings?.hidden ?? []), prop.id] })}
                  onInsert={(side, id) => {
                    const next = order.filter((x) => x !== id);
                    const at = next.indexOf(prop.id) + (side === "right" ? 1 : 0);
                    next.splice(Math.max(1, at), 0, id);
                    onSettings({ ...view.settings, order: next });
                  }}
                  trigger={
                    <button type="button" className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-[12.5px] font-medium transition-colors hover:bg-hover hover:text-fg-2">
                      <PropIcon type={prop.type} />
                      <span className="truncate">{prop.name}</span>
                    </button>
                  }
                />
                {canEdit && <span onPointerDown={(e) => resize(prop, e)} className="absolute -right-[3px] top-0 z-10 h-full w-[6px] cursor-col-resize hover:bg-tone-blue-solid/40" aria-hidden />}
              </div>
            ))}
            {canEdit ? (
              <button
                type="button"
                aria-label={t("db.addProperty")}
                onClick={() => p.onSchema(addProperty(db, "text", t("db.prop.newName")).db)}
                className="flex h-8 items-center border-l border-line-soft px-2 text-fg-4 transition-colors hover:bg-hover hover:text-fg"
              >
                <Plus className="size-3.5" />
              </button>
            ) : (
              <span />
            )}
          </div>
          {groups
            ? groups.map((g) => (
                <Fragment key={g.key}>
                  <GroupHeader
                    group={g}
                    prop={groupBy!}
                    folded={collapsed.has(g.key)}
                    onFold={() => onSettings({ ...view.settings, collapsed_groups: collapsed.has(g.key) ? [...collapsed].filter((x) => x !== g.key) : [...collapsed, g.key] })}
                  />
                  {!collapsed.has(g.key) && body(g.rows, groupValue(groupBy!, g))}
                </Fragment>
              ))
            : body(rows)}
          <Calculations p={p} cols={cols} />
        </div>
      </div>
    </div>
  );
}

/** The value a new row in a group starts with, so it lands in that group. */
export function groupValue(prop: DbProperty, g: Group): Record<string, DbValue> | undefined {
  if (g.empty || g.key === "__none__") return undefined;
  switch (prop.type) {
    case "select":
    case "status":
      return { [prop.id]: g.key };
    case "multi_select":
    case "person":
      return { [prop.id]: [g.key] };
    case "checkbox":
      return { [prop.id]: g.key === "true" };
    default:
      return undefined;
  }
}

function GroupHeader({ group, prop, folded, onFold }: { group: Group; prop: DbProperty; folded: boolean; onFold: () => void }) {
  const { t } = useTranslation("wiki");
  const label =
    group.key === "__none__" ? (
      <span className="text-[12.5px] text-fg-3">{t("db.noValue", { name: prop.name })}</span>
    ) : group.option && prop.type === "status" ? (
      <StatusPill option={group.option} group={prop.groups?.find((g) => g.option_ids.includes(group.key))?.id} />
    ) : group.option ? (
      <OptionPill option={group.option} />
    ) : (
      <span className="text-[12.5px] font-medium text-fg">{group.label}</span>
    );
  return (
    <div className="sticky left-0 flex h-9 items-center gap-1.5 px-1 pt-2">
      <button type="button" aria-expanded={!folded} onClick={onFold} className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-hover">
        <ChevronRight className={cn("size-3.5 transition-transform", !folded && "rotate-90")} />
      </button>
      {label}
      <span className="mono text-[11.5px] text-fg-4">{group.rows.length}</span>
    </div>
  );
}

function SelectBox({ checked, partial, onChange, label }: { checked: boolean; partial?: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={partial ? "mixed" : checked}
      aria-label={label}
      onClick={(e) => (e.stopPropagation(), onChange(!checked))}
      className={cn(
        "flex size-3.5 items-center justify-center rounded-[3px] border transition-colors",
        checked || partial ? "border-tone-blue-solid bg-tone-blue-solid text-white" : "border-line-strong opacity-0 group-hover/row:opacity-100 group-hover/head:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
      )}
    >
      {checked && (
        <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
          <path d="M2.5 6.2 5 8.5 9.5 3.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {partial && !checked && <span className="h-[1.5px] w-2 bg-current" />}
    </button>
  );
}

function TableRow({ row, line, nest, index, p, cols, selected, onSelect }: { row: DbRow; line: FlatRow; nest: Nesting; index: number; p: ViewProps; cols: string; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation("wiki");
  const [editing, setEditing] = useState(false);
  const [dragOver, setDragOver] = useState<"above" | "below" | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const draggable = p.canEdit && !p.sorted;
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-level={nest.on ? line.depth + 1 : undefined}
      onDragOver={(e) => {
        if (!draggable || !e.dataTransfer.types.includes(ROW_TYPE)) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setDragOver(e.clientY < r.top + r.height / 2 ? "above" : "below");
      }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(ROW_TYPE);
        setDragOver(null);
        if (!id || id === row.id) return;
        const at = p.allRows.findIndex((x) => x.id === row.id) + (dragOver === "below" ? 1 : 0);
        const from = p.allRows.findIndex((x) => x.id === id);
        p.onMove(id, from < at ? at - 1 : at);
      }}
      className={cn(
        "group/row relative grid border-b border-line-soft transition-colors hover:bg-[color-mix(in_srgb,var(--hover)_60%,transparent)]",
        selected && "bg-tone-blue-soft hover:bg-tone-blue-soft",
        dragOver === "above" && "shadow-[inset_0_2px_0_var(--tone-blue-solid)]",
        dragOver === "below" && "shadow-[inset_0_-2px_0_var(--tone-blue-solid)]",
      )}
      style={{ gridTemplateColumns: "var(--cols, " + cols + ")" }}
    >
      <span className="flex items-center justify-center gap-0.5">
        {draggable && (
          <span
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(ROW_TYPE, row.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            className="absolute -left-5 flex h-full w-5 cursor-grab items-center justify-center text-fg-4 opacity-0 group-hover/row:opacity-100"
            aria-hidden
          >
            <GripVertical className="size-3.5" />
          </span>
        )}
        <SelectBox checked={selected} onChange={onSelect} label={t("db.selectRow")} />
      </span>
      {p.props.map((prop) =>
        prop.type === "title" ? (
          <div key={prop.id} role="gridcell" className="group/title relative flex h-9 min-w-0 items-center gap-1.5 border-l border-line-soft px-2 first-of-type:border-l-0" style={nest.on ? { paddingLeft: 4 + line.depth * INDENT } : undefined}>
            {nest.on && <Disclosure line={line} onToggle={() => nest.toggle(row.id)} />}
            <PageIcon icon={row.icon} />
            {editing ? (
              <input
                ref={titleRef}
                autoFocus
                defaultValue={row.title}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== row.title) p.onRename(row.id, v);
                  setEditing(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setEditing(false);
                }}
                className="h-7 min-w-0 flex-1 rounded bg-surface px-1 text-[13px] font-medium text-fg outline-none shadow-[0_0_0_2px_var(--focus)]"
              />
            ) : (
              <button type="button" onClick={() => p.onOpen(row)} onDoubleClick={() => p.canEdit && setEditing(true)} className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-fg underline-offset-[3px] hover:underline">
                {row.title.trim() || <span className="text-fg-4">{t("untitled")}</span>}
              </button>
            )}
            {!editing && (
              <span className="absolute right-1.5 flex items-center gap-1">
                {nest.on && p.canEdit && <AddSubItem group="title" onAdd={() => nest.addUnder(row.id)} />}
                <button
                  type="button"
                  onClick={() => p.onOpen(row)}
                  className="flex h-6 items-center gap-1 rounded-md border border-line bg-surface px-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-3 opacity-0 shadow-xs transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/title:opacity-100"
                >
                  <Maximize2 className="size-3" />
                  {t("db.open")}
                </button>
              </span>
            )}
          </div>
        ) : (
          <div key={prop.id} role="gridcell" className="flex h-9 min-w-0 items-stretch border-l border-line-soft">
            <Cell prop={prop} row={row} ctx={p.ctx} canEdit={p.canEdit} onChange={(v) => p.onUpdate(row.id, { [prop.id]: v })} onAddOption={p.onAddOption} />
          </div>
        ),
      )}
      <span className="border-l border-line-soft" />
    </div>
  );
}

function NewRow({ p, values }: { p: ViewProps; values?: Record<string, DbValue> }) {
  const { t } = useTranslation("wiki");
  const [typing, setTyping] = useState(false);
  if (typing)
    return (
      <div className="flex h-9 items-center gap-1.5 border-b border-line-soft pl-10 pr-2">
        <input
          autoFocus
          placeholder={t("db.newRowTitle")}
          onBlur={async (e) => {
            const v = e.target.value.trim();
            setTyping(false);
            if (v) await p.onCreate(values, { title: v });
          }}
          onKeyDown={async (e) => {
            if (e.key === "Escape") setTyping(false);
            if (e.key === "Enter") {
              const v = e.currentTarget.value.trim();
              if (!v) return;
              e.currentTarget.value = "";
              await p.onCreate(values, { title: v });
            }
          }}
          className="h-7 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-fg outline-none placeholder:text-fg-4"
        />
      </div>
    );
  return (
    <button type="button" onClick={() => setTyping(true)} className="flex h-9 w-full items-center gap-1.5 border-b border-line-soft pl-9 text-[13px] text-fg-4 transition-colors hover:bg-hover hover:text-fg-2">
      <Plus className="size-3.5" />
      {t("db.new")}
    </button>
  );
}

function Calculations({ p, cols }: { p: ViewProps; cols: string }) {
  const { t } = useTranslation("wiki");
  const calcs = p.view.settings?.calculations ?? {};
  return (
    <div className="grid" style={{ gridTemplateColumns: "var(--cols, " + cols + ")" }}>
      <span />
      {p.props.map((prop) => {
        const calc = calcs[prop.id] ?? "none";
        const value = calc !== "none" ? calculate(p.rows, prop, calc, p.ctx) : "";
        return (
          <M.Root key={prop.id}>
            <M.Trigger asChild>
              <button type="button" className="group/calc flex h-8 min-w-0 items-center justify-end gap-1 px-2 text-[11.5px] text-fg-4 transition-colors hover:bg-hover hover:text-fg-2">
                {calc === "none" ? (
                  <span className="opacity-0 group-hover/calc:opacity-100">{t("db.calculate")}</span>
                ) : (
                  <>
                    <span className="uppercase tracking-wide">{t(`db.calc.${calc}`)}</span>
                    <span className="font-medium text-fg-2">{value}</span>
                  </>
                )}
              </button>
            </M.Trigger>
            <M.Portal>
              <M.Content align="end" side="top" sideOffset={4} className={cn(floatingPanel, "max-h-[320px] min-w-[180px] overflow-y-auto p-1")}>
                {(["none", ...(CALCS_FOR[prop.type] ?? [])] as DbCalc[]).map((c) => (
                  <M.Item key={c} className={cn(menuItemCls, c === calc && "font-medium")} onSelect={() => p.onSettings({ ...p.view.settings, calculations: { ...calcs, [prop.id]: c } })}>
                    <span className="flex-1">{t(`db.calc.${c}`)}</span>
                  </M.Item>
                ))}
              </M.Content>
            </M.Portal>
          </M.Root>
        );
      })}
      <span />
    </div>
  );
}
