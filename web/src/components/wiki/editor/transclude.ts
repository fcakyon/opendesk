// Synced blocks (contracts/wiki.md "Blocks"): what part of another page an embed shows,
// whether it may show here at all, and reading a pasted block link. Pure on HTML and ids,
// so the view and its tests share them.

import { isUuid } from "@/lib/wiki/desk";

/** How deep synced blocks nest inside each other before the next one shows a stub. */
export const MAX_EMBED_DEPTH = 3;

export type EmbedStop = "self" | "loop" | "deep";

/**
 * Why a synced block of page `id` can't show inside `chain` (the page being read first,
 * then each page an embed above this one shows), or null when it can: a page never shows
 * itself, a page already shown above would go round for ever, and the nesting stops at
 * MAX_EMBED_DEPTH.
 */
export function embedStop(chain: readonly string[], id: string): EmbedStop | null {
  const at = chain.findIndex((x) => x.toLowerCase() === id.toLowerCase());
  if (at === 0) return "self";
  if (at > 0) return "loop";
  if (chain.length > MAX_EMBED_DEPTH) return "deep";
  return null;
}

const HEADING = /^H([1-3])$/;

/** A heading's level: h1..h3, or a toggle heading (`<details data-heading>`); 0 for neither. */
function headingLevel(el: Element): number {
  const h = HEADING.exec(el.tagName);
  if (h) return Number(h[1]);
  if (el.tagName === "DETAILS") {
    const l = Number(el.getAttribute("data-heading"));
    return l >= 1 && l <= 3 ? l : 0;
  }
  return 0;
}

const parseBody = (html: string) => new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;

/**
 * The part of a page body a synced block shows: the block with that data-block-id, and
 * for a heading, the heading and everything after it up to the next heading of its level
 * or higher (Obsidian's ![[Note#Heading]]). A list item comes in a list of its kind. Null
 * when the page has no such block (it was deleted, or the page was never saved since).
 */
export function sectionOf(html: string, blockId: string): string | null {
  if (!isUuid(blockId)) return null;
  const body = parseBody(html);
  const el = body.querySelector(`[data-block-id="${blockId}"]`);
  if (!el) return null;
  if (el.tagName === "LI") {
    const list = el.parentElement?.cloneNode(false) as Element | undefined;
    if (!list) return el.outerHTML;
    list.append(el.cloneNode(true));
    return list.outerHTML;
  }
  const level = HEADING.test(el.tagName) ? headingLevel(el) : 0;
  if (!level) return el.outerHTML;
  const parts = [el.outerHTML];
  for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
    const l = headingLevel(next);
    if (l && l <= level) break;
    parts.push(next.outerHTML);
  }
  return parts.join("");
}

export type OutlineEntry = { id: string; level: number; text: string };

/** The headings of a page body a synced block can show (those with a block id), in order. */
export function outlineOf(html: string): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  parseBody(html)
    .querySelectorAll("h1, h2, h3, details[data-heading]")
    .forEach((el) => {
      const id = el.getAttribute("data-block-id") ?? "";
      const level = headingLevel(el);
      if (!isUuid(id) || !level) return;
      const text = (el.tagName === "DETAILS" ? el.querySelector("summary")?.textContent : el.textContent) ?? "";
      out.push({ id, level, text: text.replace(/\s+/g, " ").trim() });
    });
  return out;
}

/**
 * A link to a block of a page of this wiki ("Copy link to block": `<origin>/wiki/<page>#<block>`),
 * as pasted: the page and block ids, or null for anything else.
 */
export function parseBlockLink(text: string, origin: string): { id: string; block: string } | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const m = /^\/wiki\/([0-9a-fA-F-]{36})\/?$/.exec(url.pathname);
  const block = url.hash.replace(/^#/, "");
  if (!m || !isUuid(m[1]) || !isUuid(block)) return null;
  return { id: m[1].toLowerCase(), block: block.toLowerCase() };
}
