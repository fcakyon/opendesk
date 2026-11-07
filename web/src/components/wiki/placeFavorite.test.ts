import { describe, expect, it } from "vitest";
import type { WikiNode } from "@/lib/api/types";
import { placeFavorite } from "./hooks";

const node = (id: string) => ({ id }) as WikiNode;
const ids = (list: WikiNode[]) => list.map((n) => n.id);

describe("placing a favorite page", () => {
  const list = [node("a"), node("b"), node("c")];
  it("stars a page where it is dropped, or last", () => {
    expect(ids(placeFavorite(list, node("x"), "b"))).toEqual(["a", "x", "b", "c"]);
    expect(ids(placeFavorite(list, node("x"), null))).toEqual(["a", "b", "c", "x"]);
  });
  it("moves a starred page once, and stays put dropped on itself or on something gone", () => {
    expect(ids(placeFavorite(list, node("c"), "a"))).toEqual(["c", "a", "b"]);
    expect(ids(placeFavorite(list, node("a"), null))).toEqual(["b", "c", "a"]);
    expect(ids(placeFavorite(list, node("b"), "zz"))).toEqual(["a", "b", "c"]);
    expect(ids(placeFavorite(list, node("b"), "b"))).toEqual(["a", "b", "c"]);
    expect(ids(placeFavorite(list, node("x"), "zz"))).toEqual(["a", "b", "c", "x"]);
  });
});
