import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { Activity, CallData } from "@/lib/api/types";
import { callData } from "@/mock/phone";
import { CallEntry, clock, playLink, talkSeconds } from "./CallEntry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const entry = (over: Partial<CallData>): Activity => ({
  id: "a1",
  ticket_id: "t1",
  actor: { type: "system", user: null },
  type: "call",
  data: callData(over) as unknown as Record<string, unknown>,
  created_at: "2026-10-27T10:00:00Z",
});

async function render(a: Activity) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <CallEntry a={a} />
      </TooltipProvider>,
    ),
  );
  return container;
}

const agent = { id: "u1", name: "Anna Agent", email: "anna@example.com", avatar_url: null };

describe("call entry helpers", () => {
  it("formats talk time from the answer to the end", () => {
    expect(clock(190)).toBe("3:10");
    expect(clock(3725)).toBe("1:02:05");
    expect(talkSeconds({ answered_at: "2026-10-27T10:00:10Z", ended_at: "2026-10-27T10:03:20Z", duration: 999 })).toBe(190);
    expect(talkSeconds({ answered_at: null, ended_at: null, duration: 42 })).toBe(42);
  });

  it("plays the direct link while it lasts, then the provider's page, and never a non-https link", () => {
    const now = Date.parse("2026-10-27T10:00:00Z");
    expect(playLink("https://short/r", "https://asset/p", "2026-10-27T12:00:00Z", now)).toBe("https://short/r");
    expect(playLink("https://short/r", "https://asset/p", "2026-10-27T10:00:30Z", now)).toBe("https://asset/p");
    expect(playLink("http://short/r", "javascript:alert(1)", "2026-10-27T12:00:00Z", now)).toBeNull();
  });
});

describe("CallEntry", () => {
  it("shows an answered call: who took it, how long, its links, summary and transcript", async () => {
    const el = await render(
      entry({
        caller_name: "Lena Hoffmann",
        number: "+32470000000",
        line: "DE - Support",
        agent,
        answered_at: "2026-10-27T10:00:10Z",
        ended_at: "2026-10-27T10:03:20Z",
        duration: 200,
        recording: true,
        asset_url: "https://assets.aircall.io/calls/1/recording",
        summary: "Asked for a replacement.",
        transcript: "Agent: Hello",
        comments: [{ id: "1", text: "Follow up Friday", author: "Anna Agent" }],
        tags: ["Order"],
      }),
    );
    const text = el.textContent ?? "";
    expect(text).toContain("Lena Hoffmann called, Anna Agent answered");
    expect(text).toContain("Answered");
    expect(text).toContain("3:10");
    expect(text).toContain("Line DE - Support");
    expect(text).toContain("Asked for a replacement.");
    expect(text).toContain("Follow up Friday");
    expect(text).toContain("Order");
    const links = [...el.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Play recording", "https://assets.aircall.io/calls/1/recording"],
      ["Open in Aircall", "https://assets.aircall.io/calls/1/recording"],
    ]);
    expect(text).not.toContain("Agent: Hello");
    const toggle = [...el.querySelectorAll("button")].find((b) => b.textContent === "Show transcript")!;
    await act(async () => toggle.click());
    expect(el.textContent).toContain("Agent: Hello");
  });

  it("shows a missed call outside business hours with its reason", async () => {
    const el = await render(entry({ outcome: "missed", missed_reason: "out_of_opening_hours", number: "+32470123456", outside_hours: true, line: "FR - Support" }));
    const text = el.textContent ?? "";
    expect(text).toContain("Call from +32470123456");
    expect(text).toContain("Missed");
    expect(text).toContain("Outside business hours");
    expect(text).toContain("Outside opening hours");
    expect(el.querySelectorAll("a")).toHaveLength(0);
  });

  it("shows a ringing call, an outbound call and a withheld number", async () => {
    let el = await render(entry({ stage: "ringing", outcome: "", number: "" }));
    expect(el.textContent).toContain("Call from a withheld number");
    expect(el.textContent).toContain("Ringing");
    el = await render(entry({ direction: "outbound", outcome: "missed", agent, caller_name: "Lena Hoffmann" }));
    expect(el.textContent).toContain("Anna Agent called Lena Hoffmann");
    expect(el.textContent).toContain("No answer");
    el = await render(entry({ outcome: "voicemail", voicemail: true, voicemail_url: "https://short/v", links_expire_at: new Date(Date.now() + 3600_000).toISOString() }));
    expect(el.textContent).toContain("Voicemail");
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://short/v");
    // Without the provider's page there is nothing to open there; the play button stays.
    expect([...el.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Play voicemail"]);
  });

  it("never opens the provider's API link to the call", async () => {
    const el = await render(entry({ outcome: "missed", link: "https://api.aircall.io/v1/calls/1" } as Partial<CallData>));
    expect(el.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("a recording played through the app", () => {
  const voys = (over: Partial<CallData> = {}) => entry({ provider: "voys", recording: true, recording_stream: true, recording_url: "", ...over });
  const click = async (el: HTMLElement, id: string) => {
    await act(async () => (el.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click());
  };

  afterEach(() => vi.restoreAllMocks());

  it("offers a button, not a link, then plays the audio it fetched", async () => {
    const created: string[] = [];
    URL.createObjectURL = vi.fn(() => {
      created.push("blob:rec");
      return "blob:rec";
    });
    URL.revokeObjectURL = vi.fn();
    const spy = vi.spyOn(api.phone, "recording").mockResolvedValue({ blob: new Blob(["x"], { type: "audio/mpeg" }), filename: null });
    const el = await render(voys({ call_id: "call-1" }));
    expect(el.querySelectorAll("a")).toHaveLength(0);
    expect(el.querySelector("audio")).toBeNull();
    await click(el, "call-play-recording");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("call-1");
    expect(el.querySelector("audio")?.getAttribute("src")).toBe("blob:rec");
    expect(el.querySelector('[data-testid="call-play-recording"]')).toBeNull();
  });

  it("says when the recording is not ready and lets the agent try again", async () => {
    const spy = vi
      .spyOn(api.phone, "recording")
      .mockRejectedValue(new ApiError({ status: 409, code: "recording_not_ready", title: "Conflict", detail: "The recording is not ready yet." }));
    const el = await render(voys());
    await click(el, "call-play-recording");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("not ready yet");
    expect(el.querySelector('[data-testid="call-play-recording"]')?.textContent).toBe("Try again");
    await click(el, "call-play-recording");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps a direct link for a provider that gives one", async () => {
    const el = await render(entry({ recording: true, asset_url: "https://assets.aircall.io/calls/1/recording" }));
    expect(el.querySelector('[data-testid="call-play-recording"]')).toBeNull();
    expect(el.querySelectorAll("a").length).toBeGreaterThan(0);
  });
});
