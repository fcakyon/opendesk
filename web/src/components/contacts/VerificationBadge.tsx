// Whether a chat visitor proved who they are (contracts/api.md "Contact verification"): verified
// by opening the link emailed to the address they gave in the widget, or by signing in on the
// widget with identity verification. The contact's own query feeds it, so contact.updated turns
// "Unverified" into "Verified" live wherever it shows.
import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, CircleDashed } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import type { ContactVerification, Ticket } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";

/** A chat's visitor verification, from the contact query the side panel shares; null for other tickets. */
export function useChatVerification(ticket: Pick<Ticket, "channel" | "contact">): ContactVerification | null {
  const id = ticket.contact?.id ?? "";
  const chat = ticket.channel === "chat" && !!id;
  const { data } = useQuery({ ...q.contact(id), enabled: chat, retry: false });
  return chat ? (data?.verification ?? null) : null;
}

/** "Verified" or "Unverified" with what it means on hover; nothing for a contact the widget did not identify. */
export function VerificationBadge({ v, className }: { v: ContactVerification | null | undefined; className?: string }) {
  const { t } = useTranslation("inbox");
  if (!v || v.status === "none") return null;
  const ok = v.status === "verified";
  const hint = ok ? (v.via === "identity" ? t("contact.verifiedByIdentity") : t("contact.verifiedByEmail")) : t("contact.unverifiedHint");
  const Icon = ok ? BadgeCheck : CircleDashed;
  return (
    <Tooltip content={hint}>
      <span
        tabIndex={0}
        data-testid="contact-verification"
        data-status={v.status}
        className={cn("flex shrink-0 rounded-sm outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]", className)}
      >
        <Badge tone={ok ? "green" : "amber"}>
          <Icon className="size-3" aria-hidden />
          {ok ? t("contact.verified") : t("contact.unverified")}
        </Badge>
      </span>
    </Tooltip>
  );
}
