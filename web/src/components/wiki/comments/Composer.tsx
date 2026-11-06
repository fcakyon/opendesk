// Writing a comment: one line until it is used, then the editor with its buttons. What is
// typed waits per thread (lib/wiki/comments.ts drafts) while the reader looks elsewhere.
// @ mentions a teammate (the ticket notes' list); Mod+Enter sends, Escape steps out.

import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RichEditor, type RichEditorHandle } from "@/components/editor/RichEditor";
import { mentionExtension, useSuggest } from "@/components/tickets/detail/suggestions";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import type { Member } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { isBlankHtml } from "@/lib/collab/html";
import { dur, ease } from "@/lib/motion";
import { q } from "@/lib/queries";
import { forgetDraft, keepDraft, readDraft } from "@/lib/wiki/comments";

export function useMentions() {
  const { data: members } = useQuery(q.members());
  const ref = useRef<Member[]>([]);
  ref.current = members ?? [];
  // One extension per editor; it reads the members as they are when @ is typed.
  return useMemo(() => [mentionExtension(() => ref.current)], []);
}

export type ComposerHandle = { focus: () => void };

const open = { duration: dur.base, ease: ease.out };

export const Composer = forwardRef<
  ComposerHandle,
  {
    draftKey: string;
    placeholder: string;
    sendLabel: string;
    onSend: (html: string) => Promise<unknown>;
    /** Cancel also lets go of what this composer is for (a new inline thread). */
    onCancel?: () => void;
    autoFocus?: boolean;
    /** Opened from the start, as for a new inline thread. */
    expanded?: boolean;
    leading?: ReactNode;
    className?: string;
  }
>(function Composer({ draftKey, placeholder, sendLabel, onSend, onCancel, autoFocus, expanded, leading, className }, ref) {
  const { t } = useTranslation("wiki");
  const reduce = useReducedMotion();
  const extensions = useMentions();
  const editor = useRef<RichEditorHandle>(null);
  const [html, setHtmlState] = useState(() => readDraft(draftKey));
  const [focused, setFocused] = useState(!!autoFocus);
  const [busy, setBusy] = useState(false);
  const setHtml = (v: string) => {
    setHtmlState(v);
    keepDraft(draftKey, v, isBlankHtml(v));
  };
  const writing = expanded || focused || !isBlankHtml(html);

  const send = async () => {
    const body = editor.current?.editor?.getHTML() ?? html;
    if (isBlankHtml(body) || busy) return;
    setBusy(true);
    try {
      await onSend(body);
      forgetDraft(draftKey);
      editor.current?.clear();
      setHtmlState("");
    } catch (e) {
      toast.error(e, t("comments.sendFailed"));
    } finally {
      setBusy(false);
    }
  };
  // The editor keeps the handlers it was made with: they read the latest through these.
  const sendRef = useRef(send);
  sendRef.current = send;
  const leave = () => {
    editor.current?.editor?.commands.blur();
    setFocused(false);
  };
  const cancel = () => {
    editor.current?.clear();
    setHtml("");
    forgetDraft(draftKey);
    leave();
    onCancel?.();
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  useImperativeHandle(ref, () => ({ focus: () => editor.current?.focus() }), []);

  return (
    <div
      className={cn(
        "rounded-lg border border-line bg-surface transition-[border-color,box-shadow] duration-150 hover:border-line-strong",
        writing && "border-line-strong shadow-xs",
        className,
      )}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="flex items-start gap-2 pl-2">
        {leading && <span className="mt-[5px] shrink-0">{leading}</span>}
        <RichEditor
          ref={editor}
          value={html}
          onChange={setHtml}
          extensions={extensions}
          toolbar="none"
          autofocus={autoFocus}
          placeholder={placeholder}
          ariaLabel={placeholder}
          className="max-h-[40vh] min-w-0 flex-1"
          contentClassName={cn("min-h-0 py-[6px] pl-0 pr-2 text-[12.5px] leading-5", writing && "min-h-[40px]")}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            // Escape steps out (a mention list open closes first); an empty new thread goes with it.
            if (e.key !== "Escape" || useSuggest.getState().open) return false;
            if (onCancel && isBlankHtml(editor.current?.editor?.getHTML() ?? "")) cancelRef.current();
            else leaveRef.current();
            return true;
          }}
          onSubmit={() => void sendRef.current()}
        />
      </div>
      <AnimatePresence initial={false}>
        {writing && (
          <motion.div
            key="actions"
            initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={open}
            className="overflow-hidden"
          >
            <div className="flex items-center justify-end gap-1.5 px-2 pb-2">
              <Button size="xs" variant="ghost" onClick={cancel}>
                {t("comments.cancel")}
              </Button>
              <Tooltip content={sendLabel} shortcut="mod enter">
                <Button size="xs" variant="primary" loading={busy} disabled={isBlankHtml(html)} onClick={() => void send()}>
                  {sendLabel}
                </Button>
              </Tooltip>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
