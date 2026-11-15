// The toolbar over selected text: Ollie (where AI is on), what the block is (and turning it
// into another), the inline marks, a link (to a page of the wiki or the web), colour and
// inline code. It only shows for a text selection someone made, never for a selected image
// or inside code, and steps aside while Ollie works on the selection.

import type { Editor } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react/menus";
import { DropdownMenu as M } from "radix-ui";
import { Bold, ChevronDown, Code, FileText, Italic, Link2, MessageSquareText, Sigma, Strikethrough, Underline, Unlink } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PluginKey, type EditorState } from "@tiptap/pm/state";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/input";
import { menuItemCls } from "@/components/ui/menu";
import { Popover } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { WikiNode } from "@/lib/api/types";
import { useTitle, useWikiTree } from "../hooks";
import { PageIcon } from "../PageTree";
import { heldComment } from "./comment";
import { turnIntoOptions, type TurnId } from "./handle";
import { bestName, rank } from "./menu";
import { TONES, type Tone } from "./tones";
import { OllieMark } from "@/components/assistant/OllieMark";

function Btn({ label, shortcut, active, onClick, children }: { label: string; shortcut?: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={cn("flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-fg-2 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-[15px]", active && "bg-hover text-fg")}
      >
        {children}
      </button>
    </Tooltip>
  );
}

const sep = <span className="mx-0.5 h-4 w-px shrink-0 bg-line" />;

function currentKind(editor: Editor): TurnId {
  if (editor.isActive("heading", { level: 1 })) return "h1";
  if (editor.isActive("heading", { level: 2 })) return "h2";
  if (editor.isActive("heading", { level: 3 })) return "h3";
  if (editor.isActive("taskList")) return "todo";
  if (editor.isActive("bulletList")) return "bullet";
  if (editor.isActive("orderedList")) return "ordered";
  if (editor.isActive("callout")) return "callout";
  if (editor.isActive("blockquote")) return "quote";
  if (editor.isActive("details")) return "toggle";
  return "text";
}

// BubbleMenu sends a transaction whenever these change identity, and the page redraws on
// every transaction: they must stay the same objects across renders.
const BUBBLE_OPTIONS = { placement: "top", offset: 8, flip: true, shift: { padding: 8 } } as const;
const BUBBLE_KEY = new PluginKey("wikiBubble");

