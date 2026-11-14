// The agent streams plain markdown with [n] citation markers (contracts/agent.md).
// The live preview renders a small, safe subset of it: paragraphs, line breaks,
// lists, bold, italic, inline code, code blocks and http(s) links. Everything
// becomes Preact text nodes and elements, never HTML strings, so a delta can't
// inject markup.

import { h, type ComponentChildren, type VNode } from "preact";
import { shortLabel } from "./links";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = VNode<any>;

const MARKER = /[ \t]*\[\d{1,3}(?:\s*,\s*\d{1,3})*\](?!\()/g;
const PARTIAL = /[ \t]*\[\d{0,3}(?:\s*,\s*\d{0,3})*$/;

/** Remove [n] / [1, 2] citation markers; while streaming, also a marker cut off at the end. */
export function stripMarkers(text: string, streaming = false): string {
  let s = text.replace(MARKER, "");
  if (streaming) s = s.replace(PARTIAL, "");
  return s;
}

/** While streaming, hide a dangling opener (`**`, `*` or a backtick) until its closer arrives. */
function settle(text: string): string {
  let s = text;
  if (((s.match(/```/g) ?? []).length & 1) === 1) return s; // inside a code block: leave it
  if (((s.match(/\*\*/g) ?? []).length & 1) === 1) {
    const i = s.lastIndexOf("**");
    s = s.slice(0, i) + s.slice(i + 2);
  }
  if (((s.replace(/```/g, "").match(/`/g) ?? []).length & 1) === 1) {
    const i = s.lastIndexOf("`");
    s = s.slice(0, i) + s.slice(i + 1);
  }
  // A trailing "[label](htt" link in progress shows its label only.
  s = s.replace(/\[([^\]\n]*)\]\([^)\s]*$/, "$1").replace(/\[([^\]\n]*)$/, "$1");
  return s;
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
// No lookbehind: the widget runs on older browsers too. Italic captures the character before it.
const INLINE = /(\*\*([^*\n]+?)\*\*)|(`([^`\n]+?)`)|(\[([^\]\n]+)\]\(([^)\s]+)\))|((^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*]))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function link(href: string, label: ComponentChildren, key: number): Node {
  return h("a", { key, href, target: "_blank", rel: "noopener noreferrer nofollow" }, label);
}

/** Inline markdown to nodes. */
export function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  let k = 0;
  // A fresh regex per call: the bold and link branches recurse.
  const re = new RegExp(INLINE.source, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h("strong", { key: k++ }, inline(m[2])));
    else if (m[3]) out.push(h("code", { key: k++ }, m[4]));
    else if (m[5]) out.push(SAFE_URL.test(m[7]) ? link(m[7], inline(m[6]), k++) : m[6]);
    else if (m[8]) {
      if (m[9]) out.push(m[9]);
      out.push(h("em", { key: k++ }, inline(m[10])));
    } else if (m[11]) out.push(link(m[11], shortLabel(m[11]), k++));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const UL = /^\s{0,3}[-*+]\s+(.*)$/;
const OL = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const HEAD = /^\s{0,3}#{1,6}\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}```/;

/** Markdown to Preact nodes. `streaming` hides markers and markup cut off mid-stream. */
export function renderMarkdown(src: string, streaming = false): Node[] {
  let text = stripMarkers(src.replace(/\r\n?/g, "\n"), streaming);
  if (streaming) text = settle(text);
  const lines = text.split("\n");
  const blocks: Node[] = [];
  let para: string[] = [];
  let k = 0;

  const flush = () => {
    if (!para.length) return;
    const kids: ComponentChildren[] = [];
    para.forEach((l, i) => {
      if (i) kids.push(h("br", { key: `b${i}` }));
      kids.push(...inline(l));
    });
    blocks.push(h("p", { key: k++ }, kids));
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      blocks.push(h("pre", { key: k++ }, h("code", null, code.join("\n"))));
      continue;
    }
    const list = UL.test(line) ? UL : OL.test(line) ? OL : null;
    if (list) {
      flush();
      const items: Node[] = [];
      for (; i < lines.length && list.test(lines[i]); i++) items.push(h("li", { key: items.length }, inline(list.exec(lines[i])![1])));
      i--;
      blocks.push(h(list === UL ? "ul" : "ol", { key: k++ }, items));
      continue;
    }
    const head = HEAD.exec(line);
    if (head) {
      flush();
      blocks.push(h("p", { key: k++ }, h("strong", null, inline(head[1]))));
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const q: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) q.push(QUOTE.exec(lines[i])![1]);
      i--;
      blocks.push(h("blockquote", { key: k++ }, inline(q.join(" "))));
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** Plain text of streamed markdown (for previews and screen readers). */
export function plainText(src: string): string {
  return stripMarkers(src)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
