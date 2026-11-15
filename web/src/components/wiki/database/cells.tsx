// What each property type looks like: its icon, how a value shows in a cell (pills for
// options, avatars for people, chips for pages and tickets), and its editor. Editors open
// in a popover from the cell; a checkbox ticks in place. Computed values read only.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRight,
  AtSign,
  Calendar as CalendarIcon,
  CircleDot,
  Clock,
  Fingerprint,
  FunctionSquare,
  Hash,
  Link2,
  List,
  Paperclip,
  Phone,
  Search,
  SquareCheck,
  Text,
  Ticket,
  Type,
  UserCog,
  UserRound,
  Users,
  X,
  CircleChevronDown,
  History,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@/components/ui/avatar";
import { Calendar, formatDay, parseDay } from "@/components/ui/date-picker";
import { Picker, type PickerItem } from "@/components/ui/picker";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import type { Database, DbDate, DbFile, DbOption, DbProperty, DbPropType, DbRow, DbTone, DbValue } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { cellText, cellValue, isEmpty, newOptionId, pairChoices, pairsOf, TONE_ORDER, type DbContext } from "@/lib/wiki/db";
import { PageIcon } from "../PageTree";

export const PROP_ICONS: Record<DbPropType, typeof Type> = {
  title: Type,
  text: Text,
  number: Hash,
  select: CircleChevronDown,
  multi_select: List,
  status: CircleDot,
  date: CalendarIcon,
  person: Users,
  checkbox: SquareCheck,
  url: Link2,
  email: AtSign,
  phone: Phone,
  files: Paperclip,
  relation: ArrowUpRight,
  rollup: Search,
  formula: FunctionSquare,
  created_time: Clock,
  created_by: UserRound,
  edited_time: History,
  edited_by: UserCog,
  unique_id: Fingerprint,
  ticket: Ticket,
};

export function PropIcon({ type, className }: { type: DbPropType; className?: string }) {
  const Icon = PROP_ICONS[type];
  return <Icon className={cn("size-3.5 shrink-0 text-fg-3", className)} aria-hidden />;
}

/** An option as a soft pill in its tone. */
export function OptionPill({ option, className, onRemove }: { option: Pick<DbOption, "name" | "color">; className?: string; onRemove?: () => void }) {
  return (
    <span className={cn("inline-flex h-5 max-w-full shrink-0 items-center gap-0.5 rounded-[4px] px-1.5 text-[12px] leading-none", `db-tone-${option.color}`, className)}>
      <span className="truncate">{option.name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} className="-mr-0.5 flex size-3.5 items-center justify-center rounded-sm opacity-60 hover:opacity-100" aria-label="×">
          <X className="size-2.5" />
        </button>
      )}
    </span>
  );
}

/** A status: a dot that fills as the work moves (to do, in progress, done), then its name. */
export function StatusPill({ option, group }: { option: Pick<DbOption, "name" | "color">; group?: "todo" | "doing" | "done" }) {
  return (
    <span className={cn("inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 rounded-full pl-1.5 pr-2 text-[12px] leading-none", `db-tone-${option.color}`)}>
      <span className={cn("size-2 shrink-0 rounded-full border-[1.5px] border-current", group === "doing" && "bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]", group === "done" && "bg-current")} />
      <span className="truncate">{option.name}</span>
    </span>
  );
}

function PageChip({ id, title, icon }: { id: string; title: string; icon: string }) {
  return (
    <Link to="/wiki/$pageId" params={{ pageId: id }} onClick={(e) => e.stopPropagation()} className="inline-flex h-5 max-w-full items-center gap-1 rounded-[4px] px-1 text-[12.5px] text-fg underline decoration-line-strong underline-offset-[3px] hover:bg-hover">
      <PageIcon icon={icon} className="size-3.5 text-[12px]" />
      <span className="truncate">{title}</span>
    </Link>
  );
}

