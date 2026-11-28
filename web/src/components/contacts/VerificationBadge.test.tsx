// A chat visitor's verification beside their name and at the top of the chat.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { i18n, loadAgentCatalogs } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ContactVerification } from "@/lib/api/types";
import { VisitorPresenceBar } from "@/components/tickets/detail/VisitorPresence";
import { VerificationBadge } from "./VerificationBadge";
import card from "./ContactCard.tsx?raw";
import detail from "@/components/tickets/detail/TicketDetail.tsx?raw";
import apply from "@/lib/realtime/apply.ts?raw";

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

const v = (status: ContactVerification["status"], via: ContactVerification["via"] = null): ContactVerification => ({
  status,
  via,
  verified_at: status === "verified" ? "2026-11-13T10:00:00Z" : null,
});

const render = (node: React.ReactNode) => {
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
  return host.textContent;
};

describe("VerificationBadge", () => {
  it("says Verified or Unverified, and nothing for a contact the widget did not identify", async () => {
    expect(render(<VerificationBadge v={v("verified", "email")} />)).toBe("Verified");
    expect(host.querySelector("[data-testid=contact-verification]")?.getAttribute("data-status")).toBe("verified");
    expect(render(<VerificationBadge v={v("verified", "identity")} />)).toBe("Verified");
    expect(render(<VerificationBadge v={v("unverified")} />)).toBe("Unverified");
    expect(render(<VerificationBadge v={v("none")} />)).toBe("");
    expect(render(<VerificationBadge v={undefined} />)).toBe("");
    await i18n.changeLanguage("fr");
    expect(render(<VerificationBadge v={v("unverified")} />)).toBe("Non vérifié");
    await i18n.changeLanguage("de");
    expect(render(<VerificationBadge v={v("verified", "email")} />)).toBe("Verifiziert");
  });

  it("sits at the end of the chat's presence line", () => {
    const p = { chat: true, present: true, last_seen_at: new Date().toISOString(), away_after_seconds: 120, email_follow_up: false, now: Date.now() };
    expect(render(<VisitorPresenceBar p={p} verification={v("unverified")} />)).toBe("On the page nowUnverified");
    expect(render(<VisitorPresenceBar p={p} verification={v("verified", "email")} />)).toBe("On the page nowVerified");
  });

  it("shows beside the contact's name and on chat tickets, and live through contact.updated", () => {
    expect(card).toContain("<VerificationBadge v={c.verification} />");
    expect(detail).toContain("verification={useChatVerification(ticket)}");
    // contact.verified is the widget's copy; the app takes the contact from contact.updated.
    expect(apply).toContain('if (verb === "verified") return;');
  });
});