export function BubbleToolbar({ editor, canComment, onAskOllie, ollieOpen }: { editor: Editor; canComment: boolean; onAskOllie?: () => void; ollieOpen?: boolean }) {
  const { t } = useTranslation("wiki");
  const [linking, setLinking] = useState(false);
  const linkingRef = useRef(linking);
  linkingRef.current = linking;
  const ollieRef = useRef(ollieOpen);
  ollieRef.current = ollieOpen;
  const shouldShow = useCallback(({ editor: e, state, from, to }: { editor: Editor; state: EditorState; from: number; to: number }) => {
    // The link field keeps the toolbar up while it has focus.
    if (linkingRef.current) return true;
    if (ollieRef.current) return false;
    if (!e.isEditable || from === to) return false;
    // A thread being written on the selection has the panel's attention.
    if (heldComment(state)) return false;
    if ((state.selection as { node?: unknown }).node) return false;
    if (e.isActive("codeBlock") || e.isActive("inlineMath") || e.isActive("blockMath")) return false;
    return state.doc.textBetween(from, to).trim().length > 0;
  }, []);
  // Ollie's popover takes over the selection: the toolbar leaves at once, not on the next edit.
  useEffect(() => {
    if (ollieOpen && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(BUBBLE_KEY, "hide").setMeta("addToHistory", false));
  }, [ollieOpen, editor]);
  const kind = currentKind(editor);
  return (
    <BubbleMenu
      editor={editor}
      pluginKey={BUBBLE_KEY}
      options={BUBBLE_OPTIONS}
      shouldShow={shouldShow}
      className="wiki-bubble z-50 flex items-center gap-0.5 rounded-lg border border-line bg-raised p-1 shadow-pop animate-pop-in"
    >
      {onAskOllie && (
        <>
          <Tooltip content={t("ollie.askSelection")} shortcut="mod j">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onAskOllie}
              className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] font-medium text-tone-violet transition-colors hover:bg-tone-violet-soft"
            >
              <OllieMark size={16} eyes={false} />
              {t("ollie.ask")}
            </button>
          </Tooltip>
          {sep}
        </>
      )}
      <M.Root modal={false}>
        <M.Trigger asChild>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover"
          >
            {t(`editor.block.${kind}`)}
            <ChevronDown className="size-3 text-fg-4" />
          </button>
        </M.Trigger>
        <M.Portal>
          <M.Content sideOffset={6} align="start" className="z-[60] min-w-[200px] rounded-lg border border-line bg-raised p-1 shadow-pop animate-pop-in" onCloseAutoFocus={(e) => e.preventDefault()}>
            <div className="label-caps px-2 pb-1 pt-1.5">{t("editor.handle.turnInto")}</div>
            {turnIntoOptions().map((o) => (
              <M.Item key={o.id} className={cn(menuItemCls, kind === o.id && "font-medium")} onSelect={() => o.run(editor)}>
                {o.icon}
                <span className="flex-1">{t(`editor.block.${o.id}`)}</span>
                {kind === o.id && <span className="size-1.5 rounded-full bg-fg" />}
              </M.Item>
            ))}
          </M.Content>
        </M.Portal>
      </M.Root>
      {sep}
      <Btn label={t("editor.mark.bold")} shortcut="mod b" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold />
      </Btn>
      <Btn label={t("editor.mark.italic")} shortcut="mod i" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic />
      </Btn>
      <Btn label={t("editor.mark.underline")} shortcut="mod u" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <Underline />
      </Btn>
      <Btn label={t("editor.mark.strike")} shortcut="mod shift s" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough />
      </Btn>
      <Btn label={t("editor.mark.code")} shortcut="mod e" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code />
      </Btn>
      <Btn
        label={t("editor.mark.math")}
        onClick={() => {
          const { from, to } = editor.state.selection;
          const latex = editor.state.doc.textBetween(from, to);
          editor.chain().focus().deleteSelection().insertInlineMath({ latex }).run();
        }}
      >
        <Sigma />
      </Btn>
      {sep}
      <LinkPopover editor={editor} open={linking} onOpenChange={setLinking} />
      <ColorPopover editor={editor} />
      {canComment && (
        <>
          {sep}
          <Tooltip content={t("comments.commentOnText")} shortcut="mod alt m">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.commands.startComment()}
              className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-fg-2 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-[15px]"
            >
              <MessageSquareText />
              {t("comments.comment")}
            </button>
          </Tooltip>
        </>
      )}
    </BubbleMenu>
  );
}