function TicketChip({ id }: { id: string }) {
  const { data } = useQuery({ ...q.ticket(id), staleTime: 60_000, retry: false });
  if (!data) return <span className="inline-flex h-5 w-14 animate-pulse rounded-[4px] bg-hover" />;
  return (
    <Link
      to="/inbox/$folder/{-$ticketId}"
      params={{ folder: "open", ticketId: data.id }}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex h-5 max-w-full items-center gap-1 rounded-[4px] bg-hover px-1.5 text-[12px] text-fg-2 hover:text-fg"
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", data.status === "solved" || data.status === "closed" ? "bg-tone-green-solid" : data.status === "pending" ? "bg-tone-amber-solid" : "bg-tone-blue-solid")} />
      <span className="mono shrink-0 text-fg-3">#{data.number}</span>
      <span className="truncate">{data.subject}</span>
    </Link>
  );
}

/** A value as a cell shows it, read only. `wrap` lets long text and many pills wrap. */
/** `column`: in a table column, where numbers line up on the right. */
export function CellView({ prop, row, ctx, wrap, column }: { prop: DbProperty; row: DbRow; ctx: DbContext; wrap?: boolean; column?: boolean }) {
  const { t } = useTranslation("wiki");
  const v = cellValue(row, prop, ctx);
  if (isEmpty(v) && prop.type !== "checkbox") return null;
  const flow = cn("flex min-w-0 gap-1", wrap ? "flex-wrap" : "overflow-hidden");
  switch (prop.type) {
    case "select":
    case "multi_select": {
      const ids = Array.isArray(v) ? (v as string[]) : [v as string];
      return (
        <span className={flow}>
          {ids.map((id) => {
            const o = prop.options?.find((x) => x.id === id);
            return o ? <OptionPill key={id} option={o} /> : null;
          })}
        </span>
      );
    }
    case "status": {
      const o = prop.options?.find((x) => x.id === v);
      const g = prop.groups?.find((x) => x.option_ids.includes(String(v)))?.id;
      return o ? <StatusPill option={o} group={g} /> : null;
    }
    case "checkbox":
      return <CheckMark checked={v === true} />;
    case "person":
    case "created_by":
    case "edited_by":
      return (
        <span className={flow}>
          {(v as string[]).map((id) => {
            const u = ctx.members.get(id);
            return (
              <span key={id} className="inline-flex h-5 min-w-0 items-center gap-1 text-[12.5px] text-fg">
                <Avatar name={u?.name ?? "?"} src={u?.avatar_url} size="xs" />
                <span className="truncate">{u?.name ?? t("db.someone")}</span>
              </span>
            );
          })}
        </span>
      );
    case "relation": {
      const target = ctx.rowsByDb.get(prop.database_id ?? "") ?? [];
      return (
        <span className={flow}>
          {(v as string[]).map((id) => {
            const r = target.find((x) => x.id === id);
            return r ? <PageChip key={id} id={id} title={r.title.trim() || t("untitled")} icon={r.icon} /> : null;
          })}
        </span>
      );
    }
    case "ticket":
      return (
        <span className={flow}>
          {(v as string[]).map((id) => (
            <TicketChip key={id} id={id} />
          ))}
        </span>
      );
    case "files":
      return (
        <span className={flow}>
          {(v as DbFile[]).map((f) => (
            <a key={f.url} href={f.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex h-5 max-w-[160px] items-center gap-1 rounded-[4px] bg-hover px-1.5 text-[12px] text-fg-2 hover:text-fg">
              <Paperclip className="size-3 shrink-0" />
              <span className="truncate">{f.name}</span>
            </a>
          ))}
        </span>
      );
    case "url":
    case "email":
    case "phone": {
      const s = String(v);
      const href = prop.type === "email" ? `mailto:${s}` : prop.type === "phone" ? `tel:${s}` : s;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => e.stopPropagation()} className={cn("text-[13px] text-fg underline decoration-line-strong underline-offset-[3px] hover:decoration-fg", !wrap && "truncate")}>
          {prop.type === "url" ? s.replace(/^https?:\/\/(www\.)?/, "") : s}
        </a>
      );
    }
    case "number":
      return <span className={cn("block w-full truncate tabular-nums text-[13px] text-fg", column && "text-right")}>{cellText(v, prop, ctx)}</span>;
    default: {
      const text = cellText(v, prop, ctx);
      if (typeof v === "object" && v && "error" in (v as object)) return <span className="text-[12px] text-danger-fg">{text}</span>;
      return <span className={cn("text-[13px] text-fg", wrap ? "whitespace-pre-wrap break-words" : "truncate")}>{text}</span>;
    }
  }
}

