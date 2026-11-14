// The Comments tab of a wiki page's panel: open or resolved threads, the inline ones in
// the order their text reads in the page, then the page's own. The way to add one stays
// pinned at the top however long the list is: a page comment, or the thread being started
// on selected text with its quote. Readers read; they get no composer.

import type { Editor } from "@tiptap/react";
import { AnimatePresence } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SuggestionPopup } from "@/components/tickets/detail/suggestions";
import { EmptyState } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Segmented } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { draftKey, orderThreads } from "@/lib/wiki/comments";
import { anchorPositions, revealThread } from "../editor/comment";
import { Composer, type ComposerHandle } from "./Composer";
import { useCommentActions, useComments } from "./hooks";
import { ThreadCard, type ThreadAccess } from "./Thread";

/** Where each thread's text is in the page, as it is edited. */
function usePositions(editor: Editor | null): Map<string, number> {
  const [pos, setPos] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    if (!editor) return;
    const read = () => setPos(anchorPositions(editor.state.doc));
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor]);
  return pos;
}

export type PendingThread = { quote: string };

export function CommentsPanel({
  pageId,
  editor,
  access,
  active,
  onActive,
  pending,
  onCancelPending,
  onSendPending,
  focusNew,
}: {
  pageId: string;
  editor: Editor | null;
  access: ThreadAccess;
  active: string | null;
  onActive: (id: string | null) => void;
  /** A thread being started on selected text. */
  pending: PendingThread | null;
  onCancelPending: () => void;
  onSendPending: (html: string) => Promise<unknown>;
  /** Changes when "Add a comment" should take the focus. */
  focusNew: number;
}) {
  const { t } = useTranslation("wiki");
  const { data, isLoading } = useComments(pageId);
  const actions = useCommentActions(pageId);
  const positions = usePositions(editor);
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const composer = useRef<ComposerHandle>(null);
  const threads = useMemo(() => orderThreads(data?.data ?? [], positions), [data, positions]);
  const open = threads.filter((x) => !x.resolved_at);
  const resolved = threads.filter((x) => !!x.resolved_at);
  const shown = filter === "open" ? open : resolved;

  // A thread opened from its text or a link shows under the filter it is in; resolving
  // the one in hand leaves the reader where they were.
  const activeThread = threads.find((x) => x.id === active);
  useEffect(() => {
    if (activeThread) setFilter(activeThread.resolved_at ? "resolved" : "open");
  }, [activeThread?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!focusNew) return;
    setFilter("open");
    // After the panel has drawn.
    const id = requestAnimationFrame(() => composer.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [focusNew]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-line-soft p-2.5">
        <Segmented
          size="xs"
          value={filter}
          onChange={setFilter}
          className="self-start"
          options={[
            { value: "open", label: <>{t("comments.open")} <span className="mono text-[10.5px] text-fg-4">{open.length || ""}</span></> },
            { value: "resolved", label: <>{t("comments.resolvedFilter")} <span className="mono text-[10.5px] text-fg-4">{resolved.length || ""}</span></> },
          ]}
        />
        {access.canComment &&
          (pending ? (
            <div className="rounded-xl border border-[color-mix(in_oklab,var(--tone-amber-solid)_55%,var(--line))] bg-surface p-2 shadow-[0_0_0_3px_var(--tone-amber-soft)] animate-rise-in motion-reduce:animate-none">
              <div className="mb-1.5 flex items-stretch gap-2 px-1">
                <span aria-hidden className="w-[2px] shrink-0 rounded-full bg-tone-amber-solid" />
                <span className="line-clamp-2 text-[12px] leading-[17px] text-fg-3">{pending.quote}</span>
              </div>
              <Composer
                key="inline"
                draftKey={draftKey(pageId, "inline")}
                placeholder={t("comments.placeholderInline")}
                sendLabel={t("comments.comment")}
                autoFocus
                expanded
                onCancel={onCancelPending}
                onSend={onSendPending}
              />
            </div>
          ) : (
            <Composer
              key="new"
              ref={composer}
              draftKey={draftKey(pageId, "new")}
              placeholder={t("comments.add")}
              sendLabel={t("comments.comment")}
              onSend={async (html) => {
                const made = await actions.create({ body_html: html });
                onActive(made.id);
              }}
            />
          ))}
      </div>
      <div className={cn("min-h-0 flex-1 overflow-y-auto p-2.5", !shown.length && "flex flex-col")}>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-4" />
          </div>
        ) : shown.length ? (
          <div className="flex flex-col gap-2.5">
            <AnimatePresence initial={false} mode="popLayout">
              {shown.map((x) => (
                <ThreadCard
                  key={x.id}
                  thread={x}
                  pageId={pageId}
                  access={access}
                  active={x.id === active}
                  onActivate={() => onActive(x.id)}
                  onReveal={() => !!editor && revealThread(editor, x.id)}
                />
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <EmptyState
            compact
            art="wiki"
            className="flex-1"
            title={filter === "open" ? t("comments.emptyTitle") : t("comments.emptyResolvedTitle")}
            description={filter === "open" ? (access.canComment ? t("comments.emptyHint") : t("comments.emptyReader")) : t("comments.emptyResolvedHint")}
          />
        )}
      </div>
      <SuggestionPopup />
    </div>
  );
}
