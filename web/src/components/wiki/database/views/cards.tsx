// What the list, board and gallery layouts share: a group's label and heading, the drag that
// moves rows into place and into another group, a card's preview and fields, and the composer
// that adds a row by its name.

import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns";
import { ChevronRight } from "lucide-react";
import { useState, type DragEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@/components/ui/avatar";
import type { DbDate, DbProperty, DbRow, DbValue, DbView, DbViewSettings, Database } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { cellValue, formatCount, isEmpty, NO_VALUE, statusGroupOf, type DbContext, type Group } from "@/lib/wiki/db";
import type { ViewProps } from "../DatabaseView";
import { CellView, OptionPill, readOnly, StatusPill } from "../cells";
import { coverStyle } from "../../covers";

/** The dataTransfer type of a dragged row, as every layout uses it. */
export const ROW_TYPE = "application/x-od-row";

/** The property the view groups by, if it still exists. */
export const groupProp = (db: Database, view: DbView): DbProperty | undefined => (view.settings?.group_by ? db.properties.find((x) => x.id === view.settings!.group_by) : undefined);

/** The settings with a group folded or unfolded. */
export function toggleCollapsed(settings: DbViewSettings | undefined, key: string): DbViewSettings {
  const cur = settings?.collapsed_groups ?? [];
  return { ...settings, collapsed_groups: cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key] };
}

/**
 * The values that put a row in a group: a new row (no `row`) or a row dragged out of group
 * `from`. A multi-select or person keeps its other values and swaps `from` for `to`; the
 * no-value group clears it. Null when a row can't be put there (a computed property).
 */
export function regroup(prop: DbProperty, to: string, row?: DbRow, from?: string): Record<string, DbValue> | null {
  if (readOnly(prop.type)) return null;
  const set = (v: DbValue) => ({ [prop.id]: v });
  if (to === NO_VALUE) return row ? set(null) : {};
  switch (prop.type) {
    case "select":
    case "status":
    case "text":
      return set(to);
    case "multi_select":
    case "person": {
      const cur = row && Array.isArray(row.props[prop.id]) ? (row.props[prop.id] as string[]) : [];
      return set([...cur.filter((x) => x !== from && x !== to), to]);
    }
    case "checkbox":
      return set(to === "true");
    case "number": {
      const n = Number(to);
      return Number.isFinite(n) ? set(n) : null;
    }
    case "date": {
      // The day moves; a time of day and the length of a range stay.
      const old = row?.props[prop.id] as DbDate | undefined;
      if (!old?.start) return set({ start: to });
      const shift = differenceInCalendarDays(parseISO(to), parseISO(old.start));
      const move = (s: string) => (s.length > 10 ? addDays(parseISO(s), shift).toISOString() : format(addDays(parseISO(s), shift), "yyyy-MM-dd"));
      return set({ start: move(old.start), ...(old.end ? { end: move(old.end) } : {}) });
    }
    default:
      return null;
  }
}

/**
 * Where a row dropped at `index` of a group's rows goes among all the rows (the position
 * onMove takes), or null when it stays where it is.
 */
export function dropPosition(allRows: DbRow[], id: string, list: DbRow[], index: number): number | null {
  const rest = allRows.filter((r) => r.id !== id);
  const before = list.slice(index).find((r) => r.id !== id);
  const after = list
    .slice(0, index)
    .reverse()
    .find((r) => r.id !== id);
  const at = before ? rest.findIndex((r) => r.id === before.id) : after ? rest.findIndex((r) => r.id === after.id) + 1 : -1;
  if (at < 0 || at === allRows.findIndex((r) => r.id === id)) return null;
  return at;
}

/** The index a drag over a container's `[data-card]` items points at: by rows, or in reading order for a grid. */
export function indexAt(e: DragEvent<HTMLElement>, grid = false): number {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-card]")];
  const i = items.findIndex((el) => {
    const r = el.getBoundingClientRect();
    return grid ? e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2) : e.clientY < r.top + r.height / 2;
  });
  return i === -1 ? items.length : i;
}

export type RowDrag = ReturnType<typeof useRowDrag>;

