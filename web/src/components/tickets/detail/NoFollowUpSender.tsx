import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Ticket } from "@/lib/api/types";
import { chatFollowUpByEmail, followUpMailbox, type TeamsCtx } from "../teams";

/**
 * On a chat whose replies are emailed to the visitor once they leave, says when its brand has
 * no address that can send them, so the reply reaches the visitor in the chat only
 * (contracts/teams.md "Chat follow-up").
 */
export function NoFollowUpSender({ ticket, ctx }: { ticket: Ticket; ctx: TeamsCtx }) {
  const { t } = useTranslation("inbox");
  if (!chatFollowUpByEmail(ctx, ticket) || followUpMailbox(ctx, ticket)) return null;
  return (
    <p
      className="flex items-start gap-1.5 border-b border-line-soft px-3 py-1.5 text-[11.5px] leading-4 text-fg-2 animate-fade-in motion-reduce:animate-none"
      role="status"
    >
      <TriangleAlert className="mt-px size-3 shrink-0 text-tone-amber" aria-hidden />
      {t("composer.noFollowUpSender")}
    </p>
  );
}
