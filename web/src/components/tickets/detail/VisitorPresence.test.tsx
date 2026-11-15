// The chat visitor's presence at the top of a ticket.
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { i18n, loadAgentCatalogs } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyVisitorPresence, minutesAway, recheckIn, visitorPresenceKey, type VisitorPresence } from "@/lib/visitorPresence";
import { awayFor, VisitorPresenceBar } from "./VisitorPresence";
import detail from "./TicketDetail.tsx?raw";
import manager from "@/lib/realtime/manager.ts?raw";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => loadAgentCatalogs("fr"));

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  await i18n.changeLanguage("en");
});

const NOW = Date.parse("2026-11-09T16:00:00Z");
const p = (present: boolean, seenMinAgo: number | null, email = true): VisitorPresence & { now: number } => ({
  chat: true,
  present,
  last_seen_at: seenMinAgo === null ? null : new Date(NOW - seenMinAgo * 60_000).toISOString(),
  away_after_seconds: 120,
  email_follow_up: email,
  now: NOW,
});

const render = (v: (VisitorPresence & { now: number }) | null) => {
  act(() => root.render(<TooltipProvider><VisitorPresenceBar p={v} /></TooltipProvider>));
  return host.textContent;
};

describe("VisitorPresenceBar", () => {
  it("shows the visitor on the site, or gone with the email that will follow", async () => {
    expect(render(p(true, 0.5))).toBe("On the page now");
    expect(render(p(false, 5))).toBe("Left 5 min agoYour reply will also be sent to them by email");
    expect(render(p(false, 75, false))).toBe("Left 1h 15m ago");
    expect(render(p(false, null, false))).toBe("Not on the page");
    expect(render(null)).toBe("");
    await i18n.changeLanguage("fr");
    expect(render(p(true, 0))).toBe("Sur la page maintenant");
    expect(render(p(false, 3))).toBe("Parti il y a 3 minVotre réponse lui sera aussi envoyée par e-mail");
  });

  it("is at the top of a chat ticket", () => {
    expect(detail).toContain('{t?.channel === "chat" && <ChatPresence ticket={t} />}');
  });
});

describe("presence helpers", () => {
  it("counts minutes away and when to look again", () => {
    expect(minutesAway(p(false, 5), NOW)).toBe(5);
    expect(minutesAway(p(false, null), NOW)).toBeNull();
    expect(awayFor(0.2)).toBe("1 min");
    expect(awayFor(59.9)).toBe("59 min");
    // Seen 30 s ago, away after 120 s: look again in 91 s.
    expect(recheckIn(p(true, 0.5), NOW)).toBe(91_000);
    expect(recheckIn(p(false, 5), NOW)).toBeNull();
  });

  it("reloads the ticket's presence on customer_presence", async () => {
    const qc = new QueryClient();
    qc.setQueryData(visitorPresenceKey("t1"), p(false, 5));
    qc.setQueryData(visitorPresenceKey("t2"), p(false, 5));
    applyVisitorPresence(qc, "t1");
    expect(qc.getQueryState(visitorPresenceKey("t1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(visitorPresenceKey("t2"))?.isInvalidated).toBe(false);
    expect(manager).toContain('ch.on("customer_presence", (p) => {');
  });
});
