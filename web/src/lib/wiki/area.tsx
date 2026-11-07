// Areas (contracts/pages.md): the wiki's tree and Pages', the product of the workspace's own
// pages beside it. Both are the same engine; a view reads the area it is in from AreaProvider
// (the /wiki and /pages layouts, the main sidebar's Pages section) and a page carries its own.

import { createContext, useContext, type ReactNode } from "react";
import type { WikiArea, WikiNode } from "@/lib/api/types";
import { useProducts } from "@/lib/products";

const AreaCtx = createContext<WikiArea>("wiki");

export function AreaProvider({ area, children }: { area: WikiArea; children: ReactNode }) {
  return <AreaCtx.Provider value={area}>{children}</AreaCtx.Provider>;
}

/** The area the view is in: the wiki's unless a Pages view says so. */
export function useArea(): WikiArea {
  return useContext(AreaCtx);
}

/**
 * Where something new goes when nothing inside an area asked (the header's New menu, the
 * command menu, the main sidebar): Pages', or the wiki's while the workspace has Pages off.
 */
export function useDefaultArea(asked?: WikiArea): WikiArea {
  const pages = useProducts().pages;
  return pages ? (asked ?? "pages") : "wiki";
}

/** A page's area: the wiki's when it says none (a page from before Pages). */
export function areaOf(n: Pick<WikiNode, "area"> | null | undefined): WikiArea {
  return n?.area ?? "wiki";
}

/** Whether a node is in area. */
export const inArea = (area: WikiArea) => (n: Pick<WikiNode, "area">) => areaOf(n) === area;

/** Where a page opens: /pages/<id> for Pages', /wiki/<id> for the wiki's. */
export function pageTo(n: Pick<WikiNode, "id" | "area">) {
  return areaOf(n) === "pages" ? ({ to: "/pages/$pageId", params: { pageId: n.id } } as const) : ({ to: "/wiki/$pageId", params: { pageId: n.id } } as const);
}

/** An area's home. */
export const areaHome = (area: WikiArea) => (area === "pages" ? "/pages" : "/wiki");

type Place = "graph" | "tags" | "templates" | "trash";

/** One of an area's own pages: its graph, tags, templates or trash. */
export function areaPath<P extends Place>(area: WikiArea, place: P): `/pages/${P}` | `/wiki/${P}` {
  return area === "pages" ? `/pages/${place}` : `/wiki/${place}`;
}
