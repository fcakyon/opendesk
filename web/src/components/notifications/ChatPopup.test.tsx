// A chat assigned to the member pops up, once, with the visitor's name and first words and
// Open; any other notification is left to the usual toast. While it shows in a background tab,
// the tab's title blinks.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import type { Notification, Ticket } from "@/lib/api/types";
import { useRealtime } from "@/lib/realtime/store";

const sonner = vi.hoisted(() => ({ custom: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast: sonner }));
const play = vi.hoisted(() => vi.fn());
vi.mock("@/lib/alertSound", () => ({ playAlertOnce: play }));
const getTicket = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/endpoints", () => ({ api: { tickets: { get: getTicket } } }));
const desk = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/desktop", () => ({
  get isDesktop() {
    return desk.on;
  },
}));

import { blinkTitle, firstWords, isChatAssignment, resetChatPopups, showChatPopup } from "./ChatPopup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

const note = (over: Partial<Notification> = {}): Notification => ({
  id: "n1",
  type: "assigned",
  ticket: { id: "t1", number: 668400, subject: "Chat with a visitor" },
  data: { by: null, actor_type: "system", channel: "chat" },
  read_at: null,
  created_at: "2026-11-06T10:00:00Z",
  ...over,
});

describe("chat pop-up", () => {
  let root: Root;
  let el: HTMLDivElement;
  beforeEach(() => {
    resetChatPopups();
    sonner.custom.mockClear();
    sonner.dismiss.mockClear();
    play.mockClear();
    getTicket.mockReset();
    getTicket.mockResolvedValue({
      id: "t1",
      contact: { id: "c1", name: "Ada Martin", email: "ada@example.com" },
      last_message_preview: "Hello, I ordered the chair last week and one leg arrived broken, what can I do about it please? Thanks a lot",
    } as unknown as Ticket);
    el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    useRealtime.setState({ active: null });
    desk.on = false;
  });
  afterEach(() => {
    act(() => root.unmount());
    el.remove();
    vi.restoreAllMocks();
  });

  const card = async (navigate = vi.fn()) => {
    showChatPopup(note(), "w1", navigate);
    await settle();
    const render = sonner.custom.mock.calls[0][0] as (id: string) => React.ReactElement;
    await act(async () => root.render(render("chat:t1")));
    await settle();
    return el.querySelector("[data-chat-popup]")!;
  };

  it("takes only a chat's assigned notification", () => {
    expect(isChatAssignment(note())).toBe(true);
    expect(isChatAssignment(note({ data: { channel: "email" } }))).toBe(false);
    expect(isChatAssignment(note({ type: "mentioned" }))).toBe(false);
    expect(isChatAssignment(note({ ticket: null }))).toBe(false);
    expect(showChatPopup(note({ data: { channel: "email" } }), "w1", vi.fn())).toBe(false);
    expect(sonner.custom).not.toHaveBeenCalled();
  });

  it("pops up once per chat, sticky, with the chat alarm", async () => {
    expect(showChatPopup(note(), "w1", vi.fn())).toBe(true);
    expect(showChatPopup(note({ id: "n2" }), "w1", vi.fn())).toBe(true);
    await settle();
    expect(sonner.custom).toHaveBeenCalledTimes(1);
    expect(sonner.custom.mock.calls[0][1]).toMatchObject({ id: "chat:t1", duration: Infinity });
    expect(play).toHaveBeenCalledWith("waiting", "chat:t1");
  });

  it("shows who and their first words, opens the chat in a new tab and closes", async () => {
    const winOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const navigate = vi.fn();
    const c = await card(navigate);
    expect(c.getAttribute("role")).toBe("alertdialog");
    expect(c.textContent).toContain("New chat · Ada Martin");
    expect(c.textContent).toContain("Hello, I ordered the chair");
    expect(c.textContent).not.toContain("Thanks a lot");
    const [openBtn, closeBtn] = [...c.querySelectorAll("button")];
    expect(openBtn.textContent).toBe("Open");
    act(() => openBtn.click());
    expect(winOpen).toHaveBeenCalledWith("/inbox/mine/t1?ws=w1", "_blank", "noopener");
    expect(navigate).not.toHaveBeenCalled();
    expect(sonner.dismiss).toHaveBeenCalledWith("chat:t1");
    expect(closeBtn.getAttribute("aria-label")).toBe("Close");
  });

  it("opens the chat in place in the desktop app", async () => {
    desk.on = true;
    const winOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const navigate = vi.fn();
    const c = await card(navigate);
    act(() => c.querySelector("button")!.click());
    expect(navigate).toHaveBeenCalledWith("/inbox/mine/t1?ws=w1");
    expect(winOpen).not.toHaveBeenCalled();
  });

  it("still pops up, with the subject, when the chat can't be read", async () => {
    getTicket.mockRejectedValue(new Error("offline"));
    const c = await card();
    expect(c.textContent).toContain("New chat");
    expect(c.textContent).toContain("Chat with a visitor");
  });

  it("goes away once the chat is open", async () => {
    showChatPopup(note(), "w1", vi.fn());
    await settle();
    const render = sonner.custom.mock.calls[0][0] as (id: string) => React.ReactElement;
    await act(async () => root.render(render("chat:t1")));
    expect(sonner.dismiss).not.toHaveBeenCalled();
    act(() => useRealtime.setState({ active: "t1" }));
    expect(sonner.dismiss).toHaveBeenCalledWith("chat:t1");
  });

  it("cuts the first words at a word", () => {
    expect(firstWords("Short one")).toBe("Short one");
    expect(firstWords("a ".repeat(100), 20)).toBe("a a a a a a a a a a…");
  });
});

describe("blinking title", () => {
  let hidden = true;
  beforeEach(() => {
    hidden = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    vi.useFakeTimers();
    document.title = "Inbox · opendesk";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("blinks in a background tab while a pop-up shows and restores the title after the last one", () => {
    const stopA = blinkTitle("● New chat");
    const stopB = blinkTitle("● New chat");
    vi.advanceTimersByTime(1000);
    expect(document.title).toBe("● New chat");
    vi.advanceTimersByTime(1000);
    expect(document.title).toBe("Inbox · opendesk");
    stopA();
    vi.advanceTimersByTime(1000);
    expect(document.title).toBe("● New chat"); // still blinking for the second
    stopB();
    expect(document.title).toBe("Inbox · opendesk");
    vi.advanceTimersByTime(3000);
    expect(document.title).toBe("Inbox · opendesk");
  });

  it("keeps a title the page set meanwhile, and stays still in a tab in view", () => {
    const stop = blinkTitle("● New chat");
    vi.advanceTimersByTime(1000);
    expect(document.title).toBe("● New chat");
    vi.advanceTimersByTime(1000);
    document.title = "Order 1042 · opendesk";
    vi.advanceTimersByTime(1000);
    expect(document.title).toBe("● New chat");
    vi.advanceTimersByTime(1000);
    expect(document.title).toBe("Order 1042 · opendesk");
    vi.advanceTimersByTime(1000);
    hidden = false;
    vi.advanceTimersByTime(1000);
    expect(document.title).toBe("Order 1042 · opendesk");
    vi.advanceTimersByTime(3000);
    expect(document.title).toBe("Order 1042 · opendesk");
    stop();
    expect(document.title).toBe("Order 1042 · opendesk");
  });
});
