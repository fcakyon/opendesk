// A chat ticket's composer says where the reply goes.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { i18n, loadAgentCatalogs } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { VisitorPresence } from "@/lib/visitorPresence";
import { ChatReplyText } from "./ChatReplyLine";
import composer from "./Composer.tsx?raw";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => Promise.all([loadAgentCatalogs("fr"), loadAgentCatalogs("de")]));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  await i18n.changeLanguage("en");
});

const presence = (present: boolean, email = true): VisitorPresence => ({
  chat: true,
  present,
  last_seen_at: new Date().toISOString(),
  away_after_seconds: 120,
  email_follow_up: email,
});

describe("ChatReplyText", () => {
  it.each([
    ["en", "In the chat", "In the chat · by email if they don't read it", "In the chat · by email if the visitor has left"],
    ["fr", "Dans le chat", "Dans le chat · par e-mail s’il ne la lit pas", "Dans le chat · par e-mail si le visiteur est parti"],
    ["de", "Im Chat", "Im Chat · per E-Mail, falls er sie nicht liest", "Im Chat · per E-Mail, falls der Besucher gegangen ist"],
  ])("reads the delivery in %s, never an email address", async (lng, here, away, unknown) => {
    await i18n.changeLanguage(lng);
    const text = (p: VisitorPresence | null) => {
      act(() => root.render(<TooltipProvider><ChatReplyText p={p} /></TooltipProvider>));
      return host.textContent;
    };
    expect(text(presence(true))).toBe(here);
    expect(text(presence(false))).toBe(away);
    // Away without an email known: nothing is emailed.
    expect(text(presence(false, false))).toBe(here);
    // Not loaded yet (or no access): the general rule.
    expect(text(null)).toBe(unknown);
    expect(host.textContent).not.toContain("@");
  });

  it("is the composer's line for chat tickets", () => {
    expect(composer).toContain('ticket.channel === "chat" ? (');
    expect(composer).toContain("<ChatReplyLine ticket={ticket} />");
  });
});