export function CheckMark({ checked, onToggle, disabled }: { checked: boolean; onToggle?: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled || !onToggle}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border-[1.5px] transition-colors disabled:cursor-default",
        checked ? "border-tone-blue-solid bg-tone-blue-solid text-white" : "border-line-strong bg-surface hover:border-fg-3",
      )}
    >
      {checked && (
        <svg viewBox="0 0 12 12" className="size-2.5 animate-check-pop" aria-hidden>
          <path d="M2.5 6.2 5 8.5 9.5 3.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

// ─── Editors ─────────────────────────────────────────────────────────────────

export type EditorProps = {
  prop: DbProperty;
  row: DbRow;
  ctx: DbContext;
  /** Saves the value (null clears it). */
  onChange: (value: DbValue) => void;
  /** Adds an option to the property (select, multi-select, status) and resolves to it. */
  onAddOption: (prop: DbProperty, name: string) => DbOption;
  onClose: () => void;
};

/** Whether a property is edited in place (no popover) or not at all. */
export const editsInPlace = (t: DbPropType) => t === "checkbox";
export const readOnly = (t: DbPropType) => ["rollup", "formula", "created_time", "created_by", "edited_time", "edited_by", "unique_id"].includes(t);

export function CellEditor(props: EditorProps) {
  switch (props.prop.type) {
    case "text":
    case "url":
    case "email":
    case "phone":
    case "number":
      return <TextEditor {...props} />;
    case "date":
      return <DateEditor {...props} />;
    case "files":
      return <FilesEditor {...props} />;
    default:
      return null;
  }
}

function TextEditor({ prop, row, onChange, onClose }: EditorProps) {
  const { t } = useTranslation("wiki");
  const start = row.props[prop.id];
  const [v, setV] = useState(start === undefined || start === null ? "" : String(start));
  const commit = () => {
    const s = v.trim();
    if (prop.type === "number") {
      const n = s === "" ? null : Number(s.replace(",", "."));
      if (n !== null && !Number.isFinite(n)) return toast.error(t("db.notNumber"));
      if (n !== start) onChange(n);
    } else if (s !== (start ?? "")) onChange(s === "" ? null : s);
    onClose();
  };
  const multi = prop.type === "text";
  const cls = "w-full resize-none bg-transparent px-2.5 py-2 text-[13px] text-fg outline-none placeholder:text-fg-4";
  return multi ? (
    <textarea
      autoFocus
      value={v}
      rows={Math.min(8, Math.max(2, v.split("\n").length))}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") onClose();
      }}
      placeholder={t("db.empty")}
      className={cls}
    />
  ) : (
    <input
      autoFocus
      value={v}
      inputMode={prop.type === "number" ? "decimal" : prop.type === "phone" ? "tel" : prop.type === "email" ? "email" : "url"}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") onClose();
      }}
      placeholder={prop.type === "url" ? "https://" : t("db.empty")}
      className={cn(cls, "h-9")}
    />
  );
}

