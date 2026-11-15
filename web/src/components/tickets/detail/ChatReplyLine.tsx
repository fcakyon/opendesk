// On a chat ticket the reply goes to the live chat, and by email only when the visitor has
// left (contracts/teams.md "Chat follow-up"): "To <email>" read as an email reply.
import { MessagesSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "@/components/ui/tooltip";
import type { Ticket } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { tone } from "@/lib/tones";
import type { VisitorPresence } from "@/lib/visitorPresence";
import { chatReplyKey, useVisitorPresence } from "./VisitorPresence";

export function ChatReplyLine({ ticket }: { ticket: Pick<Ticket, "id" | "channel" | "contact"> }) {
  return <ChatReplyText p={useVisitorPresence(ticket)} />;
}

export function ChatReplyText({ p }: { p: VisitorPresence | null }) {
  const { t } = useTranslation("inbox");
  return (
    <Tooltip content={t("composer.chatReplyHint")}>
      <span tabIndex={0} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-xs text-fg-3 outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]">
        <MessagesSquare className={cn("size-3.5 shrink-0", tone.cyan.text)} />
        <span className="min-w-0 truncate">{t(chatReplyKey(p))}</span>
      </span>
    </Tooltip>
  );
}
