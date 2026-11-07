import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/shortcuts.json";
import {
  allConflicts,
  bindingOf,
  cleanBindings,
  clash,
  conflictsFor,
  displayKeys,
  isBinding,
  SHORTCUT_LIST,
  setShortcutBindings,
  useShortcuts,
  type ShortcutHandlers,
} from "./shortcuts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the registry", () => {
  it("has no two shortcuts that would catch the same press where both are on", () => {
    expect(allConflicts()).toEqual([]);
  });

  it("has unique ids, valid default keys and a label for each", () => {
    const ids = SHORTCUT_LIST.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const items = en.items as Record<string, Record<string, string>>;
    for (const s of SHORTCUT_LIST) {
      if (!s.fixed) expect(isBinding(s.keys), `${s.id}: ${s.keys}`).toBe(true);
      const [group, name] = s.id.split(".");
      expect(items[group!]?.[name!], s.id).toBeTruthy();
    }
  });
});

describe("the key grammar", () => {
  it("takes keys, chords and two steps", () => {
    for (const ok of ["k", "?", "mod+k", "mod+shift+p", "alt+shift+n", "g p", "shift+s", "f2", "mod+shift+arrowup", "mod+[", "mod+\\", "mod++"]) expect(isBinding(ok), ok).toBe(true);
  });

  it("refuses modifiers out of order, twice, alone, a symbol with shift, three steps and a chord before a second step", () => {
    for (const bad of ["", "shift+mod+k", "mod+mod+k", "mod+", "shift+?", "g p q", "mod+k p", "ctrl+k", "foo", "g  p"]) expect(isBinding(bad), bad).toBe(false);
  });

  it("shows keys as the Kbd component reads them", () => {
    expect(displayKeys("mod+shift+p")).toBe("mod shift p");
    expect(displayKeys("g p")).toBe("g p");
    expect(displayKeys("mod+shift+arrowup")).toBe("mod shift ↑");
    expect(displayKeys("escape")).toBe("esc");
  });

  it("knows when two bindings catch the same press", () => {
    expect(clash("g p", "g p")).toBe(true);
    expect(clash("g", "g p")).toBe(true);
    expect(clash("g p", "g")).toBe(true);
    expect(clash("g p", "g d")).toBe(false);
    expect(clash("p", "g p")).toBe(false);
  });
});

describe("rebinding", () => {
  afterEach(() => setShortcutBindings({}));

  it("uses the person's keys, falls back to the default and turns a shortcut off with null", () => {
    expect(bindingOf("go.pages")).toBe("g p");
    setShortcutBindings({ "go.pages": "g o", "go.wiki": null });
    expect(bindingOf("go.pages")).toBe("g o");
    expect(bindingOf("go.wiki")).toBeNull();
  });

  it("keeps the editor's own keys as they are and drops unknown ids and bad keys", () => {
    expect(cleanBindings({ "editor.bold": "mod+y", "nope.nope": "x", "go.pages": "shift+?", "go.wiki": "g q" })).toEqual({ "go.wiki": "g q" });
    setShortcutBindings({ "editor.bold": "mod+y" });
    expect(bindingOf("editor.bold")).toBe("mod+b");
  });

  it("names what a new binding would clash with, in scopes that are on together", () => {
    expect(conflictsFor("go.pages", "g w").map((s) => s.id)).toEqual(["go.wiki"]);
    expect(conflictsFor("go.pages", "g").map((s) => s.id)).toContain("go.wiki");
    // A page's key and a ticket's never are on at once.
    expect(conflictsFor("page.new", "n").map((s) => s.id)).toEqual([]);
    expect(conflictsFor("ticket.note", "c").map((s) => s.id)).toEqual(["global.new"]);
    // A turned-off shortcut frees its keys.
    setShortcutBindings({ "go.wiki": null });
    expect(conflictsFor("go.pages", "g w")).toEqual([]);
  });
});

describe("useShortcuts", () => {
  let host: HTMLDivElement;
  let root: Root;

  function Page({ handlers }: { handlers: ShortcutHandlers }) {
    useShortcuts(handlers);
    return null;
  }

  const press = (key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    act(() => setShortcutBindings({}));
  });

  it("runs a handler by id on its default keys, steps included", async () => {
    const go = vi.fn();
    const ollie = vi.fn();
    await act(async () => root.render(<Page handlers={{ "go.pages": go, "global.ollie": ollie }} />));
    press("g");
    expect(press("p")).toBe(true);
    expect(go).toHaveBeenCalledTimes(1);
    press("j", { ctrlKey: true });
    expect(ollie).toHaveBeenCalledTimes(1);
  });

  it("follows a rebind at once, and leaves the old keys alone", async () => {
    const go = vi.fn();
    await act(async () => root.render(<Page handlers={{ "go.pages": go }} />));
    act(() => setShortcutBindings({ "go.pages": "mod+shift+o" }));
    press("g");
    press("p");
    expect(go).not.toHaveBeenCalled();
    press("o", { ctrlKey: true, shiftKey: true });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("tells shift with a letter apart from the letter", async () => {
    const star = vi.fn();
    const unread = vi.fn();
    await act(async () => root.render(<Page handlers={{ "mail.star": star, "mail.unread": unread }} />));
    press("U", { shiftKey: true });
    expect(unread).toHaveBeenCalledTimes(1);
    expect(star).not.toHaveBeenCalled();
    press("s");
    expect(star).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a shortcut turned off, or a falsy handler", async () => {
    const go = vi.fn();
    await act(async () => root.render(<Page handlers={{ "go.wiki": go, "go.pages": false }} />));
    act(() => setShortcutBindings({ "go.wiki": null }));
    press("g");
    expect(press("w")).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });
});