function LinkPopover({ editor, open, onOpenChange }: { editor: Editor; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const { tree } = useWikiTree();
  const [v, setV] = useState("");
  const active = editor.isActive("link");
  const pages = v.trim() && !/^(https?:|mailto:|www\.)/i.test(v.trim()) ? rank(v, [...tree.byId.values()], (n) => [bestName(v, title(n.title), n.aliases)]).slice(0, 5) : [];
  const apply = (href: string) => {
    const url = /^(https?:|mailto:|tel:|\/)/i.test(href) ? href : `https://${href}`;
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    onOpenChange(false);
  };
  const linkPage = (n: WikiNode) => {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to) || title(n.title);
    editor.chain().focus().insertContentAt({ from, to }, { type: "text", text, marks: [{ type: "link", attrs: { href: `/wiki/${n.id}` } }] }).run();
    onOpenChange(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (o) setV((editor.getAttributes("link").href as string | undefined) ?? "");
      }}
      side="bottom"
      className="w-[320px] p-1.5"
      trigger={
        <button
          type="button"
          aria-label={t("editor.mark.link")}
          aria-pressed={active}
          onMouseDown={(e) => e.preventDefault()}
          className={cn("flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-fg-2 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-[15px]", active && "text-tone-blue")}
        >
          <Link2 />
          {t("editor.mark.link")}
        </button>
      }
    >
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (pages[0] && !/[./]/.test(v)) return linkPage(pages[0]);
          if (v.trim()) apply(v.trim());
        }}
      >
        <TextInput autoFocus inputSize="sm" value={v} onChange={(e) => setV(e.target.value)} placeholder={t("editor.linkPlaceholder")} aria-label={t("editor.mark.link")} />
        {active && (
          <Tooltip content={t("editor.unlink")}>
            <Button
              type="button"
              square
              size="sm"
              variant="ghost"
              aria-label={t("editor.unlink")}
              onClick={() => {
                editor.chain().focus().extendMarkRange("link").unsetLink().run();
                onOpenChange(false);
              }}
            >
              <Unlink className="size-3.5" />
            </Button>
          </Tooltip>
        )}
      </form>
      {pages.length > 0 && (
        <div className="mt-1.5 border-t border-line pt-1">
          <div className="label-caps px-2 pb-1 pt-1">{t("editor.linkToPage")}</div>
          {pages.map((n) => (
            <button key={n.id} type="button" onClick={() => linkPage(n)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-hover">
              {n.icon ? <PageIcon icon={n.icon} /> : <FileText className="size-3.5 text-fg-4" />}
              <span className="truncate">{title(n.title)}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

function ColorPopover({ editor }: { editor: Editor }) {
  const { t } = useTranslation("wiki");
  const [open, setOpen] = useState(false);
  const text = (editor.getAttributes("textTone").tone as Tone | undefined) ?? null;
  const bg = (editor.getAttributes("highlightTone").tone as Tone | undefined) ?? null;
  const cell = (kind: "text" | "bg", tone: Tone | null) => {
    const on = kind === "text" ? text === tone : bg === tone;
    return (
      <Tooltip key={`${kind}-${tone}`} content={tone ? t(`editor.tone.${tone}`) : t("editor.tone.default")}>
        <button
          type="button"
          aria-label={tone ? t(`editor.tone.${tone}`) : t("editor.tone.default")}
          aria-pressed={on}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (kind === "text" ? editor.chain().focus().setTextTone(tone).run() : editor.chain().focus().setHighlightTone(tone).run())}
          className={cn("flex size-7 items-center justify-center rounded-md border transition-colors hover:border-line-strong", on ? "border-fg" : "border-line")}
        >
          {kind === "text" ? (
            <span className="wiki-swatch-text" data-color={tone ?? undefined}>
              A
            </span>
          ) : (
            <span className="wiki-swatch-bg" data-bg={tone ?? undefined}>
              A
            </span>
          )}
        </button>
      </Tooltip>
    );
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      className="w-[290px] p-2.5"
      trigger={
        <button
          type="button"
          aria-label={t("editor.mark.color")}
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-7 items-center gap-1 rounded-md px-1.5 text-fg-2 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover"
        >
          <span className="wiki-swatch-text border-b-2 pb-px text-[13px] font-semibold leading-none" data-color={text ?? undefined} style={{ borderColor: "currentColor" }}>
            A
          </span>
          <ChevronDown className="size-3 text-fg-4" />
        </button>
      }
    >
      <div className="label-caps pb-1.5">{t("editor.handle.text")}</div>
      <div className="grid grid-cols-5 gap-1">{[null, ...TONES].map((tone) => cell("text", tone))}</div>
      <div className="label-caps pb-1.5 pt-3">{t("editor.handle.background")}</div>
      <div className="grid grid-cols-5 gap-1">{[null, ...TONES].map((tone) => cell("bg", tone))}</div>
    </Popover>
  );
}
