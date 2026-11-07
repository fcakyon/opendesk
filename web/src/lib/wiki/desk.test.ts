import { describe, expect, it } from "vitest";
import type { Ticket } from "../api/types";
import { blockQuery, cleanLimit, parseTicketLink, parseTicketQuery, ticketRows, ticketsForNumber, UNSOLVED } from "./desk";

const ticket = (n: number, over: Partial<Ticket> = {}) =>
  ({ id: `t${n}`, number: n, subject: `Subject ${n}`, status: "open", assignee: null, updated_at: `2026-11-0${(n % 9) + 1}T00:00:00Z`, ...over }) as Ticket;

describe("what # asks for", () => {
  it("reads a ticket number, with or without its #", () => {
    expect(parseTicketQuery("123")).toEqual({ kind: "number", number: 123, digits: "123" });
    expect(parseTicketQuery("#123")).toEqual({ kind: "number", number: 123, digits: "123" });
    expect(parseTicketQuery(" 0042 ")).toEqual({ kind: "number", number: 42, digits: "42" });
  });
  it("searches by words, and a tag-like word is words", () => {
    expect(parseTicketQuery("refund")).toEqual({ kind: "text", text: "refund" });
    expect(parseTicketQuery("123abc")).toEqual({ kind: "text", text: "123abc" });
  });
  it("asks for nothing yet without a query or with ticket 0", () => {
    expect(parseTicketQuery("")).toEqual({ kind: "empty" });
    expect(parseTicketQuery("#")).toEqual({ kind: "empty" });
    expect(parseTicketQuery("0")).toEqual({ kind: "empty" });
  });
  it("puts the exact ticket first, then those whose number starts with the digits", () => {
    const found = [ticket(1230), ticket(77), ticket(123), ticket(1239)];
    expect(ticketsForNumber("123", ticket(123), found).map((t) => t.number)).toEqual([123, 1230, 1239]);
    expect(ticketsForNumber("123", null, found).map((t) => t.number)).toEqual([1230, 123, 1239]);
    expect(ticketsForNumber("1", null, [ticket(1), ticket(10), ticket(11)], 2)).toHaveLength(2);
  });
});

describe("a ticket mention's stored text", () => {
  it("reads the number from the link and the subject from the text", () => {
    expect(parseTicketLink("/tickets/1072", "#1072 Refund for a paid subscriber")).toEqual({ number: 1072, label: "Refund for a paid subscriber" });
  });
  it("falls back to the text's number, and keeps a bare label", () => {
    expect(parseTicketLink("https://evil.example/tickets/5", "#5  Two  spaces ")).toEqual({ number: 5, label: "Two spaces" });
    expect(parseTicketLink(null, "No number")).toEqual({ number: 0, label: "No number" });
  });
});

describe("the ticket list block", () => {
  it("shows the view's open tickets, unless the view names its own statuses", () => {
    expect(blockQuery({ id: "v1", filters: {} })).toEqual({ view_id: "v1", status: UNSOLVED });
    expect(blockQuery({ id: "v2", filters: { status: ["solved"] } })).toEqual({ view_id: "v2" });
  });
  it("keeps the limits it knows and falls back to five", () => {
    expect([cleanLimit("10"), cleanLimit(25), cleanLimit("7"), cleanLimit(null)]).toEqual([10, 25, 5, 5]);
  });
  it("maps loaded pages to rows, each ticket once, up to the limit", () => {
    const me = { id: "u1", name: "Lea", email: "lea@example.com", avatar_url: null };
    const pages = [{ data: [ticket(1, { assignee: me }), ticket(2)], next_cursor: null }, { data: [ticket(2), ticket(3)], next_cursor: null }];
    const { rows, more } = ticketRows(pages, 2);
    expect(rows).toEqual([
      { id: "t1", number: 1, subject: "Subject 1", status: "open", assignee: me, updatedAt: "2026-11-02T00:00:00Z" },
      { id: "t2", number: 2, subject: "Subject 2", status: "open", assignee: null, updatedAt: "2026-11-03T00:00:00Z" },
    ]);
    expect(more).toBe(true);
    expect(ticketRows(pages, 5)).toMatchObject({ more: false });
    expect(ticketRows([{ data: [ticket(1)], next_cursor: "50" }], 5)).toMatchObject({ more: true });
    expect(ticketRows(undefined, 5)).toEqual({ rows: [], more: false });
  });
});
