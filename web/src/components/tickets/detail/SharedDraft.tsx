// The ticket's shared draft (contracts/api.md "Drafts"): a reply staged on the ticket by a
// teammate or an AI agent over MCP, for whoever opens it next. It goes straight into an empty
// composer, to edit and send as your own reply; while the composer holds your own text it waits
// here with "Use it". A thin bar above the composer says who staged it and when. Arrives and
// leaves live through ticket_draft.updated (lib/realtime/apply.ts).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, PenLine, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { Ticket, TicketDraft } from "@/lib/api/types";
import { api } from "@/lib/api/endpoints";
import { relLong } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { q, qk } from "@/lib/queries";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";

// Which version of a ticket's draft went into the composer, so clearing the composer by hand
// does not pull the same one back in, and a replaced draft waits instead of overwriting edits.
const seeded = new Map<string, string>();

export function SharedDraftBar({ ticket, html, onUse, onClear, hold }: { ticket: Ticket; html: string; onUse: (html: string) => void; onClear: () => void; hold?: boolean }) {
  const { t } = useTranslation("inbox");
  const qc = useQueryClient();
  const reduced = useReducedMotion();
  const confirm = useConfirm();
  const key = qk.ticketDraft(ticket.id);
  const { data: draft } = useQuery(q.ticketDraft(ticket.id));
  const inComposer = !!draft && seeded.get(ticket.id) === draft.updated_at;
  const now = useNow(!!draft);

  // An empty composer takes the draft as it arrives, once my own saved reply (hold) has had its turn.
  useEffect(() => {
    if (!draft || html || inComposer || hold) return;
    seeded.set(ticket.id, draft.updated_at);
    onUse(draft.body_html);
  }, [draft, html, inComposer, hold, ticket.id, onUse]);

  const discard = useMutation({
    mutationFn: () => api.tickets.draft.discard(ticket.id),
    onMutate: () => {
      const prev = qc.getQueryData<TicketDraft | null>(key);
      qc.setQueryData<TicketDraft | null>(key, null);
      if (inComposer) onClear();
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(e, t("sharedDraft.discardFailed"));
    },
  });

  const use = (d: TicketDraft) => {
    const go = () => {
      seeded.set(ticket.id, d.updated_at);
      onUse(d.body_html);
    };
    if (html) confirm.show(t("sharedDraft.replaceBody", { name: d.by.name }), go, { title: t("sharedDraft.replaceTitle"), confirmLabel: t("sharedDraft.replaceConfirm") });
    else go();
  };

  return (
    <AnimatePresence initial={false}>
      {draft && (
        <motion.div
          key={draft.updated_at}
          role="status"
          aria-label={t("sharedDraft.label")}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
          transition={{ duration: 0.18 }}
          className="@container mb-2 flex min-h-9 items-center gap-2 rounded-md border border-line bg-sunken px-2 py-1 text-[12.5px]"
        >
          <PenLine className="ml-1 size-3.5 shrink-0 text-fg-3" aria-hidden />
          {draft.by.user ? (
            <Avatar name={draft.by.user.name} src={draft.by.user.avatar_url} size="xs" />
          ) : (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-fg-2">
              <Bot className="size-3" aria-hidden />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-fg-2" title={inComposer ? t("sharedDraft.inComposerHint") : undefined}>
            {t(inComposer ? "sharedDraft.inComposer" : "sharedDraft.waiting", { name: draft.by.name, when: relLong(draft.updated_at, now) })}
            {inComposer && <span className="hidden text-fg-3 @lg:inline"> · {t("sharedDraft.inComposerHint")}</span>}
          </span>
          {!inComposer && (
            <Button size="sm" onClick={() => use(draft)}>
              {t("sharedDraft.use")}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} loading={discard.isPending} onClick={() => discard.mutate()}>
            {t("sharedDraft.discard")}
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
