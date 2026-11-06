// Links and #tags of a page body, as the API keeps them (internal/helpdesk/wiki/links.go):
// the mock uses these, and the editor shows tags the same way.

const LINK = /(?:\/wiki\/|data-id=")([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;
const CODE = /<code\b[^>]*>[^<]*<\/code>/gi;
/** A tag: # then letters, digits, _, / and -, with at least one letter ("#42" is a number). */
export const TAG = /(?:^|\s)#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu;

export function linkedIds(html: string): string[] {
  return [...new Set([...html.matchAll(LINK)].map((m) => m[1].toLowerCase()))];
}

export function pageTags(html: string, toText: (html: string) => string): string[] {
  const out: string[] = [];
  for (const m of toText(html.replace(CODE, " ")).matchAll(TAG)) {
    const tag = m[1].toLowerCase().replace(/^[/-]+|[/-]+$/g, "");
    if (tag && [...tag].length <= 64 && !out.includes(tag)) out.push(tag);
    if (out.length === 50) break;
  }
  return out;
}
