import { useTranslation } from "react-i18next";
// Composer suggestions: "@" mentions (notes) and "/" saved replies. TipTap's
// Suggestion utility drives the matching; a tiny store feeds one React popup.

import { Extension, type Editor, type Range } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { create } from "zustand";
import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import type { Member, SavedReply } from "@/lib/api/types";
import { Avatar } from "@/components/ui/avatar";
import { placeBelowOrAbove, useCaretAnchor } from "@/components/editor/anchor";
import { cn } from "@/lib/cn";
import { MessageSquareText } from "lucide-react";

export type SuggestItem =
  | { kind: "mention"; id: string; label: string; sub?: string; avatar?: string | null }
  | { kind: "reply"; id: string; label: string; sub?: string; html: string };

type SuggestState = {
  open: boolean;
  kind: "mention" | "reply";
  items: SuggestItem[];
  index: number;
  /** The caret's rect, read again as the page scrolls. */
  getRect: (() => DOMRect | null) | null;
  anchorEl: HTMLElement | null;
  pick: ((item: SuggestItem) => void) | null;
};

export const useSuggest = create<SuggestState>(() => ({ open: false, kind: "mention", items: [], index: 0, getRect: null, anchorEl: null, pick: null }));
// Closed by Escape or a click outside: stays closed until "/" or "@" is typed again.
const dismiss = () => useSuggest.setState({ open: false });

function renderer(kind: "mention" | "reply"): SuggestionOptions<SuggestItem>["render"] {
  return () => ({
    onStart: (p: SuggestionProps<SuggestItem>) => {
      useSuggest.setState({ open: true, kind, items: p.items, index: 0, getRect: p.clientRect ?? null, anchorEl: p.editor.view.dom, pick: (i) => p.command(i) });
    },
    onUpdate: (p: SuggestionProps<SuggestItem>) => {
      useSuggest.setState((s) => ({ items: p.items, index: Math.min(s.index, Math.max(0, p.items.length - 1)), getRect: p.clientRect ?? s.getRect, pick: (i) => p.command(i) }));
    },
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      const s = useSuggest.getState();
      if (!s.open) return false;
      if (event.key === "Escape") {
        dismiss();
        return true;
      }
      if (!s.items.length) return false;
      if (event.key === "ArrowDown") {
        useSuggest.setState({ index: (s.index + 1) % s.items.length });
        return true;
      }
      if (event.key === "ArrowUp") {
        useSuggest.setState({ index: (s.index - 1 + s.items.length) % s.items.length });
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        s.pick?.(s.items[s.index]);
        return true;
      }
      return false;
    },
    onExit: () => useSuggest.setState({ open: false, pick: null, getRect: null, anchorEl: null }),
  });
}

export function mentionExtension(getMembers: () => Member[], enabled: () => boolean = () => true) {
  return Mention.configure({
    HTMLAttributes: { class: "mention" },
    renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
    suggestion: {
      char: "@",
      allow: () => enabled(),
      items: ({ query }): SuggestItem[] =>
        getMembers()
          .filter((m) => m.role !== "viewer")
          .filter((m) => !query || m.user.name.toLowerCase().includes(query.toLowerCase()) || m.user.email.toLowerCase().startsWith(query.toLowerCase()))
          .slice(0, 6)
          .map((m) => ({ kind: "mention", id: m.user.id, label: m.user.name, sub: m.user.email, avatar: m.user.avatar_url })),
      render: renderer("mention"),
    },
  });
}

const replyKey = new PluginKey("saved-replies");

/**
 * "/" saved replies. `pick` inserts the chosen reply's HTML (the composer fills it
 * for the ticket first); `clear` removes the typed "/query".
 */
export function savedReplyExtension(getReplies: () => SavedReply[], pick: (html: string, clear: () => void, replyId?: string) => void) {
  return Extension.create({
    name: "savedReplies",
    addProseMirrorPlugins() {
      return [
        Suggestion<SuggestItem>({
          editor: this.editor,
          pluginKey: replyKey,
          char: "/",
          allowSpaces: false,
          items: ({ query }) =>
            getReplies()
              .filter((r) => !query || r.shortcut.toLowerCase().includes(query.toLowerCase()) || r.title.toLowerCase().includes(query.toLowerCase()))
              .slice(0, 8)
              .map((r) => ({ kind: "reply", id: r.id, label: r.title, sub: r.shortcut ? `/${r.shortcut.replace(/^\//, "")}` : undefined, html: r.body_html })),
          command: ({ editor, range, props }: { editor: Editor; range: Range; props: SuggestItem }) => {
            if (props.kind !== "reply") return;
            pick(props.html, () => editor.chain().focus().deleteRange(range).run(), props.id);
          },
          render: renderer("reply"),
        }),
      ];
    },
  });
}

/** The floating list; mount once next to the editor. */
export function SuggestionPopup() {
  const { t } = useTranslation(["indicators", "inbox"]);
  const { open, items, index, getRect, anchorEl, pick, kind } = useSuggest();
  const ref = useRef<HTMLDivElement>(null);
  const rect = useCaretAnchor({ open, getRect, anchorEl, popupRef: ref, onDismiss: dismiss });
  useEffect(() => {
    ref.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  if (!open || !rect) return null;
  return createPortal(
    <div
      ref={ref}
      role="listbox"
      aria-label={kind === "mention" ? t("tickets.mentionTeammate") : t("inbox:composer.savedReplies")}
      data-floating
      style={placeBelowOrAbove(rect, 280, 240)}
      className="z-[80] max-h-[240px] w-[280px] overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-pop animate-pop-in"
    >
      <div className="label-caps px-2 pb-1 pt-1.5">{kind === "mention" ? "Mention" : "Saved replies"}</div>
      {items.length === 0 ? (
        <div className="px-2 py-3 text-xs text-fg-3">{kind === "mention" ? "No teammates match" : "No saved replies match"}</div>
      ) : (
        items.map((it, i) => (
          <button
            key={it.id}
            type="button"
            data-i={i}
            role="option"
            aria-selected={i === index}
            onMouseDown={(e) => {
              e.preventDefault();
              pick?.(it);
            }}
            onMouseEnter={() => useSuggest.setState({ index: i })}
            className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px]", i === index && "bg-hover")}
          >
            {it.kind === "mention" ? <Avatar name={it.label} src={it.avatar} size="xs" /> : <MessageSquareText className="size-3.5 text-fg-3" />}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.sub && <span className="mono shrink-0 truncate text-[11px] text-fg-4">{it.sub}</span>}
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
