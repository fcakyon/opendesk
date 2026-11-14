import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Controller } from "./controller";
import { createMock, demoConfig } from "./mock";
import { repliesFor } from "./live";

describe("controller with the agent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("streams a reply, swaps in the posted message, confirms the action and rates it", async () => {
    const mock = createMock({ seed: "preview", latency: 5 });
    const c = new Controller({ base: "https://mock.invalid", key: "wk_demo", fetcher: mock.fetch, socketFactory: mock.socket, persist: false });
    const boot = c.boot(demoConfig("wk_demo"));
    await vi.advanceTimersByTimeAsync(200);
    await boot;
    const id = mock.showcaseId;
    const open = c.openConversation(id);
    await vi.advanceTimersByTimeAsync(50);
    await open;
    const before = c.store.get().messages[id].length;

    mock.playShowcase();
    await vi.advanceTimersByTimeAsync(1500);
    const writing = repliesFor(c.store.get().live, id);
    expect(writing).toHaveLength(1);
    expect(writing[0].tools[0]).toMatchObject({ name: "Order lookup" });

    await vi.advanceTimersByTimeAsync(8000);
    const s = c.store.get();
    expect(repliesFor(s.live, id)).toHaveLength(0);
    const msgs = s.messages[id];
    expect(msgs).toHaveLength(before + 1);
    const reply = msgs[msgs.length - 1];
    expect(reply.ai).toBe(true);
    expect(reply.ai_action?.status).toBe("pending");
    expect(s.swapped[reply.id]).toBe(true);

    // Confirm: busy at once, confirmed optimistically, then the server's message.updated.
    const decide = c.decide(id, reply.ai_action!, "confirm");
    expect(c.store.get().actions[reply.ai_action!.id]).toEqual({ busy: "confirm" });
    await vi.advanceTimersByTimeAsync(20);
    await decide;
    expect(c.store.get().actions[reply.ai_action!.id]).toEqual({ status: "confirmed" });
    await vi.advanceTimersByTimeAsync(400);
    const updated = c.store.get().messages[id].find((m) => m.id === reply.id)!;
    expect(updated.ai_action?.status).toBe("confirmed");
    expect(c.store.get().actions[reply.ai_action!.id]).toBeUndefined();

    // Rate up, then the same again clears it.
    const rate = c.rate(id, updated, "up");
    expect(c.store.get().ratings[reply.id]).toBe("up");
    await vi.advanceTimersByTimeAsync(300);
    await rate;
    expect(c.store.get().messages[id].find((m) => m.id === reply.id)?.ai_rating).toBe("up");
    expect(reply.id in c.store.get().ratings).toBe(false);
    const fresh = c.store.get().messages[id].find((m) => m.id === reply.id)!;
    const clear = c.rate(id, fresh, "up");
    expect(c.store.get().ratings[reply.id]).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    await clear;
    expect(c.store.get().messages[id].find((m) => m.id === reply.id)?.ai_rating).toBeNull();

    c.stop();
    mock.dispose();
  });

  it("marks a handoff from the agent's ended event", async () => {
    const mock = createMock({ seed: "demo", latency: 5 });
    const c = new Controller({ base: "https://mock.invalid", key: "wk_demo", fetcher: mock.fetch, socketFactory: mock.socket, persist: false });
    const boot = c.boot(demoConfig("wk_demo"));
    await vi.advanceTimersByTimeAsync(200);
    await boot;
    c.newConversation();
    const send = c.send("Can I talk to a person?", []);
    await vi.advanceTimersByTimeAsync(50);
    await send;
    const id = c.store.get().active!;
    expect(c.store.get().awaiting[id]).toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.store.get().handoff[id]).toBe("done");
    expect(c.store.get().conversations?.find((x) => x.id === id)?.ai_handoff).toBe(true);
    c.stop();
    mock.dispose();
  });
});

describe("controller with topics", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const boot = async (key: string) => {
    const mock = createMock({ seed: "empty", latency: 5 });
    const c = new Controller({ base: "https://mock.invalid", key, fetcher: mock.fetch, socketFactory: mock.socket, persist: false });
    const b = c.boot(demoConfig(key, new URLSearchParams("od_bot=0")));
    await vi.advanceTimersByTimeAsync(200);
    await b;
    return { c, mock };
  };

  it("asks for a topic before the first message and sends it as topic_id", async () => {
    const { c, mock } = await boot("wk_topics");
    c.newConversation();
    expect(c.needsTopic()).toBe(true);
    await c.pickTopic("billing");
    expect(c.needsTopic()).toBe(false);
    const send = c.send("Can I get a refund?", []);
    await vi.advanceTimersByTimeAsync(50);
    await send;
    expect(mock.lastTopic).toBe("billing");
    expect(c.store.get().active).not.toBeNull();
    // An open conversation never asks; a new one asks again.
    expect(c.needsTopic()).toBe(false);
    c.newConversation();
    expect(c.needsTopic()).toBe(true);
    c.newConversation("orders");
    expect(c.store.get().topic).toBe("orders");
    c.stop();
    mock.dispose();
  });

  it("holds a tapped suggestion until a topic is picked", async () => {
    const { c, mock } = await boot("wk_topics");
    await c.startWith("Where is my order?");
    expect(c.store.get().queued).toBe("Where is my order?");
    expect(c.store.get().conversations).toEqual([]);
    const pick = c.pickTopic("orders");
    await vi.advanceTimersByTimeAsync(50);
    await pick;
    const s = c.store.get();
    expect(s.queued).toBeNull();
    expect(s.conversations?.[0]?.last_message_preview).toBe("Where is my order?");
    expect(mock.lastTopic).toBe("orders");
    c.stop();
    mock.dispose();
  });

  it("sends a suggestion at once without topics, with no topic_id", async () => {
    const { c, mock } = await boot("wk_demo");
    const go = c.startWith("Where is my order?");
    await vi.advanceTimersByTimeAsync(50);
    await go;
    expect(c.needsTopic()).toBe(false);
    expect(c.store.get().conversations?.[0]?.last_message_preview).toBe("Where is my order?");
    expect(mock.lastTopic).toBeNull();
    c.stop();
    mock.dispose();
  });
});

