// The help desk in a wiki page (contracts/wiki.md "Desk"): tickets and contacts mentioned
// inline, drawn live for whoever reads the page (a ticket they can't see shows as that,
// never its subject), and the ticket list block, a saved view's tickets kept current by
// realtime as the inbox is.

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { ArrowUpRight, ChevronDown, Layers, Lock, MoreHorizontal } from "lucide-react";
import { HoverCard as H } from "radix-ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StatusIcon, StatusPill, statusLabel } from "@/components/indicators";
import { ViewIcon } from "@/components/tickets/ViewIcon";
import { Avatar } from "@/components/ui/avatar";
import { Menu, MenuChoice, MenuContent, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Picker } from "@/components/ui/picker";
import { floatingPanel } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import type { Ticket, View } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { relLong, relShort } from "@/lib/format";
import { q } from "@/lib/queries";
import { statusTone, toneVar } from "@/lib/tones";
import { useNow } from "@/lib/useNow";
import { blockQuery, cleanLimit, ticketRows, TICKET_LIMITS, type TicketRow } from "@/lib/wiki/desk";

/** A ticket, live: undefined while it loads, null when the reader can't see it (or it is gone). */
export function useLiveTicket(id: string): Ticket | null | undefined {
  const { data, isLoading } = useQuery({ ...q.ticket(id), enabled: !!id, staleTime: 60_000, retry: false });
  if (data) return data;
  // Not found, forbidden and unreadable all read as "a ticket you can't see": nothing of it leaks.
  return id && isLoading ? undefined : null;
}

const ticketTarget = (id: string) => ({ to: "/inbox/$folder/{-$ticketId}" as const, params: { folder: "open", ticketId: id } });

function Ago({ iso, long }: { iso: string; long?: boolean }) {
  const now = useNow();
  return <>{long ? relLong(iso, now) : relShort(iso, now)}</>;
}

/** The ticket as a card while the pointer rests on its chip: status, who has it, when it last moved. */
export function TicketHoverCard({ ticket, children }: { ticket: Ticket; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <H.Root openDelay={350} closeDelay={120} open={open} onOpenChange={setOpen}>
      <H.Trigger asChild>{children}</H.Trigger>
      <H.Portal>
        <H.Content side="bottom" align="start" sideOffset={6} collisionPadding={12} className={cn(floatingPanel, "z-[70] w-[300px] p-3.5")}>
          {open && <TicketCard ticket={ticket} />}
        </H.Content>
      </H.Portal>
    </H.Root>
  );
}

