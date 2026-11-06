// One thread in the page panel: the text it is on (inline threads) as a quiet excerpt
// that finds it in the page, its comments with reactions, and a reply line that opens
// as it is used. Resolving puts it away (with a way back); a reply brings it back.

import { Check, CornerUpLeft, Link2, MoreHorizontal, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RichEditor } from "@/components/editor/RichEditor";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { copyText } from "@/components/ui/copy-button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import type { WikiComment, WikiThread } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { isBlankHtml } from "@/lib/collab/html";
import { fullDate, relShort } from "@/lib/format";
import { ease } from "@/lib/motion";
import { sanitizeHtml } from "@/lib/sanitize";
import { useNow } from "@/lib/useNow";
import { draftKey, threadUrl } from "@/lib/wiki/comments";
import { Composer, useMentions } from "./Composer";
import { useCommentActions } from "./hooks";
import { AddReaction, MAX_REACTION_KINDS, Reactions } from "./Reactions";

export type ThreadAccess = { me: string | null; admin: boolean; canComment: boolean };

/** "5m", ticking in its own small component. */
function When({ iso }: { iso: string }) {
  const now = useNow();
  return (
    <Tooltip content={fullDate(iso)}>
      <time dateTime={iso} className="shrink-0 text-[11px] text-fg-4">
        {relShort(iso, now)}
      </time>
    </Tooltip>
  );
}

const iconBtn =
  "flex size-6 items-center justify-center rounded-md text-fg-4 transition-colors hover:bg-hover hover:text-fg focus-visible:opacity-100 data-[state=open]:bg-hover data-[state=open]:text-fg [&_svg]:size-3.5";

function CommentItem({ c, thread, pageId, access, first, fresh }: { c: WikiComment; thread: WikiThread; pageId: string; access: ThreadAccess; first: boolean; fresh: boolean }) {
  const { t } = useTranslation("wiki");
  const confirm = useConfirm();
  const actions = useCommentActions(pageId);
  const mine = !!c.author && c.author.id === access.me;
  const [editing, setEditing] = useState(false);
  const [html, setHtml] = useState(c.body_html);
  const [saving, setSaving] = useState(false);
  const extensions = useMentions();
  const body = useMemo(() => sanitizeHtml(c.body_html), [c.body_html]);
  const name = c.author?.name ?? t("comments.someone");
  const resolved = !!thread.resolved_at;

  const save = async () => {
    if (isBlankHtml(html) || saving) return;
    setSaving(true);
    try {
      await actions.update(c.id, html);
      setEditing(false);
    } catch (e) {
      toast.error(e, t("comments.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  const remove = () =>
    confirm.show(first ? t("comments.deleteThreadConfirm") : t("comments.deleteConfirm"), () => actions.remove(c.id), {
      title: first ? t("comments.deleteThreadTitle") : t("comments.deleteTitle"),
      confirmLabel: t("comments.delete"),
      danger: true,
    });
  const resolve = async (on: boolean) => {
    try {
      await actions.resolve(thread.id, on);
      if (on) toast.undo(t("comments.resolvedToast"), () => void actions.resolve(thread.id, false).catch((e) => toast.error(e)), t("comments.undo"));
    } catch (e) {
      toast.error(e, t("comments.resolveFailed"));
    }
  };
  const react = (emoji: string, on: boolean) => void actions.react(c.id, emoji, on).catch((e) => toast.error(e, t("comments.reactFailed")));
  const copyLink = () => {
    void copyText(threadUrl(location.origin, pageId, thread.id));
    toast.success(t("comments.linkCopied"));
  };

  return (
    <div id={`wiki-comment-${c.id}`} className="group/comment relative flex gap-2">
      {fresh && (
        // A comment that arrived while the thread is open glows once.
        <motion.span aria-hidden className="pointer-events-none absolute -inset-x-1.5 -inset-y-1 rounded-md bg-hover" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 1.4, delay: 0.4, ease: ease.out }} />
      )}
      <Avatar name={name} src={c.author?.avatar_url} size="xs" className="relative mt-[3px]" />
      <div className="relative min-w-0 flex-1">
        <div className="flex h-6 items-center gap-1.5">
          <span className="min-w-0 truncate text-[12.5px] font-medium text-fg">{name}</span>
          <When iso={c.created_at} />
          {c.edited_at && (
            <Tooltip content={fullDate(c.edited_at)}>
              <span className="shrink-0 text-[11px] text-fg-4">{t("comments.edited")}</span>
            </Tooltip>
          )}
          {!editing && (
            <span className="ml-auto flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/comment:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100">
              {access.canComment && c.reactions.length < MAX_REACTION_KINDS && <AddReaction onPick={(e) => react(e, !c.reactions.find((r) => r.emoji === e)?.users.includes(access.me ?? ""))} />}
              {first && access.canComment && !resolved && (
                <Tooltip content={t("comments.resolve")}>
                  <button type="button" aria-label={t("comments.resolve")} className={iconBtn} onClick={() => void resolve(true)}>
                    <Check />
                  </button>
                </Tooltip>
              )}
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" aria-label={t("comments.menu")} className={iconBtn}>
                    <MoreHorizontal />
                  </button>
                </MenuTrigger>
                <MenuContent align="end">
                  {mine && access.canComment && (
                    <MenuItem
                      icon={<Pencil />}
                      onSelect={() => {
                        setHtml(c.body_html);
                        setEditing(true);
                      }}
                    >
                      {t("comments.edit")}
                    </MenuItem>
                  )}
                  <MenuItem icon={<Link2 />} onSelect={copyLink}>
                    {t("comments.copyLink")}
                  </MenuItem>
                  {access.canComment && (mine || access.admin) && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 />} danger onSelect={remove}>
                        {first ? t("comments.deleteThread") : t("comments.delete")}
                      </MenuItem>
                    </>
                  )}
                </MenuContent>
              </Menu>
            </span>
          )}
        </div>
        {editing ? (
          <div className="mt-0.5 rounded-lg border border-line-strong bg-surface shadow-xs">
            <RichEditor
              value={html}
              onChange={setHtml}
              extensions={extensions}
              autofocus
              toolbar="none"
              contentClassName="min-h-[40px] px-2 py-1.5 text-[12.5px] leading-5"
              ariaLabel={t("comments.edit")}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return false;
                setEditing(false);
                return true;
              }}
              onSubmit={() => void saveRef.current()}
            />
            <div className="flex justify-end gap-1.5 px-2 pb-2">
              <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                {t("comments.cancel")}
              </Button>
              <Tooltip content={t("comments.save")} shortcut="mod enter">
                <Button size="xs" variant="primary" loading={saving} disabled={isBlankHtml(html)} onClick={() => void save()}>
                  {t("comments.save")}
                </Button>
              </Tooltip>
            </div>
          </div>
        ) : (
          <div className="prose-od wiki-comment-body text-[12.5px] leading-5 text-fg" data-ph-mask dangerouslySetInnerHTML={{ __html: body }} />
        )}
        <Reactions reactions={c.reactions} canReact={access.canComment} onToggle={react} />
      </div>
    </div>
  );
}

