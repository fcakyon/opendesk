// The help desk inside the wiki (contracts/wiki.md "Desk"): what "#" typed in a page
// asks for, how a ticket mention reads back from its HTML, and which tickets a ticket
// list block shows. Pure, so the editor, the panel and the tests share one reading.

import type { TicketListQuery } from "../api/endpoints";
import type { Ticket, TicketStatus, UserRef, View } from "../api/types";

/** How many tickets a ticket list block shows (data-limit). */
export const TICKET_LIMITS = [5, 10, 25] as const;
export type TicketLimit = (typeof TICKET_LIMITS)[number];

export function cleanLimit(v: unknown): TicketLimit {
  const n = Number(v);
  return (TICKET_LIMITS as readonly number[]).includes(n) ? (n as TicketLimit) : 5;
}

/** What follows "#": nothing yet, a ticket number ("#123"), or words to search tickets by. */
export type TicketQuery = { kind: "empty" } | { kind: "number"; number: number; digits: string } | { kind: "text"; text: string };

export function parseTicketQuery(raw: string): TicketQuery {
  const q = raw.trim().replace(/^#/, "");
  if (!q) return { kind: "empty" };
  if (/^\d{1,9}$/.test(q)) {
    const n = Number(q);
    return n > 0 ? { kind: "number", number: n, digits: String(n) } : { kind: "empty" };
  }
  return { kind: "text", text: q };
}

/** Tickets found for a number: the exact one first, then those whose number starts with it. */
export function ticketsForNumber(digits: string, exact: Ticket | null, found: Ticket[], max = 6): Ticket[] {
  const out: Ticket[] = exact ? [exact] : [];
  for (const t of found) {
    if (out.length >= max) break;
    if (String(t.number).startsWith(digits) && !out.some((x) => x.id === t.id)) out.push(t);
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | null | undefined): v is string => !!v && UUID.test(v);

/**
 * A ticket mention's number and subject as stored: `<a data-type="ticket" href="/tickets/123">#123 Subject</a>`.
 * The text is a fallback for readers of the HTML; the app shows the ticket live.
 */
export function parseTicketLink(href: string | null, text: string | null): { number: number; label: string } {
  const fromHref = /^\/tickets\/(\d{1,9})$/.exec(href ?? "")?.[1];
  const m = /^\s*#(\d{1,9})\s*(.*)$/s.exec(text ?? "");
  const number = Number(fromHref ?? m?.[1] ?? 0);
  const label = (m ? m[2] : (text ?? "")).replace(/\s+/g, " ").trim().slice(0, 200);
  return { number, label };
}

/** Not solved or closed: what a ticket list block shows when its view names no status. */
export const UNSOLVED: TicketStatus[] = ["open", "pending", "on_hold"];

/**
 * The list a ticket list block reads: the view's own tickets, as its inbox lists them (the same
 * query, so the two share a cache and realtime keeps both current). A view that names no status
 * shows the tickets still open; one that does keeps its own.
 */
export function blockQuery(view: Pick<View, "id" | "filters">): TicketListQuery {
  return view.filters.status?.length ? { view_id: view.id } : { view_id: view.id, status: UNSOLVED };
}

export type TicketRow = { id: string; number: number; subject: string; status: TicketStatus; assignee: UserRef | null; updatedAt: string };

/** The block's rows: the first `limit` tickets loaded, each once, and whether the view holds more. */
export function ticketRows(pages: { data: Ticket[]; next_cursor?: string | null }[] | undefined, limit: number): { rows: TicketRow[]; more: boolean } {
  const seen = new Set<string>();
  const all: Ticket[] = [];
  for (const p of pages ?? [])
    for (const t of p.data) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      all.push(t);
    }
  const rows = all.slice(0, limit).map<TicketRow>((t) => ({ id: t.id, number: t.number, subject: t.subject, status: t.status, assignee: t.assignee, updatedAt: t.updated_at }));
  const last = pages?.[pages.length - 1];
  return { rows, more: all.length > limit || !!last?.next_cursor };
}