function TicketCard({ ticket }: { ticket: Ticket }) {
  const { t } = useTranslation("wiki");
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="mono text-[11.5px] text-fg-3">#{ticket.number}</span>
        <StatusPill status={ticket.status} />
      </div>
      <p className="line-clamp-2 text-[13.5px] font-medium leading-[19px] text-fg">{ticket.subject}</p>
      <dl className="flex flex-col gap-1.5 text-[12px]">
        <div className="flex items-center gap-2">
          <dt className="w-[72px] shrink-0 text-fg-4">{t("desk.assignee")}</dt>
          <dd className="flex min-w-0 items-center gap-1.5 text-fg-2">
            {ticket.assignee ? (
              <>
                <Avatar name={ticket.assignee.name} src={ticket.assignee.avatar_url} size="xs" />
                <span className="truncate">{ticket.assignee.name}</span>
              </>
            ) : (
              <span className="text-fg-4">{t("desk.unassigned")}</span>
            )}
          </dd>
        </div>
        {ticket.contact && (
          <div className="flex items-center gap-2">
            <dt className="w-[72px] shrink-0 text-fg-4">{t("desk.customer")}</dt>
            <dd className="truncate text-fg-2">{ticket.contact.name || ticket.contact.email}</dd>
          </div>
        )}
        <div className="flex items-center gap-2">
          <dt className="w-[72px] shrink-0 text-fg-4">{t("desk.updated")}</dt>
          <dd className="text-fg-2">
            <Ago iso={ticket.updated_at} long />
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** The ticket's status as a small dot in its tone. */
function StatusDot({ ticket }: { ticket: Ticket }) {
  return <span className="wiki-ticket-dot" style={{ background: toneVar(statusTone[ticket.status]) }} role="img" aria-label={statusLabel(ticket.status)} />;
}

// ─── Inline mentions ────────────────────────────────────────────────────────

export function TicketMentionView({ node }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const id = node.attrs.id as string;
  const number = node.attrs.number as number;
  const ticket = useLiveTicket(id);
  return (
    <NodeViewWrapper as="span" className="wiki-desk-wrap">
      {ticket ? (
        <TicketHoverCard ticket={ticket}>
          <Link {...ticketTarget(ticket.id)} contentEditable={false} draggable={false} className="wiki-ticket">
            <StatusDot ticket={ticket} />
            <span className="wiki-ticket-num">#{ticket.number}</span>
            <span className="wiki-ticket-subject">{ticket.subject}</span>
          </Link>
        </TicketHoverCard>
      ) : ticket === undefined ? (
        <span contentEditable={false} className="wiki-ticket is-loading">
          <span className="wiki-ticket-num">#{number || "…"}</span>
        </span>
      ) : (
        <span contentEditable={false} className="wiki-ticket is-hidden">
          <Lock aria-hidden className="wiki-ticket-lock" />
          {t("desk.hiddenTicket")}
        </span>
      )}
    </NodeViewWrapper>
  );
}

export function ContactMentionView({ node }: NodeViewProps) {
  const id = node.attrs.id as string;
  const { data } = useQuery({ ...q.contact(id), enabled: !!id, staleTime: 60_000, retry: false });
  const name = data?.name || data?.email || (node.attrs.label as string) || "?";
  return (
    <NodeViewWrapper as="span" className="wiki-desk-wrap">
      <Link to="/contacts/{-$contactId}" params={{ contactId: id }} contentEditable={false} draggable={false} className="wiki-contact">
        <Avatar name={name} src={data?.avatar_url} size="xs" className="wiki-contact-avatar" />
        <span>{name}</span>
      </Link>
    </NodeViewWrapper>
  );
}

/** One ticket as a line of a list (the page panel's "Tickets"), live. */
export function TicketLine({ id }: { id: string }) {
  const { t } = useTranslation("wiki");
  const ticket = useLiveTicket(id);
  if (ticket === undefined) return <Skeleton className="mx-2 my-2 h-4 w-3/4" />;
  if (!ticket)
    return (
      <p className="flex h-8 items-center gap-2 px-2 text-[12.5px] text-fg-4">
        <Lock className="size-3.5" />
        {t("desk.hiddenTicket")}
      </p>
    );
  return (
    <TicketHoverCard ticket={ticket}>
      <Link {...ticketTarget(ticket.id)} className="flex h-8 items-center gap-2 rounded-lg px-2 text-[12.5px] text-fg-2 transition-colors hover:bg-hover hover:text-fg">
        <StatusIcon status={ticket.status} />
        <span className="mono shrink-0 text-[11.5px] text-fg-4">#{ticket.number}</span>
        <span className="truncate">{ticket.subject}</span>
      </Link>
    </TicketHoverCard>
  );
}

// ─── The ticket list block ──────────────────────────────────────────────────

/** "/tickets" inserts an empty block; its view picker opens at once. */
let pickNext = false;
export const openViewPickerNext = () => {
  pickNext = true;
};
const takePick = () => {
  const on = pickNext;
  pickNext = false;
  return on;
};

export function TicketsBlockView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { t } = useTranslation("wiki");
  const id = node.attrs.id as string;
  const limit = cleanLimit(node.attrs.limit);
  const editable = editor.isEditable;
  const views = useQuery(q.views());
  const view = views.data?.find((v) => v.id === id);
  const [picking, setPicking] = useState(() => !id && editable && takePick());

  const picker = (trigger: ReactNode) => (
    <Picker
      items={(views.data ?? []).map((v) => ({ value: v.id, label: v.name, icon: <ViewIcon icon={v.icon} /> }))}
      value={id || null}
      onSelect={(v) => updateAttributes({ id: v })}
      placeholder={t("desk.pickView")}
      emptyText={t("desk.noViews")}
      width={300}
      open={picking}
      onOpenChange={setPicking}
      trigger={trigger}
    />
  );
  const ring = selected && "shadow-[0_0_0_2px_var(--focus)]";

  if (!id || (!view && !views.isLoading))
    return (
      <NodeViewWrapper>
        <div contentEditable={false} className={cn("my-1 rounded-lg", ring)}>
          {editable ? (
            picker(
              <button type="button" className="flex h-11 w-full items-center gap-2.5 rounded-lg bg-hover px-3 text-left text-[13px] text-fg-3 transition-colors hover:bg-active hover:text-fg-2">
                <Layers className="size-4" />
                {id ? t("desk.viewGone") : t("desk.pickView")}
              </button>,
            )
          ) : id ? (
            <p className="flex h-9 items-center gap-2 px-1 text-[13px] text-fg-4">
              <Layers className="size-4" />
              {t("desk.viewGoneReader")}
            </p>
          ) : null}
        </div>
      </NodeViewWrapper>
    );

  return (
    <NodeViewWrapper>
      <div contentEditable={false} className={cn("wiki-tickets my-2 overflow-hidden rounded-lg border border-line bg-surface", ring)}>
        <div className="flex h-10 items-center gap-1.5 border-b border-line-soft pl-2 pr-1.5">
          {view && editable ? (
            picker(
              <button type="button" className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-hover">
                <ViewIcon icon={view.icon} />
                <span className="truncate">{view.name}</span>
                <ChevronDown className="size-3 shrink-0 text-fg-4" />
              </button>,
            )
          ) : view ? (
            <span className="flex min-w-0 items-center gap-1.5 px-1.5 text-[13px] font-medium text-fg">
              <ViewIcon icon={view.icon} />
              <span className="truncate">{view.name}</span>
            </span>
          ) : (
            <Skeleton className="ml-1.5 h-4 w-32" />
          )}
          <span className="flex-1" />
          {view && (
            <Link
              to="/views/$viewId/{-$ticketId}"
              params={{ viewId: view.id, ticketId: undefined }}
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
            >
              {t("desk.openView")}
              <ArrowUpRight className="size-3" />
            </Link>
          )}
          {editable && (
            <Menu modal={false}>
              <Tooltip content={t("desk.blockOptions")}>
                <MenuTrigger asChild>
                  <button type="button" aria-label={t("desk.blockOptions")} className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover">
                    <MoreHorizontal className="size-4" />
                  </button>
                </MenuTrigger>
              </Tooltip>
              <MenuContent align="end">
                <MenuLabel>{t("desk.show")}</MenuLabel>
                {TICKET_LIMITS.map((n) => (
                  <MenuChoice key={n} checked={limit === n} onSelect={() => updateAttributes({ limit: n })}>
                    {t("desk.limit", { count: n })}
                  </MenuChoice>
                ))}
              </MenuContent>
            </Menu>
          )}
        </div>
        {view ? <BlockRows view={view} limit={limit} /> : <RowsLoading rows={3} />}
      </div>
    </NodeViewWrapper>
  );
}