function DateEditor({ prop, row, onChange, onClose }: EditorProps) {
  const { t } = useTranslation("wiki");
  const cur = row.props[prop.id] as DbDate | undefined;
  const [range, setRange] = useState(!!cur?.end);
  const [edge, setEdge] = useState<"start" | "end">("start");
  const startDay = parseDay(cur?.start?.slice(0, 10) ?? null);
  const endDay = parseDay(cur?.end?.slice(0, 10) ?? null);
  const time = (s?: string) => (s && s.length > 10 ? s.slice(11, 16) : "");
  const [startTime, setStartTime] = useState(time(cur?.start));
  const at = (day: string, hhmm: string) => (prop.date_time && hhmm ? new Date(`${day}T${hhmm}`).toISOString() : day);
  const save = (next: DbDate | null) => onChange(next);
  return (
    <div className="w-[260px] p-2">
      <div className="mb-2 flex gap-1">
        <button type="button" onClick={() => setEdge("start")} className={cn("h-7 flex-1 rounded-md border px-2 text-left text-[12px]", edge === "start" ? "border-fg-3 text-fg" : "border-line text-fg-3")}>
          {cur?.start ? cur.start.slice(0, 10) : t("db.start")}
        </button>
        {range && (
          <button type="button" onClick={() => setEdge("end")} className={cn("h-7 flex-1 rounded-md border px-2 text-left text-[12px]", edge === "end" ? "border-fg-3 text-fg" : "border-line text-fg-3")}>
            {cur?.end ? cur.end.slice(0, 10) : t("db.end")}
          </button>
        )}
      </div>
      <Calendar
        value={edge === "start" ? startDay : endDay}
        onChange={(d) => {
          const day = formatDay(d);
          if (edge === "start") {
            save({ start: at(day, startTime), ...(range && cur?.end ? { end: cur.end } : {}) });
            if (range) setEdge("end");
            else onClose();
          } else if (cur?.start) {
            const [a, b] = [cur.start.slice(0, 10), day].sort();
            save({ start: a === cur.start.slice(0, 10) ? cur.start : a, end: b });
            onClose();
          }
        }}
      />
      <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-2">
        <label className="flex items-center justify-between text-[12.5px] text-fg-2">
          {t("db.endDate")}
          <Switch
            checked={range}
            onCheckedChange={(v) => {
              setRange(v);
              if (!v && cur?.end) save({ start: cur.start });
              if (v) setEdge("end");
            }}
          />
        </label>
        {prop.date_time && (
          <label className="flex items-center justify-between text-[12.5px] text-fg-2">
            {t("db.time")}
            <input
              type="time"
              value={startTime}
              onChange={(e) => {
                setStartTime(e.target.value);
                if (cur?.start) save({ start: at(cur.start.slice(0, 10), e.target.value), ...(cur.end ? { end: cur.end } : {}) });
              }}
              className="h-7 rounded-md border border-line bg-surface px-1.5 text-[12px]"
            />
          </label>
        )}
        {cur && (
          <button type="button" onClick={() => (save(null), onClose())} className="h-7 rounded-md text-left text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg">
            {t("db.clear")}
          </button>
        )}
      </div>
    </div>
  );
}

function FilesEditor({ prop, row, onChange }: EditorProps) {
  const { t } = useTranslation("wiki");
  const files = (row.props[prop.id] as DbFile[] | undefined) ?? [];
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="w-[280px] p-1.5">
      {files.map((f, i) => (
        <div key={f.url} className="group flex h-8 items-center gap-2 rounded-md px-2 text-[12.5px] hover:bg-hover">
          <Paperclip className="size-3.5 text-fg-3" />
          <a href={f.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-fg hover:underline">
            {f.name}
          </a>
          <button type="button" aria-label={t("db.removeFile")} onClick={() => onChange(files.filter((_, j) => j !== i))} className="opacity-0 group-hover:opacity-100">
            <X className="size-3.5 text-fg-3 hover:text-fg" />
          </button>
        </div>
      ))}
      <input
        ref={input}
        type="file"
        hidden
        multiple
        onChange={async (e) => {
          const list = [...(e.target.files ?? [])];
          e.target.value = "";
          if (!list.length) return;
          setBusy(true);
          try {
            const up = await Promise.all(list.map((f) => api.attachments.upload(f)));
            onChange([...files, ...up.map((a) => ({ url: a.url, name: a.filename }))]);
          } catch (err) {
            toast.error(err, t("page.uploadFailed"));
          } finally {
            setBusy(false);
          }
        }}
      />
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg">
        {busy ? <Spinner className="size-3.5" /> : <Paperclip className="size-3.5" />}
        {t("db.addFile")}
      </button>
    </div>
  );
}

// ─── Pickers (select, multi-select, status, person, relation, ticket) ────────

export const pickerTypes: DbPropType[] = ["select", "multi_select", "status", "person", "relation", "ticket"];

