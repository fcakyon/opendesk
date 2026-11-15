import { describe, expect, it } from "vitest";
import { recorder, stepOf } from "./shortcutRecorder";
import { scopesOf } from "./shortcutLabels";

const ev = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe("recording keys", () => {
  it("names a press as the registry writes it, and skips a modifier alone", () => {
    expect(stepOf(ev("k", { ctrlKey: true }))).toBe("mod+k");
    expect(stepOf(ev("P", { ctrlKey: true, shiftKey: true }))).toBe("mod+shift+p");
    expect(stepOf(ev("?", { shiftKey: true }))).toBe("?");
    expect(stepOf(ev("F2"))).toBe("f2");
    expect(stepOf(ev("Shift", { shiftKey: true }))).toBeNull();
    expect(stepOf(ev("Control", { ctrlKey: true }))).toBeNull();
  });

  it("takes a chord at once, and a plain key with what follows it", () => {
    const r = recorder();
    expect(r.press("mod+k")).toBe("mod+k");
    expect(r.press("g")).toBeNull();
    expect(r.press("p")).toBe("g p");
    // A chord can follow a plain key; it just can't come first.
    expect(r.press("g")).toBeNull();
    expect(r.press("mod+k")).toBe("g mod+k");
  });

  it("keeps a single key when nothing follows", () => {
    const r = recorder();
    expect(r.press("n")).toBeNull();
    expect(r.flush()).toBe("n");
    expect(r.flush()).toBeNull();
  });
});

describe("where the person is", () => {
  it("knows the shortcuts of each page", () => {
    expect(scopesOf("/inbox/unassigned")).toEqual(["tickets"]);
    expect(scopesOf("/inbox/unassigned/1f0c")).toEqual(["ticket", "tickets"]);
    expect(scopesOf("/mail/inbox")).toEqual(["mail"]);
    expect(scopesOf("/pages/1f0c")).toEqual(["page", "editor", "database", "canvas"]);
    expect(scopesOf("/pages/graph")).toEqual([]);
    expect(scopesOf("/settings/ai/bots/x")).toEqual(["bots"]);
    expect(scopesOf("/reports")).toEqual([]);
  });
});
