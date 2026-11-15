import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, loadAgentCatalogs } from "@/i18n";
import { ConfirmProvider } from "@/components/ui/confirm";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Message } from "@/lib/api/types";
import { setClock } from "@/lib/format";
import { MessageItem } from "./MessageItem";

vi.mock("@tanstack/react-router", async (orig) => ({ ...(await orig<object>()), useNavigate: () => vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Intl separates with no-break spaces; compare on plain spaces. */
const sp = (s: string | null | undefined) => (s ?? "").replace(/[\u00a0\u202f]/g, " ");

// Local times, so the day boundaries hold in any timezone.
const NOON = new Date(2026, 10, 9, 12, 0);

const message = (patch: Partial<Message> = {}): Message =>
  ({
    id: "m1",
    ticket_id: "t1",
    kind: "reply",
    direction: "inbound",
    author: { type: "contact", user: null, contact: { id: "c1", name: "Ada Buyer", email: "ada@example.com" } },
    body_html: "<p>Where is my order?</p>",
    body_text: "Where is my order?",
    has_quoted: false,
    subject: "Order",
    from_email: "ada@example.com",
    from_name: "Ada Buyer",
    to: [],
    cc: [],
    bcc: [],
    attachments: [],
    delivery_status: "delivered",
    delivery_error: "",
    ai: false,
    created_at: "2026-11-09T08:45:00",
    edited_at: null,
    ...patch,
  }) as Message;

describe("MessageItem's time", () => {
  let root: Root | null = null;

  beforeAll(async () => {
    await loadAgentCatalogs("en");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
  });
  afterAll(() => vi.useRealTimers());
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    setClock("auto");
    await i18n.changeLanguage("en");
  });

  async function render(m: Message) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <QueryClientProvider client={qc}>
          <ConfirmProvider>
            <TooltipProvider>
              <MessageItem m={m} />
            </TooltipProvider>
          </ConfirmProvider>
        </QueryClientProvider>,
      ),
    );
    return document.querySelector("time")!;
  }

  it("shows only the time on today's messages", async () => {
    await i18n.changeLanguage("en-US");
    const time = await render(message());
    expect(sp(time.textContent)).toBe("8:45 AM");
    expect(time.getAttribute("datetime")).toBe("2026-11-09T08:45:00");
  });

  it("shows the day with the time on an older message, and the year outside this one", async () => {
    await i18n.changeLanguage("en-US");
    expect(sp((await render(message({ created_at: "2026-11-08T20:45:00" }))).textContent)).toBe("Nov 8 · 8:45 PM");
    await act(async () => root!.unmount());
    expect(sp((await render(message({ created_at: "2025-11-08T20:45:00" }))).textContent)).toBe("Nov 8, 2025 · 8:45 PM");
  });

  it("follows the person's clock and the app's language", async () => {
    await i18n.changeLanguage("fr");
    setClock("12h");
    expect(sp((await render(message({ created_at: "2026-11-08T20:45:00" }))).textContent)).toBe("8 nov. · 8:45 PM");
    await act(async () => root!.unmount());
    setClock("24h");
    expect(sp((await render(message({ created_at: "2026-11-08T20:45:00" }))).textContent)).toBe("8 nov. · 20:45");
  });

  it("dates a note and a deleted message's marker the same way", async () => {
    await i18n.changeLanguage("en-US");
    setClock("24h");
    const note = message({ kind: "note", direction: "outbound", author: { type: "user", user: { id: "u1", name: "Lea Martin", email: "lea@margin.test", avatar_url: null }, contact: null } } as Partial<Message>);
    expect(sp((await render({ ...note, created_at: "2026-11-07T09:10:00" })).textContent)).toBe("Nov 7 · 09:10");
    await act(async () => root!.unmount());
    const deleted = { ...note, deleted_at: "2026-11-08T17:30:00", deleted_by: note.author.user, body_html: "", body_text: "" };
    expect(sp((await render(deleted)).textContent)).toBe("Nov 8 · 17:30");
  });
});
