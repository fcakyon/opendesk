import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { Mailbox, Ticket, Widget } from "@/lib/api/types";
import { followUpMailbox, type TeamsCtx } from "../teams";
import { NoFollowUpSender } from "./NoFollowUpSender";

const mailbox = (over: Partial<Mailbox>): Mailbox =>
  ({ id: "mb-1", brand_id: "brand-1", team_id: null, private: false, status: "active", created_at: "2026-01-01T00:00:00Z", ...over }) as Mailbox;

const chat = (over: Partial<Ticket> = {}): Ticket =>
  ({
    id: "t-1",
    channel: "chat",
    brand_id: "brand-1",
    team_id: null,
    mailbox_id: null,
    widget_id: "w-1",
    contact: { id: "c-1", email: "vera@example.com", name: "Vera", avatar_url: null },
    ...over,
  }) as Ticket;

function ctx(mailboxes: Mailbox[], widgets: Widget[] = []): TeamsCtx {
  const byId = <R extends { id: string }>(rows: R[]) => (id: string | null | undefined) => rows.find((r) => r.id === id);
  return { mailboxes, widgets, mailbox: byId(mailboxes), widget: byId(widgets) } as unknown as TeamsCtx;
}

describe("followUpMailbox", () => {
  it("passes over a disabled reply address for the brand's next one, and finds none when every one is disabled", () => {
    const off = mailbox({ id: "off", status: "disabled" });
    const on = mailbox({ id: "on", created_at: "2026-02-01T00:00:00Z" });
    expect(followUpMailbox(ctx([off, on]), chat({ mailbox_id: "off" }))?.id).toBe("on");
    expect(followUpMailbox(ctx([off]), chat({ mailbox_id: "off" }))).toBeNull();
  });

  it("prefers the team's address and never takes another private team's", () => {
    const shared = mailbox({ id: "shared", created_at: "2026-03-01T00:00:00Z" });
    const team = mailbox({ id: "team", team_id: "billing", created_at: "2026-04-01T00:00:00Z" });
    const other = mailbox({ id: "other", team_id: "vip", private: true });
    expect(followUpMailbox(ctx([other, shared, team]), chat({ team_id: "billing" }))?.id).toBe("team");
    expect(followUpMailbox(ctx([other, shared]), chat())?.id).toBe("shared");
    expect(followUpMailbox(ctx([other]), chat())).toBeNull();
    expect(followUpMailbox(ctx([mailbox({ brand_id: "brand-2" })]), chat())).toBeNull();
  });
});

describe("NoFollowUpSender", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await i18n.changeLanguage("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  const render = (t: Ticket, c: TeamsCtx) => act(async () => root.render(<NoFollowUpSender ticket={t} ctx={c} />));
  const notice = () => host.querySelector('[role="status"]')?.textContent ?? "";

  it("says the reply stays in the chat when the brand's only mailbox is disabled", async () => {
    await render(chat({ mailbox_id: "mb-1" }), ctx([mailbox({ status: "disabled" })]));
    expect(notice()).toBe("This brand has no mailbox that can send, so the visitor gets replies in the chat only, not by email.");
  });

  it("stays quiet while a mailbox can send, or when no email would go anyway", async () => {
    await render(chat({ mailbox_id: "mb-1" }), ctx([mailbox({})]));
    expect(notice()).toBe("");
    await render(chat({ contact: { id: "c-1", email: null, name: "Vera", avatar_url: null } }), ctx([]));
    expect(notice()).toBe("");
    await render(chat(), ctx([], [{ id: "w-1", settings: { email_follow_up: false } } as Widget]));
    expect(notice()).toBe("");
    await render(chat({ channel: "email" }), ctx([]));
    expect(notice()).toBe("");
  });
});
