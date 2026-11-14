// The calendar layout: a month of weeks with each row on the day its date property names,
// ranges as bars across the days they cover, up to three a day and the rest behind "+N more".
// Rows are dragged to another day (Alt and an arrow key moves the focused one), a day's "+"
// adds a row on it, and rows without a date wait in a list that can be dragged from too.

import { addDays, addMonths, isSameDay, isSameMonth, startOfDay, startOfMonth } from "date-fns";
import { CalendarOff, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import type { DbRow } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { clock } from "@/lib/format";
import { cellValue, isDateRange } from "@/lib/wiki/db";
import type { ViewProps } from "../DatabaseView";
import { NeedsDate } from "./NeedsDate";
import { ROW_TYPE } from "./cards";
import { PageIcon } from "../../PageTree";
import { dayKey, daysBetween, editableDate, editDates, formatIn, layoutWeek, monthGrid, spanOf, toneOf, weekdays, type DaySpan } from "./time";

/** Bars a day shows before "+N more". */
const LANES = 3;
const HEAD_H = 30;
const BAR_H = 22;
const BAR_GAP = 3;
const WEEK_H = HEAD_H + LANES * (BAR_H + BAR_GAP) + 24;

type Item = { row: DbRow; span: DaySpan; time: Date | null };

export default function CalendarView(p: ViewProps) {
  const { t, i18n } = useTranslation("wiki");
  const lang = i18n.resolvedLanguage ?? "en";
  const { db, view, rows, ctx, canEdit } = p;
  const [month, setMonth] = useState(() => startOfMonth(ctx.now));
  const [over, setOver] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  /** The row being dragged and the day it was picked up by (null from the no-date list). */
  const drag = useRef<{ id: string; grab: Date | null } | null>(null);
  const dateProp = db.properties.find((x) => x.id === view.settings?.date_property);

  const { items, undated } = useMemo(() => {
    const items: Item[] = [];
    const undated: DbRow[] = [];
    if (!dateProp) return { items, undated };
    for (const row of rows) {
      const v = cellValue(row, dateProp, ctx);
      const span = spanOf(v);
      if (!span) undated.push(row);
      else items.push({ row, span, time: isDateRange(v) && v.time ? v.start : null });
    }
    return { items, undated };
  }, [rows, dateProp, ctx]);

  if (!dateProp) return <NeedsDate p={p} />;

  const editable = canEdit && editableDate(dateProp);
  const today = startOfDay(ctx.now);
  const weeks = monthGrid(month);
  const byId = new Map(items.map((it) => [it.row.id, it]));

  const move = (row: DbRow, days: number) => {
    const values = editDates(row.props, dateProp.id, undefined, "move", days);
    if (values) p.onUpdate(row.id, values);
  };
  const dropOn = (day: Date) => {
    const d = drag.current;
    drag.current = null;
    setOver(null);
    if (!d) return;
    if (d.grab) {
      const row = byId.get(d.id)?.row;
      if (row) move(row, daysBetween(d.grab, day));
    } else p.onUpdate(d.id, { [dateProp.id]: { start: dayKey(day) } });
  };
  const addOn = async (day: Date) => {
    const row = await p.onCreate({ [dateProp.id]: { start: dayKey(day) } });
    if (row) p.onOpen(row);
  };
  // Alt and an arrow moves the focused row a day or a week, and says where it went.
  const keyMove = (e: KeyboardEvent, it: Item) => {
    if (!editable || !e.altKey) return;
    const days = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!days) return;
    e.preventDefault();
    move(it.row, days);
    const to = addDays(it.span.start, days);
    if (!isSameMonth(to, month)) setMonth(startOfMonth(to));
    setSaid(t("db.calendarView.moveTo", { date: formatIn(lang, to, { dateStyle: "full" }) }));
  };
  const chip = (it: Item, bar?: { cutStart: boolean; cutEnd: boolean; grab: (e: DragEvent) => Date }) => (
    <Chip
      key={it.row.id}
      item={it}
      tone={toneOf(it.row, db, ctx)}
      untitled={t("untitled")}
      draggable={editable}
      cutStart={bar?.cutStart}
      cutEnd={bar?.cutEnd}
      onOpen={() => p.onOpen(it.row)}
      onKeyDown={(e) => keyMove(e, it)}
      onDragStart={(e) => {
        e.dataTransfer.setData(ROW_TYPE, it.row.id);
        e.dataTransfer.effectAllowed = "move";
        drag.current = { id: it.row.id, grab: bar ? bar.grab(e) : it.span.start };
      }}
      onDragEnd={() => ((drag.current = null), setOver(null))}
    />
  );

  return (
    <div className="pb-2 text-[13px]">
      <div className="flex h-9 items-center gap-1">
        <h3 className="flex-1 truncate pl-0.5 text-[14px] font-semibold tracking-[-0.01em] text-fg">{formatIn(lang, month, { month: "long", year: "numeric" })}</h3>
        {undated.length > 0 && (
          <Popover
            align="end"
            className="w-[260px] p-1"
            trigger={
              <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover">
                <CalendarOff className="size-3.5" />
                {t("db.noDate")}
                <span className="mono text-[11.5px] text-fg-4">{undated.length}</span>
              </button>
            }
          >
            <p className="px-2 pb-1.5 pt-1 text-[12px] text-fg-3">{t("db.noDateHint", { name: dateProp.name })}</p>
            <div className="flex max-h-[300px] flex-col gap-px overflow-y-auto">
              {undated.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  draggable={editable}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(ROW_TYPE, row.id);
                    e.dataTransfer.effectAllowed = "move";
                    drag.current = { id: row.id, grab: null };
                  }}
                  onClick={() => p.onOpen(row)}
                  className={cn("flex h-8 items-center gap-1.5 rounded-md px-2 text-left text-[13px] text-fg outline-none transition-colors hover:bg-hover focus-visible:bg-hover", editable && "cursor-grab active:cursor-grabbing")}
                >
                  <PageIcon icon={row.icon} />
                  <span className="truncate">{row.title.trim() || <span className="text-fg-4">{t("untitled")}</span>}</span>
                </button>
              ))}
            </div>
          </Popover>
        )}
        <Button size="sm" variant="ghost" onClick={() => setMonth(startOfMonth(ctx.now))}>
          {t("db.today")}
        </Button>
        <span className="flex">
          <Button size="sm" variant="ghost" square aria-label={t("db.previous")} onClick={() => setMonth((m) => addMonths(m, -1))}>
            <ChevronLeft />
          </Button>
          <Button size="sm" variant="ghost" square aria-label={t("db.next")} onClick={() => setMonth((m) => addMonths(m, 1))}>
            <ChevronRight />
          </Button>
        </span>
      </div>

      <div className="mt-1 overflow-hidden rounded-md border border-line" role="grid" aria-label={formatIn(lang, month, { month: "long", year: "numeric" })}>
        <div role="row" className="grid grid-cols-7 border-b border-line bg-sunken">
          {weekdays().map((d) => (
            <span key={d.getDay()} role="columnheader" className="h-7 truncate px-2 text-[11.5px] font-medium leading-7 text-fg-3">
              {formatIn(lang, d, { weekday: "short" })}
            </span>
          ))}
        </div>
        {weeks.map((week) => {
          const { bars, hidden, byDay } = layoutWeek(
            week,
            items.map((it) => ({ id: it.row.id, span: it.span })),
            LANES,
          );
          const colAt = (e: DragEvent) => {
            const r = e.currentTarget.getBoundingClientRect();
            return Math.min(6, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 7)));
          };
          return (
            <div
              key={dayKey(week[0])}
              role="row"
              className="relative grid grid-cols-7 border-b border-line-soft last:border-b-0"
              style={{ height: WEEK_H }}
              onDragOver={(e) => {
                if (!editable || !drag.current) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const k = dayKey(week[colAt(e)]);
                if (k !== over) setOver(k);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(e) => {
                if (!drag.current) return;
                e.preventDefault();
                dropOn(week[colAt(e)]);
              }}
            >
              {week.map((day, col) => (
                <Day
                  key={dayKey(day)}
                  day={day}
                  lang={lang}
                  outside={!isSameMonth(day, month)}
                  today={isSameDay(day, today)}
                  over={over === dayKey(day)}
                  onAdd={editable ? () => void addOn(day) : undefined}
                  more={
                    hidden[col] > 0 ? (
                      <Popover
                        align="start"
                        sideOffset={-HEAD_H + 2}
                        className="w-[240px] p-1.5"
                        trigger={
                          <button type="button" className="h-5 rounded px-1.5 text-[11.5px] font-medium text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover">
                            {t("db.more", { count: hidden[col] })}
                          </button>
                        }
                      >
                        <div className="px-1 pb-1.5 text-[12px] font-medium text-fg-2">{formatIn(lang, day, { weekday: "long", day: "numeric", month: "long" })}</div>
                        <div className="flex max-h-[320px] flex-col gap-1 overflow-y-auto">{byDay[col].map((id) => chip(byId.get(id)!))}</div>
                      </Popover>
                    ) : null
                  }
                />
              ))}
              {bars.map((b) => (
                <div
                  key={b.id}
                  className="absolute px-1"
                  style={{ top: HEAD_H + b.lane * (BAR_H + BAR_GAP), left: `${(b.col / 7) * 100}%`, width: `${(b.len / 7) * 100}%`, height: BAR_H }}
                >
                  {chip(byId.get(b.id)!, {
                    cutStart: b.cutStart,
                    cutEnd: b.cutEnd,
                    grab: (e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      return week[b.col + Math.min(b.len - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * b.len)))];
                    },
                  })}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {said}
      </span>
    </div>
  );
}

function Day({ day, lang, outside, today, over, onAdd, more }: { day: Date; lang: string; outside: boolean; today: boolean; over: boolean; onAdd?: () => void; more: React.ReactNode }) {
  const { t } = useTranslation("wiki");
  const first = day.getDate() === 1;
  return (
    <div
      role="gridcell"
      aria-label={formatIn(lang, day, { dateStyle: "full" })}
      className={cn("group/day relative border-r border-line-soft transition-colors duration-100 last:border-r-0 motion-reduce:transition-none", outside && "bg-sunken", over && "bg-tone-blue-soft")}
    >
      <div className="flex h-[30px] items-center gap-1 px-1.5">
        <span
          className={cn(
            "mono flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11.5px] tabular-nums",
            today ? "bg-fg font-semibold text-surface" : outside ? "text-fg-4" : "text-fg-2",
          )}
        >
          {first ? formatIn(lang, day, { day: "numeric", month: "short" }) : day.getDate()}
        </span>
        {onAdd && (
          <button
            type="button"
            aria-label={t("db.calendarView.addOn", { date: formatIn(lang, day, { dateStyle: "long" }) })}
            onClick={onAdd}
            className="ml-auto flex size-5 items-center justify-center rounded text-fg-3 opacity-0 outline-none transition-opacity duration-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/day:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </div>
      {more && <div className="absolute inset-x-1 bottom-1">{more}</div>}
    </div>
  );
}

function Chip({
  item,
  tone,
  untitled,
  draggable,
  cutStart,
  cutEnd,
  onOpen,
  onKeyDown,
  onDragStart,
  onDragEnd,
}: {
  item: Item;
  tone?: string;
  untitled: string;
  draggable: boolean;
  cutStart?: boolean;
  cutEnd?: boolean;
  onOpen: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { row, time } = item;
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className={cn(
        "flex h-[22px] w-full min-w-0 items-center gap-1.5 rounded-[4px] border border-line bg-surface px-1.5 text-left text-[12px] text-fg shadow-xs outline-none transition-[background-color,box-shadow] duration-100 hover:bg-hover focus-visible:shadow-[0_0_0_2px_var(--focus)] motion-reduce:transition-none",
        draggable && "cursor-grab active:cursor-grabbing",
        cutStart && "rounded-l-none border-l-0",
        cutEnd && "rounded-r-none border-r-0",
      )}
    >
      {tone && <span className={cn("size-1.5 shrink-0 rounded-full", `db-dot-${tone}`)} aria-hidden />}
      {row.icon && <PageIcon icon={row.icon} className="size-3.5 text-[11px]" />}
      <span className="min-w-0 flex-1 truncate font-medium">{row.title.trim() || <span className="font-normal text-fg-4">{untitled}</span>}</span>
      {time && <span className="mono shrink-0 text-[10.5px] text-fg-4">{clock(time.toISOString())}</span>}
    </button>
  );
}