/** Dragging rows: into another place (when the view has no sort) and into another group. */
export function useRowDrag(p: ViewProps, prop: DbProperty | undefined) {
  const [drag, setDrag] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<{ group: string; index: number } | null>(null);
  const rowOf = (id: string) => p.allRows.find((r) => r.id === id);
  const accepts = (group: string) => {
    if (!drag) return false;
    if (drag.from === group) return !p.sorted;
    const row = rowOf(drag.id);
    return !!prop && !!row && regroup(prop, group, row, drag.from) !== null;
  };
  const end = () => {
    setDrag(null);
    setOver(null);
  };
  return {
    drag,
    over,
    /** Whether rows can be dragged at all: into place, or into another group. */
    canDrag: p.canEdit && (!p.sorted || (!!prop && !readOnly(prop.type))),
    start: (e: DragEvent, row: DbRow, group: string) => {
      e.dataTransfer.setData(ROW_TYPE, row.id);
      e.dataTransfer.effectAllowed = "move";
      setDrag({ id: row.id, from: group });
    },
    end,
    hover: (e: DragEvent, group: string, index: number) => {
      if (!accepts(group)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (over?.group !== group || over.index !== index) setOver({ group, index });
    },
    leave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
    },
    drop: (e: DragEvent, group: string, list: DbRow[]) => {
      e.preventDefault();
      const d = drag;
      const at = over;
      end();
      const row = d && rowOf(d.id);
      if (!d || !row || !at || at.group !== group) return;
      if (d.from !== group && prop) {
        const values = regroup(prop, group, row, d.from);
        if (values) p.onUpdate(row.id, values);
      }
      if (!p.sorted) {
        const pos = dropPosition(p.allRows, d.id, list, at.index);
        if (pos !== null) p.onMove(d.id, pos);
      }
    },
    /** Where the drop line sits on item `i` of a group's rows: before it, after it (the last), or nowhere. */
    edge: (group: string, list: DbRow[], i: number): "before" | "after" | null => {
      if (!drag || p.sorted || over?.group !== group) return null;
      const line = (at: number) => over.index === at && !(drag.from === group && (list[at]?.id === drag.id || list[at - 1]?.id === drag.id));
      if (line(i)) return "before";
      if (i === list.length - 1 && line(list.length)) return "after";
      return null;
    },
    dragging: (row: DbRow, group: string) => drag?.id === row.id && drag.from === group,
  };
}

/** Opens on Enter or Space when the element itself has focus (not a link inside it). */
export const openKeys = (open: () => void) => (e: KeyboardEvent) => {
  if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  open();
};

/** A group's name as plain text. */
export function useGroupName() {
  const { t } = useTranslation("wiki");
  return (group: Group, prop: DbProperty) => (group.key === NO_VALUE ? t("db.noValue", { name: prop.name }) : prop.type === "checkbox" ? t(group.key === "true" ? "db.checked" : "db.unchecked") : group.label);
}

/** What a card shows above its title: the page's cover, or the start of its text. */
export function CardPreview({ row, preview, fit, className }: { row: DbRow; preview: DbViewSettings["card_preview"]; fit?: boolean; className?: string }) {
  if (preview === "content")
    return (
      <div className={cn("relative overflow-hidden border-b border-line-soft bg-sunken px-3 pt-2.5", className)}>
        {row.excerpt.trim() && <p className="line-clamp-6 whitespace-pre-line text-[11px] leading-[16px] text-fg-3">{row.excerpt}</p>}
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-b from-transparent to-[var(--sunken)]" />
      </div>
    );
  if (preview !== "cover") return null;
  const style = coverStyle(row.cover);
  if (!style) return null;
  return (
    <div className={cn("overflow-hidden border-b border-line-soft bg-sunken", style.background && "wiki-cover-gradient", className)} style={style.background ? { background: style.background } : undefined}>
      {style.image && <img src={style.image} alt="" loading="lazy" draggable={false} className={cn("size-full", fit ? "object-contain" : "object-cover")} style={fit ? undefined : { objectPosition: `center ${row.cover_y}%` }} />}
    </div>
  );
}

const PEOPLE = ["person", "created_by", "edited_by"];

/** A group as its values look in a cell: a pill for an option or status, a person with their avatar. */
export function GroupLabel({ group, prop, ctx }: { group: Group; prop: DbProperty; ctx: DbContext }) {
  const name = useGroupName()(group, prop);
  if (group.key === NO_VALUE) return <span className="truncate text-[12.5px] text-fg-3">{name}</span>;
  if (group.option) return prop.type === "status" ? <StatusPill option={group.option} group={statusGroupOf(prop, group.key) ?? undefined} /> : <OptionPill option={group.option} />;
  if (prop.type === "checkbox")
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-fg">
        <span className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border-[1.5px]", group.key === "true" ? "border-tone-blue-solid bg-tone-blue-solid text-white" : "border-line-strong")}>
          {group.key === "true" && (
            <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
              <path d="M2.5 6.2 5 8.5 9.5 3.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span className="truncate">{name}</span>
      </span>
    );
  if (PEOPLE.includes(prop.type)) {
    const u = ctx.members.get(group.key);
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-fg">
        <Avatar name={u?.name ?? name} src={u?.avatar_url} size="xs" />
        <span className="truncate">{name}</span>
      </span>
    );
  }
  return <span className="truncate text-[12.5px] font-medium text-fg">{name}</span>;
}

