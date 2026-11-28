// The visitor verifies the address they gave in the email form (contracts/api.md "Contact
// verification"): one link goes out, the chat goes on, resending waits, and contact.verified
// turns the notice into a confirmation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Controller } from "./controller";
import { createMock, demoConfig } from "./mock";

describe("verification", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = async () => {
    const mock = createMock({ seed: "empty", latency: 5 });
    const c = new Controller({ base: "https://mock.invalid", key: "wk_demo", fetcher: mock.fetch, socketFactory: mock.socket, persist: false });
    const boot = c.boot({ ...demoConfig("wk_demo"), require_email: true });
    await vi.advanceTimersByTimeAsync(100);
    await boot;
    return { mock, c };
  };

  it("emails one link when the form is sent, and lets the visitor keep chatting", async () => {
    const { mock, c } = await setup();
    expect(c.needsEmail()).toBe(true);
    expect(c.store.get().session?.verification?.status).toBe("none");

    const sent = c.captureEmail("Ada", "ada@example.com");
    await vi.advanceTimersByTimeAsync(100);
    await sent;
    const s = c.store.get();
    expect(c.needsEmail()).toBe(false);
    expect(s.session?.verification).toMatchObject({ status: "unverified", email: "ada@example.com" });
    expect(s.session?.verification?.sent_at).toBeTruthy();
    expect(mock.verificationLinks).toBe(1);

    // Asking again while the link still works sends nothing.
    const again = c.requestVerification(false);
    await vi.advanceTimersByTimeAsync(50);
    await again;
    expect(mock.verificationLinks).toBe(1);

    // Unverified, the chat goes on.
    c.newConversation();
    const msg = c.send("Where is my order?", []);
    await vi.advanceTimersByTimeAsync(100);
    await msg;
    expect(c.store.get().active).toBeTruthy();
    mock.dispose();
    c.stop();
  });

  it("waits before resending, then sends another", async () => {
    const { mock, c } = await setup();
    const sent = c.captureEmail("", "ada@example.com");
    await vi.advanceTimersByTimeAsync(100);
    await sent;

    const soon = c.requestVerification(true);
    await vi.advanceTimersByTimeAsync(50);
    await soon;
    expect(c.store.get().verify.note).toBe("wait");
    expect(mock.verificationLinks).toBe(1);

    await vi.advanceTimersByTimeAsync(61_000);
    const later = c.requestVerification(true);
    await vi.advanceTimersByTimeAsync(50);
    await later;
    expect(c.store.get().verify.note).toBe("resent");
    expect(mock.verificationLinks).toBe(2);
    mock.dispose();
    c.stop();
  });

  it("turns verified when the visitor opens the link, and sends nothing more", async () => {
    const { mock, c } = await setup();
    const sent = c.captureEmail("", "ada@example.com");
    await vi.advanceTimersByTimeAsync(100);
    await sent;
    const said: string[] = [];
    c.announce = (text) => said.push(text);

    expect(mock.verify()).toBe(true);
    const s = c.store.get();
    expect(s.session?.verification?.status).toBe("verified");
    expect(s.verify.verifiedNow).toBe(true);
    expect(said).toEqual(["Your email address is confirmed"]);

    const after = c.requestVerification(true);
    await vi.advanceTimersByTimeAsync(61_000);
    await after;
    expect(mock.verificationLinks).toBe(1);
    mock.dispose();
    c.stop();
  });

  it("starts over as a new visitor when the chat went to the contact that has the address", async () => {
    const { mock, c } = await setup();
    const sent = c.captureEmail("Ada", "ada@example.com");
    await vi.advanceTimersByTimeAsync(100);
    await sent;
    c.newConversation();
    const msg = c.send("Where is my order?", []);
    await vi.advanceTimersByTimeAsync(100);
    await msg;
    const before = c.store.get().session!;
    const said: string[] = [];
    c.announce = (text) => said.push(text);

    expect(mock.verify(true)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    const s = c.store.get();
    // The old session ended with the merged contact: a new one, of a new visitor, with nothing of the old.
    expect(s.session?.contact.id).not.toBe(before.contact.id);
    expect(s.session?.contact.email).toBeNull();
    expect(s.view).toBe("home");
    expect(s.active).toBeNull();
    expect(s.conversations).toEqual([]);
    expect(s.verify.merged).toBe("ada@example.com");
    expect(said[0]).toContain("ada@example.com");
    mock.dispose();
    c.stop();
  });

  it("ignores another contact's verification", async () => {
    const { mock, c } = await setup();
    const sent = c.captureEmail("", "ada@example.com");
    await vi.advanceTimersByTimeAsync(100);
    await sent;
    c.onEvent({ id: "e1", seq: 1, type: "contact.verified", data: { contact_id: "someone-else", verification: { status: "verified" } } });
    expect(c.store.get().session?.verification?.status).toBe("unverified");
    mock.dispose();
    c.stop();
  });
});
