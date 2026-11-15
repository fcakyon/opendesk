import { describe, expect, it } from "vitest";
import { besideOf, closed, isBesideClick, pageIdOfHref, parseBeside, swapped } from "./split";

const A = "0b7f6c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const B = "1c8a7d2f-2e3b-4d4c-8f9a-1b2c3d4e5f6a";

describe("split view address", () => {
  it("reads ?beside= as a page id, never the open page or anything else", () => {
    expect(parseBeside(B, A)).toBe(B);
    expect(parseBeside(B.toUpperCase(), A)).toBe(B);
    expect(parseBeside(A, A)).toBeUndefined();
    expect(parseBeside("not-a-page", A)).toBeUndefined();
    expect(parseBeside(42, A)).toBeUndefined();
    expect(parseBeside(undefined, A)).toBeUndefined();
  });

  it("opens beside, swaps and closes, keeping the rest of the search", () => {
    expect(besideOf(A, { comment: "t1" }, B)).toEqual({ pageId: A, search: { comment: "t1", beside: B } });
    expect(besideOf(A, { beside: B }, A)).toEqual({ pageId: A, search: { beside: B } });
    expect(swapped(A, B)).toEqual({ pageId: B, search: { beside: A } });
    expect(closed({ comment: "t1", beside: B })).toEqual({ comment: "t1" });
  });

  it("finds the page a link goes to, only on this app", () => {
    const origin = "https://app.example.com";
    expect(pageIdOfHref(`/wiki/${A}`, origin)).toBe(A);
    expect(pageIdOfHref(`${origin}/wiki/${A}#block`, origin)).toBe(A);
    expect(pageIdOfHref(`/wiki/${A}?beside=${B}`, origin)).toBe(A);
    expect(pageIdOfHref("/wiki/graph", origin)).toBeNull();
    expect(pageIdOfHref(`https://evil.example.com/wiki/${A}`, origin)).toBeNull();
    expect(pageIdOfHref(`/tickets/${A}`, origin)).toBeNull();
    expect(pageIdOfHref(null, origin)).toBeNull();
  });

  it("opens beside on Alt+click alone, leaving Mod+click to the browser's new tab", () => {
    const click = { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(isBesideClick({ ...click, altKey: true })).toBe(true);
    expect(isBesideClick(click)).toBe(false);
    expect(isBesideClick({ ...click, metaKey: true })).toBe(false);
    expect(isBesideClick({ ...click, altKey: true, shiftKey: true })).toBe(false);
    expect(isBesideClick({ ...click, altKey: true, button: 1 })).toBe(false);
  });
});
