// Addresses in a reply as short links. A reply often writes an address out in full, as plain
// text ("https://example.com/help/returns/start?order=1042&lang=en"): not clickable, and long in
// a narrow chat. On HTML already through safeHtml:
// - an address (https://, http://, www.) or an email in the text becomes a link;
// - a link that shows an address gets a short label: its host and its path when that is short,
//   else the path's first segments ("example.com/help/shipping", "example.com/help/returns/…");
// - a link with words of its own keeps them; code and existing links are left alone.
// The sentence's punctuation right after an address stays text. Only the display changes.

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}\b/g;
const ADDRESS = /^(?:https?:\/\/|www\.)\S+$/i;
const TRAILING = /[.,;:!?…'"»)\]}]$/;
const SKIP = new Set(["A", "CODE", "PRE"]);
const MAX = 40;

/** The address without the punctuation that ends the sentence around it. */
export function trimUrl(raw: string): string {
  let url = raw;
  while (url && TRAILING.test(url)) {
    // Keep a closing parenthesis the address opened: "…/wiki/Lamp_(design)".
    if (url.endsWith(")") && (url.match(/\(/g) ?? []).length >= (url.match(/\)/g) ?? []).length) break;
    url = url.slice(0, -1);
  }
  return url;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A short label for an address: its host, with its path when that is short, else the path's first segments. */
export function shortLabel(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href.length > MAX ? `${href.slice(0, MAX - 2)}…` : href;
  }
  const host = u.hostname.replace(/^www\./i, "");
  const path = decode(u.pathname).replace(/\/+$/, "");
  if (!path) return host;
  const full = `${host}${path}`;
  if (full.length <= MAX) return full;
  // As many leading segments as fit, then an ellipsis.
  let short = host;
  for (const seg of path.split("/").filter(Boolean)) {
    if (`${short}/${seg}/…`.length > MAX) break;
    short = `${short}/${seg}`;
  }
  return `${short}/…`;
}

function hrefOf(raw: string): string {
  return /^www\./i.test(raw) ? `https://${raw}` : raw;
}

function link(doc: Document, href: string, label: string): HTMLAnchorElement {
  const a = doc.createElement("a");
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer nofollow");
  a.textContent = label;
  return a;
}

type Hit = { start: number; end: number; href: string; label: string };

/** The text node's addresses and emails as links, the rest as text. */
function linkText(node: Text, doc: Document): void {
  const text = node.data;
  const hits: Hit[] = [];
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    const raw = trimUrl(m[0]);
    const href = hrefOf(raw);
    try {
      const u = new URL(href);
      // A real host: "www." or "https://localhost" alone stays text.
      if (!/^https?:$/.test(u.protocol) || !/^[^.]+(?:\.[^.]+)+$/.test(u.hostname)) continue;
    } catch {
      continue;
    }
    hits.push({ start: m.index, end: m.index + raw.length, href, label: shortLabel(href) });
  }
  EMAIL_RE.lastIndex = 0;
  for (let m = EMAIL_RE.exec(text); m; m = EMAIL_RE.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    if (hits.some((h) => start < h.end && end > h.start)) continue;
    hits.push({ start, end, href: `mailto:${m[0]}`, label: m[0] });
  }
  if (!hits.length) return;
  hits.sort((a, b) => a.start - b.start);
  const frag = doc.createDocumentFragment();
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue;
    if (h.start > at) frag.appendChild(doc.createTextNode(text.slice(at, h.start)));
    frag.appendChild(link(doc, h.href, h.label));
    at = h.end;
  }
  if (at < text.length) frag.appendChild(doc.createTextNode(text.slice(at)));
  node.parentNode?.replaceChild(frag, node);
}

function walk(el: Element, doc: Document): void {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      linkText(child as Text, doc);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const e = child as Element;
    if (e.tagName === "A") {
      // A link that shows an address shows where it goes, shortly.
      const href = e.getAttribute("href") ?? "";
      if (/^https?:/i.test(href) && ADDRESS.test((e.textContent ?? "").trim())) e.textContent = shortLabel(href);
      continue;
    }
    if (!SKIP.has(e.tagName)) walk(e, doc);
  }
}

/** Sanitized reply HTML with its addresses and emails as short-labelled links (see the top of the file). */
export function shortLinks(html: string): string {
  if (!html || !/https?:|www\.|@/i.test(html)) return html;
  const doc = document.implementation.createHTMLDocument("");
  const wrap = doc.createElement("div");
  wrap.innerHTML = html;
  walk(wrap, doc);
  return wrap.innerHTML;
}
