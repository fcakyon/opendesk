import { describe, expect, it } from "vitest";
import { OLLIE_LOOK, renderBotSvg } from "../../src/lib/botlook";
import { botShown, canAttach, fileProblem, hostVars, pageUrl, readBotRef, resolveConfig } from "./config";
import { splitSources } from "./html";
import { actionStatus } from "./ai";

describe("widget config", () => {
  it("fills in defaults for an older server", () => {
    const c = resolveConfig({ workspace_name: "Acme", brand_color: null, greeting: "", help_center_url: null, require_email: false });
    expect(c).toMatchObject({
      theme: "auto",
      position: "right",
      offset_x: 20,
      offset_y: 20,
      launcher: "icon",
      launcher_label: "",
      radius: "soft",
      title: "",
      subtitle: "",
      suggestions: [],
      sound: false,
      attachments: true,
      team: [],
      ai_answers: false,
      bot: { id: null, name: "Ollie", role: "", avatar_url: "", look: OLLIE_LOOK, greeting: "" },
    });
  });

  it("takes files unless the widget turns them off", () => {
    expect(resolveConfig({ workspace_name: "Acme", attachments: false }).attachments).toBe(false);
    expect(resolveConfig({ workspace_name: "Acme", attachments: "no" as never }).attachments).toBe(true);
  });

  it("takes voice messages only when the widget turns them on, of a length in range", () => {
    expect(resolveConfig({ workspace_name: "Acme" })).toMatchObject({ voice_messages: false, voice_max_seconds: 60 });
    expect(resolveConfig({ workspace_name: "Acme", voice_messages: true, voice_max_seconds: 120 })).toMatchObject({ voice_messages: true, voice_max_seconds: 120 });
    expect(resolveConfig({ workspace_name: "Acme", voice_max_seconds: 9999 }).voice_max_seconds).toBe(300);
    expect(resolveConfig({ workspace_name: "Acme", voice_max_seconds: 1 }).voice_max_seconds).toBe(5);
  });

  it("reads the allowed extensions and checks files against them", () => {
    expect(resolveConfig({ workspace_name: "Acme" }).attachment_extensions).toBeNull();
    const c = resolveConfig({ workspace_name: "Acme", attachment_extensions: [".png", ".JPG", "exe", ".tar.gz", 5 as never, ".pdf"] });
    expect(c.attachment_extensions).toEqual([".png", ".jpg", ".pdf"]);
    expect(fileProblem({ name: "shot.PNG", size: 10 }, c.attachment_extensions)).toBeNull();
    expect(fileProblem({ name: "run.sh", size: 10 }, c.attachment_extensions)).toBe("type");
    expect(fileProblem({ name: "noext", size: 10 }, c.attachment_extensions)).toBe("type");
    expect(fileProblem({ name: "a.pdf", size: 26 * 1024 * 1024 }, c.attachment_extensions)).toBe("size");
    // An older server sends no list: any type, still the size limit.
    expect(fileProblem({ name: "a.anything", size: 10 }, null)).toBeNull();
    expect(canAttach(c)).toBe(true);
    expect(canAttach(resolveConfig({ workspace_name: "Acme", attachment_extensions: [] }))).toBe(false);
    expect(canAttach(resolveConfig({ workspace_name: "Acme", attachments: false }))).toBe(false);
    expect(canAttach(resolveConfig({ workspace_name: "Acme" }))).toBe(true);
  });

  it("keeps values in range and drops invalid ones", () => {
    const c = resolveConfig({
      workspace_name: "Acme",
      brand_color: "nope",
      greeting: "",
      help_center_url: "javascript:alert(1)",
      require_email: false,
      theme: "neon" as never,
      position: "left",
      offset_x: 999,
      offset_y: -4,
      radius: "round",
      suggestions: ["a", "Where is my order?", "  Reset password  ", "Billing", "Plans", "Extra"],
      team: [{ name: "Priya", avatar_url: "ftp://x" }, { name: "Tom", avatar_url: null }, { name: "Mei", avatar_url: null }, { name: "Ana", avatar_url: null }],
      bot: { name: "", avatar_url: "https://cdn.test/bot.png" } as never,
    });
    expect(c.brand_color).toBeNull();
    expect(c.help_center_url).toBeNull();
    expect(c.theme).toBe("auto");
    expect(c.position).toBe("left");
    expect([c.offset_x, c.offset_y]).toEqual([200, 0]);
    expect(c.suggestions).toEqual(["Where is my order?", "Reset password", "Billing", "Plans"]);
    expect(c.team).toHaveLength(3);
    expect(c.team?.[0].avatar_url).toBeNull();
    expect(c.bot).toMatchObject({ name: "Ollie", avatar_url: "https://cdn.test/bot.png", look: { kind: "image" } });
  });

  it("reads the bot: an older server's name and picture, and a tampered look", () => {
    // An older server: {name, avatar_url}. The picture becomes an image look, the rest is Ollie's.
    const old = resolveConfig({ workspace_name: "A", bot: { name: "  Ava  ", avatar_url: "https://cdn.test/ava.png" } as never }).bot;
    expect(old).toEqual({ id: null, name: "Ava", role: "", avatar_url: "https://cdn.test/ava.png", look: { ...OLLIE_LOOK, kind: "image" }, greeting: "" });
    expect(resolveConfig({ workspace_name: "A", bot: { name: "Ava", avatar_url: null } as never }).bot).toMatchObject({ name: "Ava", avatar_url: "", look: OLLIE_LOOK });

    // A current server, with a look someone tampered with: every bad value takes Ollie's.
    const bot = resolveConfig({
      workspace_name: "A",
      bot: {
        id: "b1",
        name: "Pip",
        role: "Support assistant",
        avatar_url: "javascript:alert(1)",
        greeting: "  Hi, I'm Pip.\nHow can I help?  ",
        look: {
          kind: "emoji",
          shape: '"><script>alert(1)</script>',
          fill: { type: "gradient", color: "red;background:url(x)", to: "#0B7F73" },
          eyes: "dots",
          mouth: "<g onload=alert(1)>",
          accessory: "crown",
          accent: "#f5a524",
          blush: "yes",
          background: "ring",
          emoji: '<img src=x onerror="alert(1)">',
          extra: "<svg/onload=alert(1)>",
        },
      } as never,
    }).bot!;
    expect(bot).toMatchObject({ id: "b1", name: "Pip", role: "Support assistant", avatar_url: "", greeting: "Hi, I'm Pip.\nHow can I help?" });
    expect(bot.look).toEqual({
      kind: "emoji",
      shape: OLLIE_LOOK.shape,
      fill: { type: "gradient", color: OLLIE_LOOK.fill.color, to: "#0b7f73" },
      eyes: "dots",
      mouth: OLLIE_LOOK.mouth,
      accessory: "crown",
      accent: "#f5a524",
      blush: OLLIE_LOOK.blush,
      background: "ring",
      emoji: "",
    });
    const svg = renderBotSvg(bot.look);
    expect(svg).not.toMatch(/script|onload|onerror|url\(x\)|<img/);

    // A look that is not an object at all.
    expect(resolveConfig({ workspace_name: "A", bot: { name: "Pip", look: "<svg/>" } as never }).bot?.look).toEqual(OLLIE_LOOK);
  });

  it("shows a message's own bot, else the widget's", () => {
    const widget = resolveConfig({ workspace_name: "A" }).bot!;
    expect(botShown(readBotRef(null), widget)).toBe(widget);
    // An older live event names only the bot: the widget's look stays.
    expect(botShown(readBotRef({ name: "Ava" }), widget)).toMatchObject({ name: "Ava", look: OLLIE_LOOK });
    const own = botShown(readBotRef({ id: "b2", name: "Fox", avatar_url: "https://cdn.test/fox.png", look: { ...OLLIE_LOOK, kind: "emoji", emoji: "🦊" } }), widget);
    expect(own).toMatchObject({ id: "b2", name: "Fox", avatar_url: "https://cdn.test/fox.png", look: { kind: "emoji", emoji: "🦊" } });
    expect(renderBotSvg(own.look)).toContain("🦊");
  });

  it("reads topics, hours, the offline message, the chat intro and the brand", () => {
    const older = resolveConfig({ workspace_name: "Acme", brand_color: null, greeting: "", help_center_url: null, require_email: false });
    expect(older).toMatchObject({ topics: [], open: true, offline_message: "", intro: "", chat_welcome: true, language: "", brand: { name: "Acme", color: null } });

    const c = resolveConfig({
      workspace_name: "",
      brand_color: null,
      greeting: "",
      help_center_url: null,
      require_email: false,
      topics: [
        { id: "billing", label: "  Billing  " },
        { id: "billing", label: "Twice" },
        { id: "x", label: "a" },
        { id: "", label: "No id" },
        ...Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, label: `Topic ${i}` })),
      ],
      open: false,
      offline_message: "  Back on Monday.  ",
      intro: "  Ask about orders.\nWe reply here.  ",
      chat_welcome: false,
      language: " tr ",
      brand: { name: "Pressroom", color: "#e11d48" },
    });
    expect(c.topics?.[0]).toEqual({ id: "billing", label: "Billing" });
    expect(c.topics).toHaveLength(8);
    expect(c.topics?.map((x) => x.id)).not.toContain("x");
    expect(c.open).toBe(false);
    expect(c.offline_message).toBe("Back on Monday.");
    expect(c.intro).toBe("Ask about orders.\nWe reply here.");
    expect(c.chat_welcome).toBe(false);
    expect(c.language).toBe("tr");
    // No widget colour or name: the brand's.
    expect(c.brand_color).toBe("#e11d48");
    expect(c.workspace_name).toBe("Pressroom");
    expect(resolveConfig({ ...c, brand_color: "#123456" }).brand_color).toBe("#123456");
  });

  it("maps appearance onto host CSS variables", () => {
    const v = hostVars(resolveConfig({ workspace_name: "A", brand_color: "#ffd43b", greeting: "", help_center_url: null, require_email: false, radius: "round", offset_x: 32 }));
    expect(v["--brand"]).toBe("var(--opendesk-brand, #ffd43b)");
    expect(v["--brand-fg"]).toBe("var(--opendesk-brand-text, #0a0a0a)");
    expect(v["--r-launcher"]).toBe("999px");
    expect(v["--ox"]).toBe("var(--opendesk-offset-x, 32px)");
    expect(v["--oy"]).toBe("var(--opendesk-offset-y, 20px)");
    expect(v["--oz"]).toBe("var(--opendesk-z-index, 2147483000)");
    // No workspace colour: the page's own, else the widget's neutral.
    expect(hostVars(resolveConfig(null))["--brand"]).toBe("var(--opendesk-brand)");
  });

  it("stacks at the workspace's z_index, else above the page", () => {
    const base = { workspace_name: "A", brand_color: null, greeting: "", help_center_url: null, require_email: false };
    expect(hostVars(resolveConfig({ ...base, z_index: 40 }))["--oz"]).toBe("var(--opendesk-z-index, 40)");
    expect(resolveConfig({ ...base, z_index: -5 }).z_index).toBe(0);
    expect(resolveConfig({ ...base, z_index: 1e12 }).z_index).toBe(2147483647);
    expect(resolveConfig({ ...base, z_index: "9" as never }).z_index).toBe(0);
  });

  it("reports the page URL over https only, without fragment, capped at 500", () => {
    expect(pageUrl("https://shop.test/cart?x=1#token=abc")).toBe("https://shop.test/cart?x=1");
    expect(pageUrl("http://shop.test/cart")).toBeUndefined();
    expect(pageUrl("https://user:pw@shop.test/")).toBe("https://shop.test/");
    const long = pageUrl(`https://shop.test/p?q=${"x".repeat(600)}`);
    expect(long).toBe("https://shop.test/p");
    expect(pageUrl(`https://shop.test/${"y".repeat(600)}`)!.length).toBe(500);
  });
});

describe("agent reply parts", () => {
  it("splits trailing source links into chips", () => {
    const r = splitSources('<p>Answer.</p><ul><li><a href="https://h.test/a">Guide A</a></li><li><a href="https://h.test/b">Guide B</a></li></ul>');
    expect(r.html).toBe("<p>Answer.</p>");
    expect(r.sources).toEqual([
      { href: "https://h.test/a", title: "Guide A" },
      { href: "https://h.test/b", title: "Guide B" },
    ]);
    // A list that is part of the answer stays.
    const keep = "<p>Steps:</p><ul><li>Open settings</li></ul>";
    expect(splitSources(keep)).toEqual({ html: keep, sources: [] });
  });

  it("shows the action's server status, else the decision in flight", () => {
    expect(actionStatus({ status: "pending" }, undefined)).toBe("pending");
    expect(actionStatus({ status: "pending" }, { busy: "confirm" })).toBe("pending");
    expect(actionStatus({ status: "pending" }, { status: "confirmed" })).toBe("confirmed");
    expect(actionStatus({ status: "failed" }, { status: "confirmed" })).toBe("failed");
    expect(actionStatus({ status: "expired" }, undefined)).toBe("expired");
  });
});
