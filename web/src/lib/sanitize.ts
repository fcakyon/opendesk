// Client-side sanitizing for stored HTML (articles, messages). The server
// already sanitizes before storage; this is a second, strict layer before any
// dangerouslySetInnerHTML.

import DOMPurify, { type Config } from "dompurify";
import { config } from "./config";

const ALLOWED_TAGS = [
  "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "p", "br", "hr", "div", "span",
  "ul", "ol", "li", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "img", "figure", "figcaption", "sub", "sup", "small", "mark",
];
const ALLOWED_ATTR = ["href", "title", "alt", "src", "width", "height", "colspan", "rowspan", "class", "data-id", "target", "rel"];

// A designed email (sanitizeEmailHtml) keeps its styles, layout attributes and classes;
// it renders only in its own frame (EmailFrame), so none of it reaches the app.
const EMAIL_TAGS = [...ALLOWED_TAGS, "style", "center", "font", "caption", "col", "colgroup", "section", "article", "header", "footer", "abbr", "cite", "q", "tt", "big", "wbr", "dl", "dt", "dd"];
const EMAIL_ATTR = [...ALLOWED_ATTR, "style", "align", "valign", "bgcolor", "cellpadding", "cellspacing", "border", "color", "face", "size", "dir", "lang", "nowrap", "span", "scope"];

// In the app's own DOM a class could pick up the app's styles; only mentions keep theirs.
const APP_CLASSES = new Set(["mention"]);

// The pass in progress: whether classes stay, whether remote images are held back (and how
// many were), and whether links and images get the app's display attributes (off for HTML
// that is sent on as written: a signature in a composer), and whether images load at once
// rather than when scrolled to (a page about to print).
type Pass = { keepClasses: boolean; blockRemote: boolean; blocked: number; display?: boolean; eager?: boolean };
let pass: Pass | null = null;

const CSS_URL = /url\s*\(\s*(['"]?)([^'"()]*)\1\s*\)/gi;

/** Our own images: data and blob URLs, and attachments served by the API (inline images, a mail account's signed files). */
function ownImage(src: string): boolean {
  if (/^(data|blob):/i.test(src.trim())) return true;
  try {
    const u = new URL(src, location.href);
    const api = new URL(config.apiUrl || location.origin, location.href);
    return (u.origin === api.origin || u.origin === location.origin) && (u.pathname.startsWith("/v1/attachments/") || u.pathname.startsWith("/v1/collab/attachments/"));
  } catch {
    return false;
  }
}

/**
 * CSS with every url() that is not our own image replaced, counted on the pass. It fails
 * closed: CSS that could load an image some other way, or a url() it cannot read, is dropped.
 */
function holdBackCSS(css: string, p: Pass): string {
  if (/image-set|@import|@font-face|\bsrc\s*\(/i.test(css)) {
    p.blocked++;
    return "";
  }
  let seen = 0;
  const out = css.replace(CSS_URL, (whole, _q: string, url: string) => {
    seen++;
    if (ownImage(url)) return whole;
    p.blocked++;
    return "none";
  });
  if ((css.match(/url\s*\(/gi) ?? []).length !== seen) {
    p.blocked++;
    return "";
  }
  return out;
}

let hooked = false;
function ensureHook() {
  if (hooked) return;
  hooked = true;
  // The hooks are on DOMPurify's shared instance: they act only inside run(), never on
  // another library's sanitizing (Mermaid's diagrams keep the classes their styles need).
  DOMPurify.addHook("afterSanitizeElements", (node) => {
    if (!pass || !(node instanceof Element) || node.tagName !== "STYLE") return;
    const css = node.textContent ?? "";
    // As with style attributes: stored CSS has no escapes, so a sheet with one is dropped.
    if (css.includes("\\")) node.textContent = "";
    else if (pass?.blockRemote) node.textContent = holdBackCSS(css.replace(/@import[^;]*;?/gi, ""), pass);
  });
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!pass) return;
    if (!pass.keepClasses && node.hasAttribute("class")) {
      const kept = (node.getAttribute("class") ?? "").split(/\s+/).filter((c) => APP_CLASSES.has(c));
      if (kept.length) node.setAttribute("class", kept.join(" "));
      else node.removeAttribute("class");
    }
    if (node.hasAttribute("style")) {
      const style = node.getAttribute("style") ?? "";
      // Stored CSS has no escapes (the server drops them), so every url() is in plain sight.
      if (style.includes("\\")) node.removeAttribute("style");
      else if (pass?.blockRemote) {
        const held = holdBackCSS(style, pass);
        if (held) node.setAttribute("style", held);
        else node.removeAttribute("style");
      }
    }
    const display = pass?.display !== false;
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (/^\s*(javascript|data|vbscript):/i.test(href)) node.removeAttribute("href");
      if (display) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      }
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (!/^(https?:|blob:|data:image\/(png|gif|jpe?g|webp|svg\+xml);|\/)/i.test(src)) node.removeAttribute("src");
      else if (pass?.blockRemote && !ownImage(src)) {
        node.removeAttribute("src");
        node.setAttribute("data-od-held", "");
        pass.blocked++;
      }
      if (display) {
        node.setAttribute("loading", pass?.eager ? "eager" : "lazy");
        node.setAttribute("referrerpolicy", "no-referrer");
      }
    }
  });
}