/** The picker for a property that picks from a list, opened by trigger. */
export function ValuePicker({ prop, row, ctx, onChange, onAddOption, trigger, open, onOpenChange }: Omit<EditorProps, "onClose"> & { trigger: ReactNode; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation("wiki");
  const [ticketQuery, setTicketQuery] = useState("");
  const search = q.search(ticketQuery);
  const tickets = useQuery({ ...search, enabled: prop.type === "ticket" && open && search.enabled !== false });
  const cur = row.props[prop.id];
  // A paired relation (sub-items, dependencies) never names its own row or loops; a parent item is one row.
  const pair = prop.type === "relation" ? pairsOf(ctx.db).get(prop.id) : undefined;
  const multi = prop.type === "multi_select" || prop.type === "person" || (prop.type === "relation" && !pair?.single) || prop.type === "ticket";
  let items: PickerItem[] = [];
  if (prop.type === "select" || prop.type === "multi_select") items = (prop.options ?? []).map((o) => ({ value: o.id, label: o.name, icon: <span className={cn("size-2.5 rounded-full", `db-dot-${o.color}`)} /> }));
  if (prop.type === "status") {
    const groups = prop.groups ?? [];
    items = (prop.options ?? []).map((o) => {
      const g = groups.find((x) => x.option_ids.includes(o.id))?.id;
      return { value: o.id, label: o.name, group: g ? t(`db.statusGroup.${g}`) : undefined, icon: <span className={cn("size-2.5 rounded-full", `db-dot-${o.color}`)} /> };
    });
  }
  if (prop.type === "person") items = [...ctx.members.values()].map((u) => ({ value: u.id, label: u.name, keywords: [u.email], icon: <Avatar name={u.name} src={u.avatar_url} size="xs" /> }));
  if (prop.type === "relation") {
    const target = ctx.rowsByDb.get(prop.database_id ?? "") ?? [];
    items = (pair ? pairChoices(ctx.db, target, row.id, prop.id) : target).map((r) => ({ value: r.id, label: r.title.trim() || t("untitled"), icon: <PageIcon icon={r.icon} /> }));
  }
  if (prop.type === "ticket") {
    const found = tickets.data?.tickets ?? [];
    const chosen = (Array.isArray(cur) ? (cur as string[]) : []).map((id) => ({ value: id, label: `#…`, hint: <TicketChip id={id} /> }));
    items = [...chosen, ...found.filter((x) => !chosen.some((c) => c.value === x.id)).map((x) => ({ value: x.id, label: `#${x.number} ${x.subject}`, icon: <Ticket /> }))];
  }
  const values = Array.isArray(cur) ? (cur as string[]) : cur ? [String(cur)] : [];
  const canCreate = prop.type === "select" || prop.type === "multi_select" || prop.type === "status";
  const create = canCreate
    ? (name: string) => {
        const o = onAddOption(prop, name);
        onChange(prop.type === "multi_select" ? [...values, o.id] : o.id);
        if (prop.type !== "multi_select") onOpenChange(false);
      }
    : undefined;
  const common = {
    trigger,
    items,
    open,
    onOpenChange,
    width: 260,
    placeholder: prop.type === "ticket" ? t("db.searchTickets") : canCreate ? t("db.searchOrCreate") : t("db.search"),
    onCreate: create,
    createLabel: t("db.createOption"),
    onQueryChange: prop.type === "ticket" ? setTicketQuery : undefined,
  };
  return multi ? <Picker {...common} multi values={values} onChange={(v) => onChange(v.length ? v : null)} /> : <Picker {...common} value={values[0] ?? null} onSelect={(v) => onChange(v === values[0] ? null : prop.type === "relation" ? [v] : v)} />;
}

/** A new option for a property, in the next tone. */
export function withOption(db: Database, propId: string, name: string): { db: Database; option: DbOption } {
  const prop = db.properties.find((p) => p.id === propId)!;
  const used = (prop.options ?? []).length;
  const option: DbOption = { id: newOptionId(prop), name: name.trim(), color: TONE_ORDER[used % TONE_ORDER.length] as DbTone };
  const next: Database = {
    ...db,
    properties: db.properties.map((p) => {
      if (p.id !== propId) return p;
      const options = [...(p.options ?? []), option];
      // A new status lands in To do, where new work starts.
      const groups = p.type === "status" ? (p.groups ?? [{ id: "todo", option_ids: [] }]).map((g) => (g.id === "todo" ? { ...g, option_ids: [...g.option_ids, option.id] } : g)) : p.groups;
      return { ...p, options, groups };
    }),
  };
  return { db: next, option };
}