export function ThreadCard({
  thread,
  pageId,
  access,
  active,
  onActivate,
  onReveal,
}: {
  thread: WikiThread;
  pageId: string;
  access: ThreadAccess;
  active: boolean;
  onActivate: () => void;
  /** Finds the thread's text in the page; false when it is gone. */
  onReveal: () => boolean;
}) {
  const { t } = useTranslation("wiki");
  const reduce = useReducedMotion();
  const actions = useCommentActions(pageId);
  const ref = useRef<HTMLElement>(null);
  // The comments there when it showed; any other arrived since, and glows once.
  const seen = useRef<Set<string> | null>(null);
  seen.current ??= new Set(thread.comments.map((c) => c.id));
  const resolved = !!thread.resolved_at;
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [active, reduce]);

  return (
    <motion.article
      ref={ref}
      layout={reduce ? false : "position"}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.18, ease: ease.out }}
      aria-label={thread.inline ? t("comments.threadOn", { quote: thread.quote }) : t("comments.pageThread")}
      aria-current={active || undefined}
      onClick={(e) => {
        // Buttons, links and the reply line do their own thing.
        if ((e.target as Element).closest("button, a, [contenteditable=true], [role=menuitem]")) return;
        onActivate();
      }}
      className={cn(
        "group/thread scroll-my-3 rounded-xl border bg-surface px-3 pb-2.5 pt-2 transition-[border-color,box-shadow] duration-150",
        active ? "border-[color-mix(in_oklab,var(--tone-amber-solid)_55%,var(--line))] shadow-[0_0_0_3px_var(--tone-amber-soft)]" : "border-line hover:border-line-strong",
      )}
    >
      {thread.inline && (
        <button
          type="button"
          onClick={() => {
            onActivate();
            setLost(!onReveal());
          }}
          title={lost ? t("comments.quoteGone") : undefined}
          className="mb-1.5 flex w-full items-stretch gap-2 rounded-md py-0.5 text-left transition-colors hover:bg-hover"
        >
          <span aria-hidden className={cn("w-[2px] shrink-0 rounded-full", resolved || lost ? "bg-line-strong" : "bg-tone-amber-solid")} />
          <span className={cn("line-clamp-2 min-w-0 text-[12px] leading-[17px]", lost ? "text-fg-4 line-through decoration-fg-4/40" : "text-fg-3")}>{thread.quote}</span>
        </button>
      )}
      {resolved && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-fg-3">
          <Check className="size-3 text-tone-green" strokeWidth={2.5} />
          <span className="min-w-0 flex-1 truncate">{thread.resolved_by ? t("comments.resolvedBy", { name: thread.resolved_by.name }) : t("comments.resolved")}</span>
          {access.canComment && (
            <Button size="xs" variant="ghost" icon={<RotateCcw />} onClick={() => void actions.resolve(thread.id, false).catch((e) => toast.error(e, t("comments.resolveFailed")))}>
              {t("comments.reopen")}
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        {thread.comments.map((c, i) => (
          <CommentItem key={c.id} c={c} thread={thread} pageId={pageId} access={access} first={i === 0} fresh={!seen.current?.has(c.id)} />
        ))}
      </div>
      {access.canComment && (
        <Composer
          className="mt-2.5"
          draftKey={draftKey(pageId, thread.id)}
          placeholder={resolved ? t("comments.replyReopens") : t("comments.reply")}
          sendLabel={t("comments.send")}
          leading={<CornerUpLeft className="size-3.5 text-fg-4" />}
          onSend={(html) => actions.create({ body_html: html, thread_id: thread.id })}
        />
      )}
    </motion.article>
  );
}
