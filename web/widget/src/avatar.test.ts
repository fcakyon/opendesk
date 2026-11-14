import { h, render, type ComponentChild } from "preact";
import { describe, expect, it } from "vitest";
import { OLLIE_LOOK } from "../../src/lib/botlook";
import { AvatarStack, BotAvatar, BotGreeting, Bubble } from "./messages";
import type { BotRef } from "./types";

const ollie: BotRef = { id: null, name: "Ollie", avatar_url: "https://cdn.test/ollie.png", look: OLLIE_LOOK };

function mount(node: ComponentChild) {
  const el = document.createElement("div");
  render(node, el);
  return el;
}

describe("bot avatar", () => {
  it("draws the look, and shows an uploaded picture only for an image look", () => {
    const built = mount(h(BotAvatar, { bot: ollie }));
    expect(built.querySelector("svg.odb")).not.toBeNull();
    expect(built.querySelector("img")).toBeNull();

    const pic = mount(h(BotAvatar, { bot: { ...ollie, look: { ...OLLIE_LOOK, kind: "image" } } }));
    expect(pic.querySelector(".bot-av.is-pic img")?.getAttribute("src")).toBe("https://cdn.test/ollie.png");

    // An image look without a picture falls back to the drawn look.
    const none = mount(h(BotAvatar, { bot: { ...ollie, avatar_url: "", look: { ...OLLIE_LOOK, kind: "image" } } }));
    expect(none.querySelector("svg.odb")).not.toBeNull();

    const emoji = mount(h(BotAvatar, { bot: { ...ollie, look: { ...OLLIE_LOOK, kind: "emoji", emoji: "🦊" } } }));
    expect(emoji.querySelector("svg text")?.textContent).toBe("🦊");
  });

  it("never renders markup from a tampered look", () => {
    const el = mount(h(BotAvatar, { bot: { ...ollie, look: { ...OLLIE_LOOK, kind: "emoji", emoji: "<img src=x onerror=alert(1)>", shape: "<script>" } as never } }));
    expect(el.querySelector("img, script")).toBeNull();
    expect(el.innerHTML).not.toMatch(/onerror|<script/);
  });

  it("blinks in the header stack, and the greeting is attributed to the bot", () => {
    const stack = mount(h(AvatarStack, { team: [], bot: ollie, size: 26 }));
    expect(stack.querySelector(".odb-anim svg")).not.toBeNull();
    const hello = mount(h(BotGreeting, { bot: { ...ollie, role: "Support assistant" }, text: "Hi, I'm Ollie." }));
    expect(hello.querySelector(".who-name")?.textContent).toBe("Ollie");
    expect(hello.querySelector(".who-role")?.textContent).toBe("Support assistant");
    expect(hello.querySelector(".msg")?.textContent).toBe("Hi, I'm Ollie.");
  });

  it("falls back to the brand logo and name when agent identity is withheld", () => {
    const el = mount(
      h(Bubble, {
        m: {
          id: "m1",
          ticket_id: "t1",
          kind: "reply",
          direction: "outbound",
          author: { type: "user", user: null, contact: null },
          body_html: "<p>Hi there</p>",
          body_text: "Hi there",
          attachments: [],
          created_at: "2026-11-14T20:00:00Z",
        },
        me: false,
        grouped: false,
        brand: { name: "MuviSafe", avatar_url: "https://cdn.test/muvisafe.png" },
        onRetry: () => {},
      }),
    );
    expect(el.querySelector(".who-name")?.textContent).toBe("MuviSafe");
    expect(el.querySelector(".who .av img")?.getAttribute("src")).toBe("https://cdn.test/muvisafe.png");
  });
});
