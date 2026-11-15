// Ollie writing in the wiki (contracts/ai.md, POST /v1/wiki/ai/write). Over selected text
// (the toolbar's "Ask Ollie", Mod+J) it improves, shortens, explains and so on, or does what
// it is asked; on an empty line ("/ai", Space, Mod+J) it continues the page, summarizes it or
// writes what it is asked, with the page as context. The result streams into a preview under
// the text and is only kept when someone picks Replace or Insert: nothing is saved before.

import { Extension, getHTMLFromFragment, posToDOMRect, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useQueryClient } from "@tanstack/react-query";
import { CornerDownLeft, RotateCcw, Square } from "lucide-react";
import { Popover as P } from "radix-ui";
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { OllieMark } from "@/components/assistant/OllieMark";
import { useCostLabel } from "@/components/ai/bits";
import { balanceSpent, isAbort, reportAiError } from "@/components/ai/ticket/errors";
import { Button } from "@/components/ui/button";
import { floatingPanel } from "@/components/ui/popover";
import { api } from "@/lib/api/endpoints";
import type { AIFeature, WikiWriteMode } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { sanitizeHtml } from "@/lib/sanitize";
import { costFeature, PAGE_MODES, previewReducer, SELECTION_MODES, writeRequest, type OllieAsk, type OllieTarget } from "@/lib/wiki/ollie";

// ─── The text Ollie works on, marked while it does ─────────────────────────────

type Range = { from: number; to: number };
export const ollieKey = new PluginKey<Range | null>("wiki-ollie");

/** The range Ollie works on, kept in place as the page changes around it. */
export const ollieRange = (state: EditorState) => ollieKey.getState(state) ?? null;

const setRange = (editor: Editor, r: Range | null) => editor.view.dispatch(editor.state.tr.setMeta(ollieKey, r).setMeta("addToHistory", false));

/** Lines where Space asks Ollie: the page's own lines, as the "/" hint shows on. */
const ASK_PARENTS = new Set(["doc", "column", "callout", "detailsContent"]);

/** The cursor sits on an empty line of the page where a block could start. */
export function onEmptyLine(state: EditorState): boolean {
  const { selection } = state;
  if (!selection.empty) return false;
  const $from = selection.$from;
  return $from.parent.type.name === "paragraph" && $from.parent.content.size === 0 && ASK_PARENTS.has($from.node($from.depth - 1)?.type.name ?? "");
}

/** Where Ollie would work now: the selected text, else an empty line, else nowhere. */
export function targetOf(state: EditorState): OllieTarget | null {
  const { from, to, empty } = state.selection;
  if (!empty && state.doc.textBetween(from, to).trim()) return { kind: "selection", from, to };
  return onEmptyLine(state) ? { kind: "cursor", pos: from } : null;
}