describe("controller with a reply taken back", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops a message the team took back from the open conversation", async () => {
    const mock = createMock({ seed: "preview", latency: 5 });
    const c = new Controller({ base: "https://mock.invalid", key: "wk_demo", fetcher: mock.fetch, socketFactory: mock.socket, persist: false });
    const boot = c.boot(demoConfig("wk_demo"));
    await vi.advanceTimersByTimeAsync(200);
    await boot;
    const id = mock.showcaseId;
    const open = c.openConversation(id);
    await vi.advanceTimersByTimeAsync(50);
    await open;
    const before = c.store.get().messages[id];
    expect(before.length).toBeGreaterThan(0);
    const gone = before[before.length - 1].id;

    c.onEvent({ type: "message.withdrawn", data: { ticket_id: id, message_id: gone } } as unknown as Parameters<Controller["onEvent"]>[0]);
    const after = c.store.get().messages[id];
    expect(after).toHaveLength(before.length - 1);
    expect(after.some((m) => m.id === gone)).toBe(false);
  });
});

describe("replies that came while the visitor was away", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** The mock API, with the session reporting a reply the visitor has not read. */
  function awayFetch(mock: ReturnType<typeof createMock>) {
    return async (url: string, init: RequestInit) => {
      const res = await mock.fetch(url, init);
      if (!url.endsWith("/v1/widget/session")) return res;
      const body = await res.json();
      const latest = {
        id: "msg-away",
        ticket_id: "conv-away",
        kind: "reply",
        direction: "outbound",
        body_html: "<p>Your order shipped today.</p>",
        body_text: "Your order shipped today.",
        author: { type: "user", user: { id: "u1", name: "Maya", avatar_url: null }, contact: null },
        attachments: [],
        created_at: new Date().toISOString(),
      };
      return new Response(JSON.stringify({ ...body, unread: 2, unread_latest: latest }), { status: 200, headers: { "content-type": "application/json" } });
    };
  }

  it("counts them on the launcher and previews the newest until the visitor opens or dismisses it", async () => {
    const mock = createMock({ seed: "demo", latency: 5 });
    const c = new Controller({ base: "https://mock.invalid", key: "wk_away", fetcher: awayFetch(mock), socketFactory: mock.socket });
    const boot = c.boot(demoConfig("wk_away"));
    await vi.advanceTimersByTimeAsync(200);
    await boot;
    let s = c.store.get();
    expect(s.unread).toBe(2);
    expect(s.teaser?.id).toBe("msg-away");
    expect(c.senderName(s.teaser!)).toBe("Maya");
    expect(c.senderName({ ...s.teaser!, author: { type: "user", user: null, contact: null } })).toBe(s.config?.title || s.config?.brand?.name || s.config?.workspace_name);

    c.dismissTeaser();
    expect(c.store.get().teaser).toBeNull();
    c.stop();

    // The next page load does not preview the dismissed reply again; the count stays.
    const again = new Controller({ base: "https://mock.invalid", key: "wk_away", fetcher: awayFetch(mock), socketFactory: mock.socket });
    const boot2 = again.boot(demoConfig("wk_away"));
    await vi.advanceTimersByTimeAsync(200);
    await boot2;
    s = again.store.get();
    expect(s.unread).toBe(2);
    expect(s.teaser).toBeNull();

    again.open();
    expect(again.store.get().unread).toBe(0);
    again.stop();
    mock.dispose();
  });
});

describe("reading a conversation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("marks it seen only while the widget is open on it, never on a background fetch", async () => {
    const mock = createMock({ seed: "demo", latency: 5 });
    const seen: string[] = [];
    const fetcher = (url: string, init: RequestInit) => {
      const m = /\/v1\/widget\/conversations\/([^/]+)\/seen$/.exec(url);
      if (m) {
        seen.push(decodeURIComponent(m[1]));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return mock.fetch(url, init);
    };
    const c = new Controller({ base: "https://mock.invalid", key: "wk_seen", fetcher, socketFactory: mock.socket, persist: false });
    const boot = c.boot(demoConfig("wk_seen"));
    await vi.advanceTimersByTimeAsync(200);
    await boot;
    const id = c.store.get().conversations?.[0]?.id ?? mock.showcaseId;

    // Fetched while the widget is closed (the last conversation stays selected): not read.
    const closed = c.openConversation(id);
    await vi.advanceTimersByTimeAsync(50);
    await closed;
    expect(c.store.get().messages[id]).toBeDefined();
    expect(seen).toEqual([]);

    // Opened on it: read.
    c.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([id]);

    // Closed again, a background fetch reads nothing more.
    c.close();
    const again = c.openConversation(id);
    await vi.advanceTimersByTimeAsync(50);
    await again;
    expect(seen).toEqual([id]);
    c.stop();
    mock.dispose();
  });
});