/** A group's heading in a list or gallery: folds the group, shows how many rows it has. */
export function GroupHeading({ group, prop, ctx, folded, onFold }: { group: Group; prop: DbProperty; ctx: DbContext; folded: boolean; onFold: () => void }) {
  return (
    <div className="flex h-9 items-center pt-2">
      <button type="button" aria-expanded={!folded} onClick={onFold} className="flex h-7 min-w-0 items-center gap-1.5 rounded-md pl-1 pr-2 transition-colors hover:bg-hover">
        <ChevronRight className={cn("size-3.5 shrink-0 text-fg-3 transition-transform", !folded && "rotate-90")} />
        <GroupLabel group={group} prop={prop} ctx={ctx} />
        <span className="mono text-[11.5px] text-fg-4">{formatCount(group.rows.length)}</span>
      </button>
    </div>
  );
}

/** Adds rows by name: Enter adds one and stays for the next, Escape or leaving empty closes. */
export function Composer({ onSubmit, onClose, className }: { onSubmit: (title: string) => Promise<unknown>; onClose: () => void; className?: string }) {
  const { t } = useTranslation("wiki");
  return (
    <input
      autoFocus
      placeholder={t("db.newRowTitle")}
      onBlur={(e) => {
        const v = e.target.value.trim();
        onClose();
        if (v) void onSubmit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter") {
          const v = e.currentTarget.value.trim();
          if (!v) return;
          e.currentTarget.value = "";
          void onSubmit(v);
        }
      }}
      className={cn("min-w-0 bg-transparent text-[13px] font-medium text-fg outline-none placeholder:font-normal placeholder:text-fg-4", className)}
    />
  );
}

/** The quiet look of property values beside a title: secondary text, numbers where they fall. */
export const quietValues = "[&_.text-fg]:text-fg-2";

const LISTS = ["multi_select", "person", "relation", "files", "ticket"];
const PILLS = ["select", "multi_select", "status"];
/** Values that mean little without their property's name beside them. */
const NAMED = ["number", "rollup", "formula", "checkbox"];

/**
 * The view's properties of a row that have a value, read only: in a row beside a list's
 * title, or down a card with its options as one run of pills. `skip` is a property the
 * card's place already says (a board column's).
 */
export function RowFields({ row, props, ctx, inline, skip }: { row: DbRow; props: DbProperty[]; ctx: DbContext; inline?: boolean; skip?: string }) {
  const shown = props.filter((prop) => prop.type !== "title" && prop.id !== skip && (prop.type === "checkbox" || !isEmpty(cellValue(row, prop, ctx))));
  if (!shown.length) return null;
  const field = (prop: DbProperty) => (
    <span key={prop.id} title={prop.name} className={cn("flex min-h-5 min-w-0 items-center gap-1.5 text-[12.5px]", inline ? "h-5 max-w-[180px] shrink-0" : "[&_.tabular-nums]:w-auto [&_.tabular-nums]:text-left")}>
      {!inline && NAMED.includes(prop.type) && prop.type !== "checkbox" && <span className="shrink-0 text-fg-4">{prop.name}</span>}
      <CellView prop={prop} row={row} ctx={ctx} wrap={!inline && LISTS.includes(prop.type)} />
      {!inline && prop.type === "checkbox" && <span className="truncate text-fg-3">{prop.name}</span>}
    </span>
  );
  // One line: values that don't fit wrap onto a second line that is clipped, so whole values drop off the end.
  if (inline) return <span className={cn(quietValues, "flex h-5 min-w-0 flex-1 flex-wrap items-center justify-end gap-x-3 overflow-hidden")}>{shown.map(field)}</span>;
  const pills = shown.filter((x) => PILLS.includes(x.type));
  return (
    <span className={cn(quietValues, "flex flex-col gap-1")}>
      {shown.map((prop) =>
        !PILLS.includes(prop.type) ? (
          field(prop)
        ) : prop === pills[0] ? (
          <span key="pills" className="flex flex-wrap gap-1">
            {pills.map((x) => (
              <CellView key={x.id} prop={x} row={row} ctx={ctx} wrap />
            ))}
          </span>
        ) : null,
      )}
    </span>
  );
}