const URI = /^(?:(?:https?|mailto|tel|blob):|data:image\/|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

function run(html: string, p: Pass, cfg: Config): string {
  ensureHook();
  pass = p;
  try {
    return DOMPurify.sanitize(html ?? "", cfg);
  } finally {
    pass = null;
  }
}

export type Sanitized = { html: string; held: number };

export type SanitizeOptions = {
  /** Hold back images that would load from another site (an inbound email, until the reader loads them). */
  blockRemoteImages?: boolean;
  /** Load images at once instead of when scrolled to: a page about to print waits for them. */
  eagerImages?: boolean;
};

/** HTML for the app's own DOM: plain formatting, no styles, only the app's own classes. */
export function sanitizeHtml(html: string): string {
  return sanitizeProse(html).html;
}

// Inline styles do not reach the app's DOM, so an email's emphasis set with them (Outlook's,
// Odoo's and most senders' bold, italic and underline) becomes the tags that carry it, and text
// the sender hid (a preheader: the inbox preview line, often padded with invisible characters)
// stays hidden instead of showing above the message.
const HIDDEN = /(^|;)\s*(display\s*:\s*none|mso-hide\s*:\s*all)\s*(!important\s*)?(;|$)/i;
const BOLD = /(^|;)\s*font-weight\s*:\s*(bold|bolder|[6-9]00)\b/i;
const ITALIC = /(^|;)\s*font-style\s*:\s*(italic|oblique)\b/i;
const UNDERLINE = /(^|;)\s*text-decoration(-line)?\s*:[^;]*\bunderline\b/i;
const EMPHASIS = new Set(["B", "STRONG", "H1", "H2", "H3", "H4", "H5", "H6", "TH"]);
// Elements whose children a wrapper may not hold (a table's rows, a list's items): their style is left as it is.
const STRUCTURE = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "COLGROUP", "UL", "OL", "DL", "SELECT"]);

function wrapChildren(el: Element, tag: string) {
  const w = el.ownerDocument.createElement(tag);
  while (el.firstChild) w.appendChild(el.firstChild);
  el.appendChild(w);
}

/** The emphasis an email's inline styles set, as tags, and its hidden text dropped (sanitizeProse's first pass). */
export function emphasizeInlineStyles(html: string): string {
  if (!html || !/\sstyle\s*=/i.test(html)) return html;
  const t = document.createElement("template");
  t.innerHTML = html;
  for (const el of Array.from(t.content.querySelectorAll("[style]"))) {
    const style = el.getAttribute("style") ?? "";
    if (HIDDEN.test(style)) {
      el.remove();
      continue;
    }
    if (STRUCTURE.has(el.tagName)) continue;
    if (UNDERLINE.test(style) && el.tagName !== "U" && el.tagName !== "A" && !el.closest("a")) wrapChildren(el, "u");
    if (ITALIC.test(style) && el.tagName !== "I" && el.tagName !== "EM") wrapChildren(el, "em");
    if (BOLD.test(style) && !EMPHASIS.has(el.tagName)) wrapChildren(el, "strong");
  }
  return t.innerHTML;
}

