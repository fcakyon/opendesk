// Ollie writing in the wiki (contracts/ai.md, POST /v1/wiki/ai/write): what each ask sends,
// what it costs, and the preview it streams into. The preview keeps the latest run only:
// a "Try again" starts a new run, and anything the old one still sends is ignored.

import type { AIFeature, WikiWriteInput, WikiWriteMode } from "../api/types";

/** What Ollie does with selected text, in the order the menu offers it. */
export const SELECTION_MODES = ["improve", "fix_grammar", "shorter", "longer", "simplify", "more_formal", "friendlier", "summarize", "action_items", "explain"] as const satisfies readonly WikiWriteMode[];

/** What Ollie writes at an empty line, from the page around it. */
export const PAGE_MODES = ["continue", "summarize"] as const satisfies readonly WikiWriteMode[];

/** Edits of a selection run on the fast model and cost a rewrite; writing from a page costs more. */
const EDITS = new Set<WikiWriteMode>(["improve", "fix_grammar", "shorter", "longer", "simplify", "more_formal", "friendlier", "action_items", "explain"]);

export function costFeature(mode: WikiWriteMode): AIFeature {
  return EDITS.has(mode) ? "rewrite" : "wiki_write";
}

/** Where the result goes: over a selection, or at the cursor on an empty line. */
export type OllieTarget = { kind: "selection"; from: number; to: number } | { kind: "cursor"; pos: number };

export type OllieAsk = { mode: WikiWriteMode; instructions?: string };

/** The page as the request needs it: its title, its HTML, the HTML before the cursor and the selection. */
export type OllieSource = { title: string; page: string; before: string; selection: string };

export function writeRequest(ask: OllieAsk, target: OllieTarget["kind"], src: OllieSource): WikiWriteInput {
  const title = src.title.trim() || undefined;
  const instructions = ask.instructions?.trim() || undefined;
  if (target === "selection") return { mode: ask.mode, html: src.selection, title, instructions: ask.mode === "custom" ? instructions : undefined };
  // At the cursor: "continue" reads what comes before it; the rest read the whole page.
  return { mode: ask.mode, context_html: ask.mode === "continue" ? src.before : src.page, title, instructions: ask.mode === "custom" ? instructions : undefined };
}

export type Preview =
  | { status: "idle" }
  | { status: "writing"; run: number; ask: OllieAsk; text: string }
  | { status: "done"; run: number; ask: OllieAsk; html: string }
  /** `stopped`: the person stopped it; otherwise the call failed. */
  | { status: "failed"; run: number; ask: OllieAsk; stopped: boolean };

export type PreviewAction =
  | { type: "start"; run: number; ask: OllieAsk }
  | { type: "delta"; run: number; soFar: string }
  | { type: "done"; run: number; html: string }
  | { type: "fail"; run: number; stopped?: boolean }
  | { type: "reset" };

export function previewReducer(s: Preview, a: PreviewAction): Preview {
  if (a.type === "start") return { status: "writing", run: a.run, ask: a.ask, text: "" };
  if (a.type === "reset") return { status: "idle" };
  // Only the run being written may change the preview, and only while it writes.
  if (s.status !== "writing" || s.run !== a.run) return s;
  if (a.type === "delta") return { ...s, text: previewText(a.soFar) };
  if (a.type === "done") return { status: "done", run: s.run, ask: s.ask, html: a.html };
  return { status: "failed", run: s.run, ask: s.ask, stopped: !!a.stopped };
}

const BLOCKS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "UL", "OL", "DIV", "LI", "BR"]);

/**
 * The streamed text as it reads so far: the raw delta is model HTML, possibly cut in the
 * middle of a tag. The browser's parser reads it into an inert document (nothing in it runs
 * or loads), blocks become lines and list items bullets, and only its text is kept: the
 * preview is only ever shown as text. The sanitized HTML arrives at `done`.
 */
export function previewText(raw: string): string {
  let html = raw.trimStart();
  if (html.startsWith("```")) html = html.slice(html.indexOf("\n") + 1 || html.length);
  // A tag still being written at the end is left out until it closes.
  if (html.lastIndexOf("<") > html.lastIndexOf(">")) html = html.slice(0, html.lastIndexOf("<"));
  const doc = new DOMParser().parseFromString(html, "text/html");
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? "";
      return;
    }
    const tag = (n as Element).tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return;
    if (tag === "LI") out += "\n• ";
    n.childNodes.forEach(walk);
    if (BLOCKS.has(tag) && tag !== "LI") out += "\n";
  };
  walk(doc.body);
  return out
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+•/g, "\n•")
    .trim();
}
