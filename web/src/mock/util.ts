// Small helpers shared by the mock backend: a seeded RNG, ids and time.

import { z } from "zod";

const guid = z.guid();

/** UUID references use the forms accepted by Go uuid.Parse, including arbitrary 38-byte wrappers. */
export function parseUUID(value: string): string | undefined {
  let canonical = value;
  if (value.length === 45 && value.slice(0, 9).toLowerCase() === "urn:uuid:") canonical = value.slice(9);
  else if (value.length === 38) canonical = value.slice(1, 37);
  else if (value.length === 32) canonical = `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  return guid.safeParse(canonical).success ? canonical.toLowerCase() : undefined;
}

let rngState = 0x2f6e2b1;

/** Deterministic PRNG (mulberry32) so the seed is identical on every load. */
export function rand(): number {
  rngState |= 0;
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function reseed(n: number) {
  rngState = n;
}

export function int(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

export function chance(p: number): boolean {
  return rand() < p;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let idCounter = 0;
/** UUID-shaped, deterministic during seeding, unique afterwards. */
export function uuid(): string {
  idCounter++;
  const hex = (n: number, len: number) => n.toString(16).padStart(len, "0").slice(-len);
  const a = Math.floor(rand() * 0xffffffff);
  const b = Math.floor(rand() * 0xffff);
  const c = Math.floor(rand() * 0xfff);
  const d = Math.floor(rand() * 0x3fff) | 0x8000;
  return `${hex(a, 8)}-${hex(b, 4)}-4${hex(c, 3)}-${hex(d, 4)}-${hex(idCounter, 4)}${hex(Math.floor(rand() * 0xffffffff), 8)}`;
}

/** uuid v7-ish for event ids: time ordered. */
export function uuid7(): string {
  const ms = Date.now().toString(16).padStart(12, "0");
  const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${r().slice(1)}-${r()}-${r()}${r()}${r()}`;
}

export function randomToken(len = 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  // 64 characters: masking each random byte to 6 bits picks every one alike.
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(len))) s += chars[b & 63];
  return s;
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const NOW = Date.now();

export function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Article HTML as running prose: headings dropped, and every paragraph and list item
 * ends as a sentence, so a passage can be quoted whole.
 */
export function htmlToProse(html: string): string {
  return html
    .replace(/<h\d[^>]*>[\s\S]*?<\/h\d>/gi, " ")
    .split(/<\/(?:p|li|div|blockquote)>/i)
    .map((b) => stripHtml(b))
    .filter(Boolean)
    .map((b) => (/[.!?:]$/.test(b) ? b : `${b}.`))
    .join(" ");
}

/** Whole sentences of `text`, as many as fit in `max` characters (at least the first). */
export function sentencesUpTo(text: string, max: number): string {
  const out: string[] = [];
  let len = 0;
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (out.length && len + sentence.length + 1 > max) break;
    out.push(sentence);
    len += sentence.length + 1;
  }
  return out.join(" ");
}

const TEXT_BREAKS = new Set(["BR", "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "DIV", "BLOCKQUOTE"]);

/** HTML's text, one line: the browser's parser reads it inert, blocks end with a space. */
export function stripHtml(html: string): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? "";
      return;
    }
    const tag = (n as Element).tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return;
    n.childNodes.forEach(walk);
    if (TEXT_BREAKS.has(tag)) out += " ";
  };
  walk(new DOMParser().parseFromString(html, "text/html").body);
  return out.replace(/\s+/g, " ").trim();
}

export function preview(html: string): string {
  const t = stripHtml(html);
  return t.length > 140 ? `${t.slice(0, 139)}…` : t;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function textToHtml(s: string): string {
  return s
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function avatarFor(_name: string): string {
  // Empty string: the app renders monochrome initials.
  return "";
}

/** Control characters other than newline and tab. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u001f\u007f]/;

/** True when `s` holds a control character (newline and tab allowed when `multiline`). */
export function hasControl(s: string, multiline = false): boolean {
  return (multiline ? CONTROL : CONTROL_ALL).test(s);
}

/** Strips control characters other than newline and tab. */
export function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** One line of plain text: trimmed, whitespace runs collapsed. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A tiny markdown renderer for mock AI output: paragraphs, lists, bold and links. Drops [n] citation markers. */
export function markdownToHtml(md: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '<a href="$2">$1</a>');
  return stripCitations(md)
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim());
      if (lines.length && lines.every((l) => /^\s*[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
      if (lines.length && lines.every((l) => /^\s*\d+\. /.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\. /, ""))}</li>`).join("")}</ol>`;
      return lines.length ? `<p>${lines.map(inline).join("<br>")}</p>` : "";
    })
    .join("");
}

/** Removes `[n]` citation markers and the space before them. */
export function stripCitations(s: string): string {
  return s.replace(/ ?\[\d+\]/g, "");
}
