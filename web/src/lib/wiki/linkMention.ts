// Turning an unlinked mention into a link (contracts/wiki.md "Links and tags"): the first
// place another page's text names this one, outside links and code, becomes a link to it.
// Pure on HTML so the panel and its test share it.

const SKIP = new Set(["A", "CODE", "PRE", "TIME"]);

/** The body with its first mention of title linked to page id, or null when none is found. */
export function linkFirstMention(html: string, title: string, id: string): string | null {
  const name = title.trim();
  if (!name) return null;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\p{L}\\p{N}])`, "iu");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      for (let p = n.parentElement; p && p !== doc.body; p = p.parentElement) {
        if (SKIP.has(p.tagName) || p.getAttribute("data-type") === "mention") return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const m = re.exec(n.data);
    if (!m) continue;
    const start = m.index + m[1].length;
    const found = n.splitText(start);
    found.splitText(m[2].length);
    const a = doc.createElement("a");
    a.setAttribute("data-type", "page");
    a.setAttribute("data-id", id);
    a.setAttribute("href", `/wiki/${id}`);
    a.textContent = found.data;
    found.replaceWith(a);
    return doc.body.innerHTML;
  }
  return null;
}