// A web address written as text (a note posted through the API, an email sent without links)
// becomes a link. Text inside a link, code, a script, a style, a text area or a button is left
// as it is; a closing bracket or punctuation after the address stays text ("(see https://example.com/a).").
const BARE_URL = /\bhttps?:\/\/[^\s<>"'()[\]{}]+[^\s<>"'()[\]{}.,;:!?]/gi;
const NOT_LINKED = "a, code, script, style, textarea, button";

/** html with every bare http(s) address in its text made a link (sanitizeProse's first pass; the sanitizer then opens it in a new tab). */
export function linkBareAddresses(html: string): string {
  if (!html || !/https?:\/\//i.test(html)) return html;
  const t = document.createElement("template");
  t.innerHTML = html;
  const walker = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    BARE_URL.lastIndex = 0;
    if (BARE_URL.test(n.nodeValue ?? "") && !n.parentElement?.closest(NOT_LINKED)) texts.push(n as Text);
  }
  if (!texts.length) return html;
  for (const n of texts) {
    const s = n.nodeValue ?? "";
    const parts = document.createDocumentFragment();
    let at = 0;
    BARE_URL.lastIndex = 0;
    for (let m = BARE_URL.exec(s); m; m = BARE_URL.exec(s)) {
      if (m.index > at) parts.append(s.slice(at, m.index));
      const a = document.createElement("a");
      a.setAttribute("href", m[0]);
      a.textContent = m[0];
      parts.append(a);
      at = m.index + m[0].length;
    }
    if (at < s.length) parts.append(s.slice(at));
    n.replaceWith(parts);
  }
  return t.innerHTML;
}

export function sanitizeProse(html: string, opts: SanitizeOptions = {}): Sanitized {
  const p: Pass = { keepClasses: false, blockRemote: !!opts.blockRemoteImages, blocked: 0, eager: opts.eagerImages };
  const out = run(linkBareAddresses(emphasizeInlineStyles(html)), p, { ALLOWED_TAGS, ALLOWED_ATTR: [...ALLOWED_ATTR, "loading", "referrerpolicy"], ALLOW_DATA_ATTR: false, ALLOWED_URI_REGEXP: URI });
  return { html: out, held: p.blocked };
}

/** A designed email for its own frame (EmailFrame): styles, layout attributes and classes stay. */
export function sanitizeEmailHtml(html: string, opts: SanitizeOptions = {}): Sanitized {
  const p: Pass = { keepClasses: true, blockRemote: !!opts.blockRemoteImages, blocked: 0, eager: opts.eagerImages };
  const out = run(html, p, {
    ALLOWED_TAGS: EMAIL_TAGS,
    ALLOWED_ATTR: [...EMAIL_ATTR, "loading", "referrerpolicy"],
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true,
    ALLOWED_URI_REGEXP: URI,
  });
  return { html: out, held: p.blocked };
}

/**
 * A signature as it goes out: the email allowlist (tables, styles, sized images, classes)
 * and nothing added, so a composer sends the stored signature as it is.
 */
export function cleanSignatureHtml(html: string): string {
  const p: Pass = { keepClasses: true, blockRemote: false, blocked: 0, display: false };
  return run(html, p, { ALLOWED_TAGS: EMAIL_TAGS.filter((t) => t !== "style"), ALLOWED_ATTR: EMAIL_ATTR, ALLOW_DATA_ATTR: false, ALLOWED_URI_REGEXP: URI });
}

/** A designed email: laid out with tables or painted backgrounds, which the app's prose would flatten. */
export function isDesignedEmail(html: string): boolean {
  return /<table[\s>]|\sbgcolor=|background(-color|-image)?\s*:/i.test(html ?? "");
}
