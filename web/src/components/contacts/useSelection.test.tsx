import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useSelection, type Selection } from "./useSelection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("ticks rows, a whole page, and everyone who matches, and drops them when the list changes", async () => {
  let current!: Selection;
  function Probe({ listKey }: { listKey: string }) {
    current = useSelection(listKey);
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Probe listKey="a" />));

  await act(async () => current.toggle("1"));
  await act(async () => current.toggle("2"));
  expect(current.ids).toEqual(["1", "2"]);
  await act(async () => current.toggle("1"));
  expect(current.has("1")).toBe(false);

  // The header ticks every row shown, then unticks them all.
  await act(async () => current.togglePage(["1", "2", "3"]));
  expect([...current.ids].sort()).toEqual(["1", "2", "3"]);
  await act(async () => current.togglePage(["1", "2", "3"]));
  expect(current.ids).toEqual([]);

  await act(async () => current.togglePage(["1"]));
  await act(async () => current.selectAllMatching());
  expect(current.allMatching).toBe(true);
  // Ticking a row again goes back to rows.
  await act(async () => current.toggle("2"));
  expect(current.allMatching).toBe(false);

  // Another search or filter is another list: nothing carries over.
  await act(async () => root.render(<Probe listKey="b" />));
  expect(current.ids).toEqual([]);
  expect(current.allMatching).toBe(false);
  await act(async () => root.unmount());
});