export const OllieExtension = Extension.create<{ enabled: () => boolean; ask: () => void }>({
  name: "wikiOllie",
  addOptions: () => ({ enabled: () => false, ask: () => {} }),
  addProseMirrorPlugins() {
    return [
      new Plugin<Range | null>({
        key: ollieKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(ollieKey) as Range | null | undefined;
            if (meta !== undefined) return meta;
            if (!value || !tr.docChanged) return value;
            const from = tr.mapping.map(value.from, 1);
            return { from, to: Math.max(from, tr.mapping.map(value.to, -1)) };
          },
        },
        props: {
          decorations(state) {
            const r = ollieKey.getState(state);
            return r && r.to > r.from ? DecorationSet.create(state.doc, [Decoration.inline(r.from, r.to, { class: "wiki-ollie-target" })]) : null;
          },
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    const can = () => this.editor.isEditable && this.options.enabled();
    return {
      // Notion's: Space on an empty line asks for writing.
      Space: () => {
        if (!can() || !onEmptyLine(this.editor.state)) return false;
        this.options.ask();
        return true;
      },
      "Mod-j": () => {
        if (!can() || !targetOf(this.editor.state)) return false;
        this.options.ask();
        return true;
      },
    };
  },
});

// ─── The prompt and the preview ──────────────────────────────────────────────

type Option = { mode: WikiWriteMode; label: string; feature: AIFeature };

function Cost({ feature }: { feature: AIFeature }) {
  const label = useCostLabel()(feature);
  return label ? <span className="mono text-[10.5px] normal-case tracking-normal text-fg-4">{label}</span> : null;
}

/** The HTML Ollie works from: the page, what comes before the cursor, and the selection. */
function sourceOf(editor: Editor, target: OllieTarget, title: string) {
  const { doc, schema } = editor.state;
  const slice = (from: number, to: number) => getHTMLFromFragment(doc.slice(from, to).content, schema);
  const r = ollieRange(editor.state);
  const at = r?.from ?? (target.kind === "cursor" ? target.pos : target.from);
  return {
    title,
    page: editor.getHTML(),
    before: slice(0, Math.min(at, doc.content.size)),
    selection: target.kind === "selection" && r ? slice(r.from, r.to) : "",
  };
}

export type OllieWriterProps = {
  editor: Editor;
  /** Where Ollie was asked to work; null when closed. */
  target: OllieTarget | null;
  onClose: () => void;
  pageTitle: () => string;
};

/** Ollie's popover under the text it works on; mount once beside the editor. */
export function OllieWriter({ editor, target, onClose, pageTitle }: OllieWriterProps) {
  const { t } = useTranslation("wiki");
  const qc = useQueryClient();
  const [preview, dispatch] = useReducer(previewReducer, { status: "idle" });
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(-1);
  const runs = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const kind = target?.kind;

  // The text being worked on is marked while the popover is open.
  useEffect(() => {
    if (!target) return;
    setRange(editor, target.kind === "selection" ? { from: target.from, to: target.to } : { from: target.pos, to: target.pos });
    setQuery("");
    setIndex(-1);
    dispatch({ type: "reset" });
    return () => {
      abort.current?.abort();
      abort.current = null;
      if (!editor.isDestroyed) setRange(editor, null);
    };
  }, [editor, target]);

  const anchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => {
          const r = ollieRange(editor.state);
          if (!r || editor.isDestroyed) return new DOMRect();
          return posToDOMRect(editor.view, r.from, r.to);
        },
      },
    }),
    [editor],
  );

  const options: Option[] = useMemo(() => {
    const modes: readonly WikiWriteMode[] = kind === "selection" ? SELECTION_MODES : PAGE_MODES;
    return modes.map((mode) => ({ mode, label: t(kind === "cursor" && mode === "summarize" ? "ollie.summarizePage" : `ollie.mode.${mode}`), feature: costFeature(mode) }));
  }, [kind, t]);
  const shown = query.trim() ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())) : options;

  const run = async (ask: OllieAsk) => {
    if (!target) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    const id = ++runs.current;
    dispatch({ type: "start", run: id, ask });
    try {
      const res = await api.wiki.write(writeRequest(ask, target.kind, sourceOf(editor, target, pageTitle())), {
        signal: ac.signal,
        onDelta: (_d, soFar) => dispatch({ type: "delta", run: id, soFar }),
      });
      dispatch({ type: "done", run: id, html: res.html });
      balanceSpent(qc);
    } catch (e) {
      if (isAbort(e)) return;
      dispatch({ type: "fail", run: id });
      reportAiError(e, t("ollie.failed"));
    } finally {
      if (abort.current === ac) abort.current = null;
    }
  };

  const keep = (where: "replace" | "below") => {
    if (preview.status !== "done") return;
    const r = ollieRange(editor.state);
    if (!r) return;
    const html = preview.html;
    const chain = editor.chain().focus();
    if (where === "replace" && r.to > r.from) chain.insertContentAt(r, html);
    else if (r.to > r.from) {
      // Below the block the selection ends in.
      const $to = editor.state.doc.resolve(r.to);
      chain.insertContentAt($to.depth > 0 ? $to.after($to.depth) : r.to, html);
    } else {
      // At an empty line: the line becomes what Ollie wrote.
      const $at = editor.state.doc.resolve(r.from);
      const empty = $at.parent.isTextblock && $at.parent.content.size === 0 && $at.depth > 0;
      chain.insertContentAt(empty ? { from: $at.before(), to: $at.after() } : r.from, html);
    }
    chain.run();
    onClose();
  };

  const stop = () => {
    abort.current?.abort();
    abort.current = null;
    dispatch({ type: "fail", run: runs.current, stopped: true });
  };

  const ask = (o?: Option) => {
    if (o) return void run({ mode: o.mode });
    if (query.trim()) void run({ mode: "custom", instructions: query.trim() });
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" && shown.length) {
      e.preventDefault();
      setIndex((i) => (i + 1) % shown.length);
    } else if (e.key === "ArrowUp" && shown.length) {
      e.preventDefault();
      setIndex((i) => (i <= 0 ? shown.length - 1 : i - 1));
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask(index >= 0 ? shown[index] : undefined);
    }
  };

  const writing = preview.status === "writing";
  const editLabel = kind === "selection" ? t("ollie.edit") : t("ollie.write");

  return (
    <P.Root open={!!target} onOpenChange={(o) => !o && onClose()}>
      <P.Anchor virtualRef={anchor} />
      <P.Portal>
        <P.Content
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          updatePositionStrategy="always"
          aria-label={t("ollie.ask")}
          className={cn(floatingPanel, "z-[75] w-[min(420px,calc(100vw-24px))] overflow-hidden p-0")}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (!editor.isDestroyed) editor.commands.focus();
          }}
        >
          {preview.status === "idle" ? (
            <div onKeyDown={onKey}>
              <form
                className="flex items-center gap-2 border-b border-line-soft px-3 py-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  ask(index >= 0 ? shown[index] : undefined);
                }}
              >
                <OllieMark size={18} />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setIndex(-1);
                  }}
                  placeholder={kind === "selection" ? t("ollie.promptSelection") : t("ollie.promptLine")}
                  aria-label={t("ollie.ask")}
                  maxLength={1000}
                  className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-4 focus-visible:shadow-none"
                />
                {query.trim() && (
                  <Button type="submit" size="xs" variant="primary" icon={<CornerDownLeft />}>
                    {t("ollie.submit")}
                  </Button>
                )}
              </form>
              <div role="listbox" aria-label={editLabel} className="max-h-[320px] overflow-y-auto p-1">
                {shown.length > 0 && (
                  <div className="label-caps flex items-center justify-between px-2 pb-1 pt-1.5">
                    <span>{editLabel}</span>
                  </div>
                )}
                {shown.map((o, i) => (
                  <button
                    key={o.mode}
                    type="button"
                    role="option"
                    aria-selected={i === index}
                    onMouseMove={() => i !== index && setIndex(i)}
                    onClick={() => ask(o)}
                    className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-fg", i === index && "bg-hover")}
                  >
                    <span className="flex-1 truncate">{o.label}</span>
                    <Cost feature={o.feature} />
                  </button>
                ))}
                {query.trim() && (
                  <p className="flex items-center justify-between gap-2 px-2 pb-1 pt-1.5 text-[11.5px] text-fg-4">
                    <span>{t("ollie.customHint")}</span>
                    <Cost feature="wiki_write" />
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
                <OllieMark size={18} state={writing ? "thinking" : "idle"} celebrate={preview.status === "done"} />
                <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg-2">
                  {writing ? (preview.text ? t("ollie.writing") : t("ollie.reading")) : preview.status === "failed" ? t(preview.stopped ? "ollie.stopped" : "ollie.failed") : t(`ollie.mode.${preview.ask.mode}`)}
                </span>
              </div>
              <div className="max-h-[min(360px,50vh)] overflow-y-auto px-3 pb-3 pt-1" data-ph-mask>
                {preview.status === "done" ? (
                  <div className="prose-od wiki-ollie-result text-[13px] leading-[20px]" dangerouslySetInnerHTML={{ __html: sanitizeHtml(preview.html) }} />
                ) : writing ? (
                  <p className="whitespace-pre-wrap text-[13px] leading-[20px] text-fg-2">
                    {preview.text}
                    <span aria-hidden className="wiki-ollie-caret" />
                  </p>
                ) : (
                  <p className="text-[12.5px] text-fg-3">{t(preview.status === "failed" && preview.stopped ? "ollie.stoppedHint" : "ollie.failedHint")}</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 border-t border-line-soft px-3 py-2">
                {writing ? (
                  <Button size="xs" variant="ghost" icon={<Square className="size-2.5 fill-current" />} onClick={stop}>
                    {t("ollie.stop")}
                  </Button>
                ) : preview.status === "done" && kind === "selection" ? (
                  <>
                    <Button size="xs" variant="primary" autoFocus onClick={() => keep("replace")}>
                      {t("ollie.replace")}
                    </Button>
                    <Button size="xs" variant="secondary" onClick={() => keep("below")}>
                      {t("ollie.insertBelow")}
                    </Button>
                  </>
                ) : preview.status === "done" ? (
                  <Button size="xs" variant="primary" autoFocus onClick={() => keep("replace")}>
                    {t("ollie.insert")}
                  </Button>
                ) : null}
                {!writing && (
                  <Button size="xs" variant="ghost" icon={<RotateCcw />} onClick={() => void run(preview.ask)}>
                    {t("ollie.tryAgain")}
                  </Button>
                )}
                <span className="flex-1" />
                <Button size="xs" variant="ghost" onClick={onClose}>
                  {t("ollie.discard")}
                </Button>
              </div>
            </div>
          )}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
