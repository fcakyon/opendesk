// Split view (contracts/wiki.md "Split view"): a second page beside the one open, as Obsidian's
// panes. Where it is lives in the address (`/wiki/<page>?beside=<page>`), so a split is a link
// and survives a reload. These read and write that address; WikiPageView draws it.

/** What the page route's search holds. */
export type PageSearch = { comment?: string; beside?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?beside=` as the route reads it: a page id, never the page already open. */
export function parseBeside(raw: unknown, pageId?: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim().toLowerCase();
  return UUID.test(id) && id !== pageId?.toLowerCase() ? id : undefined;
}

/** The address with `id` beside `pageId`; opening the page itself beside it changes nothing. */
export function besideOf(pageId: string, search: PageSearch, id: string): { pageId: string; search: PageSearch } {
  return { pageId, search: id === pageId ? search : { ...search, beside: id } };
}

/** The address with the two pages swapped: the side page becomes the main one. */
export function swapped(pageId: string, beside: string): { pageId: string; search: PageSearch } {
  return { pageId: beside, search: { beside: pageId } };
}

/** The address without the side page. */
export function closed(search: PageSearch): PageSearch {
  const { beside: _, ...rest } = search;
  return rest;
}

/** The page a link goes to, when it is a wiki page of this app (`/wiki/<id>`, with or without the origin). */
export function pageIdOfHref(href: string | null | undefined, origin = typeof location === "undefined" ? "http://localhost" : location.origin): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const m = /^\/wiki\/([^/]+)\/?$/.exec(url.pathname);
  return m && UUID.test(m[1]) ? m[1].toLowerCase() : null;
}

/** A click that opens a page link beside: the main button with Alt (Option) and nothing else. */
export function isBesideClick(e: { button: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return e.button === 0 && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}
