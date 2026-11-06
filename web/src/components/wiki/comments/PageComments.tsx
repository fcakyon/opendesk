// A wiki page's comments as the page around them sees them: which thread is in hand, the
// thread being started on selected text, a link that opens one (?comment=<id>), the
// "Comments (n)" line under the title and following the page.

import type { Editor } from "@tiptap/react";
import { Bell, BellRing, MessageSquare, MessageSquarePlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { openCount } from "@/lib/wiki/comments";
import { applyComment, holdComment, revealThread, showThreads, type CommentRange } from "../editor/comment";
import type { PendingThread } from "./CommentsPanel";
import { useCommentActions, useComments, useFollow } from "./hooks";

export function usePageComments({
  pageId,
  editor,
  panelOpen,
  openPanel,
  openThread,
  onThreadOpened,
}: {
  pageId: string;
  editor: Editor | null;
  /** Whether the panel shows its Comments tab. */
  panelOpen: boolean;
  openPanel: () => void;
  /** A thread to open as the page loads (a link's ?comment=). */
  openThread?: string;
  onThreadOpened?: () => void;
}) {
  const { data } = useComments(pageId);
  const actions = useCommentActions(pageId);
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingThread | null>(null);
  const [focusNew, setFocusNew] = useState(0);
  const threads = useMemo(() => data?.data ?? [], [data]);

  // The editor draws open threads' text, the one in hand stronger.
  const openIds = useMemo(() => threads.filter((x) => !x.resolved_at).map((x) => x.id), [threads]);
  useEffect(() => {
    if (editor) showThreads(editor, openIds, panelOpen ? active : null);
  }, [editor, openIds, active, panelOpen]);

  const cancel = useCallback(() => {
    if (editor) holdComment(editor, null);
    setPending(null);
  }, [editor]);

  // Closing the comments lets go of a thread not yet written.
  useEffect(() => {
    if (!panelOpen && pending) cancel();
  }, [panelOpen, pending, cancel]);

  const open = useCallback(
    (id: string) => {
      setActive(id);
      openPanel();
    },
    [openPanel],
  );
  const start = useCallback(
    (range: CommentRange, quote: string) => {
      if (!editor) return;
      holdComment(editor, range);
      // The held text is drawn; the selection itself steps aside, and the toolbar over it with it.
      editor.commands.setTextSelection(range.to);
      setPending({ quote });
      setActive(null);
      openPanel();
    },
    [editor, openPanel],
  );
  const sendPending = async (html: string) => {
    if (!pending) return;
    const made = await actions.create({ body_html: html, quote: pending.quote, inline: true });
    // The mark goes on now that the thread exists; the page saves it as an edit.
    if (editor) applyComment(editor, made.id);
    setPending(null);
    setActive(made.id);
  };
  const addComment = useCallback(() => {
    openPanel();
    setFocusNew((n) => n + 1);
  }, [openPanel]);

  // A link to a thread opens it once the threads are here, and finds its text.
  const loaded = !!data;
  useEffect(() => {
    if (!openThread || !loaded) return;
    open(openThread);
    const id = requestAnimationFrame(() => {
      if (editor) revealThread(editor, openThread);
    });
    onThreadOpened?.();
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openThread, loaded, editor]);

  return { threads, count: openCount(threads), active, setActive, pending, cancel, sendPending, focusNew, open, start, addComment };
}

/** "3 comments" under the title, as Notion shows them; "Add a comment" on a page without any, for those who may. */
export function CommentCount({ count, canComment, onOpen }: { count: number; canComment: boolean; onOpen: () => void }) {
  const { t } = useTranslation("wiki");
  if (!count && !canComment) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "mt-2 flex items-center gap-1 rounded-md px-1 text-[12.5px] text-fg-3 transition-[color,background-color,opacity] hover:bg-hover hover:text-fg",
        !count && "opacity-0 focus-visible:opacity-100 group-hover/head:opacity-100 [@media(hover:none)]:opacity-100",
      )}
    >
      {count ? <MessageSquare className="size-3.5" /> : <MessageSquarePlus className="size-3.5" />}
      {count ? t("comments.count", { count }) : t("comments.add")}
    </button>
  );
}

/** The bell in the page's header: comments on the page notify the person while it rings. */
export function FollowButton({ pageId }: { pageId: string }) {
  const { t } = useTranslation("wiki");
  const f = useFollow(pageId);
  if (!f.ready) return null;
  const label = f.following ? t("follow.following") : t("follow.follow");
  return (
    <Tooltip content={f.following ? t("follow.followingHint") : t("follow.followHint")}>
      <Button square variant="ghost" size="sm" aria-label={label} aria-pressed={f.following} onClick={f.toggle}>
        {f.following ? <BellRing className="size-4 text-fg" /> : <Bell className="size-4" />}
      </Button>
    </Tooltip>
  );
}