function RowsLoading({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: `${82 - i * 14}%` }} />
      ))}
    </div>
  );
}

function BlockRows({ view, limit }: { view: View; limit: number }) {
  const { t } = useTranslation("wiki");
  const list = useInfiniteQuery(q.tickets(blockQuery(view)));
  if (list.isLoading) return <RowsLoading rows={Math.min(limit, 3)} />;
  if (list.isError) return <p className="px-3 py-3 text-[12.5px] text-fg-4">{t("desk.listFailed")}</p>;
  const { rows, more } = ticketRows(list.data?.pages, limit);
  if (!rows.length) return <p className="px-3 py-3 text-[12.5px] text-fg-4">{t("desk.listEmpty")}</p>;
  return (
    <>
      <ul role="list">
        {rows.map((r) => (
          <BlockRow key={r.id} row={r} viewId={view.id} />
        ))}
      </ul>
      {more && (
        <Link
          to="/views/$viewId/{-$ticketId}"
          params={{ viewId: view.id, ticketId: undefined }}
          className="flex h-8 items-center px-3 text-[12px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          {t("desk.seeAll")}
        </Link>
      )}
    </>
  );
}

function BlockRow({ row, viewId }: { row: TicketRow; viewId: string }) {
  const { t } = useTranslation("wiki");
  return (
    <li className="border-b border-line-soft last:border-b-0">
      <Link
        to="/views/$viewId/{-$ticketId}"
        params={{ viewId, ticketId: row.id }}
        className="flex h-9 items-center gap-2.5 px-3 text-[13px] transition-colors hover:bg-hover"
      >
        <span className="mono w-12 shrink-0 text-[11.5px] text-fg-4">#{row.number}</span>
        <span className="min-w-0 flex-1 truncate text-fg">{row.subject}</span>
        <StatusPill status={row.status} className="hidden sm:inline-flex" />
        <span className="flex w-5 shrink-0 justify-center">
          {row.assignee ? (
            <Tooltip content={row.assignee.name}>
              <span>
                <Avatar name={row.assignee.name} src={row.assignee.avatar_url} size="xs" />
              </span>
            </Tooltip>
          ) : (
            <Tooltip content={t("desk.unassigned")}>
              <span aria-label={t("desk.unassigned")} className="size-4 rounded-full border border-dashed border-line-strong" />
            </Tooltip>
          )}
        </span>
        <span className="w-12 shrink-0 text-right text-[11.5px] tabular-nums text-fg-4">
          <Ago iso={row.updatedAt} />
        </span>
      </Link>
    </li>
  );
}
