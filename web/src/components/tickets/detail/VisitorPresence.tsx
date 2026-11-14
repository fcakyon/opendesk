// On a chat ticket, whether the visitor is on the page now, by the signal the chat follow-up
// uses to decide whether a reply is also emailed (contracts/teams.md "Chat follow-up").
import { useQuery } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "@/components/ui/tooltip";
import type { Ticket } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { minutes } from "@/lib/format";
import { tone } from "@/lib/tones";
import { minutesAway, recheckIn, visitorPresence, visitorPresenceKey, type VisitorPresence } from "@/lib/visitorPresence";

/** The chat visitor's presence, live: reloaded when they come back ("customer_presence"), just after
 * the away threshold, and every minute; null for other tickets or before it loads. */
export function useVisitorPresence(ticket: Pick<Ticket, "id" | "channel" | "contact">): (VisitorPresence & { now: number }) | null {
  const enabled = ticket.channel === "chat" && !!ticket.contact;
  const q = useQuery({ queryKey: visitorPresenceKey(ticket.id), queryFn: () => visitorPresence(ticket.id), enabled, refetchInterval: 60_000, retry: false });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [enabled]);
  const { data, refetch } = q;
  useEffect(() => {
    const ms = data ? recheckIn(data, Date.now()) : null;
    if (ms === null) return;
    const id = setTimeout(() => void refetch(), ms);
    return () => clearTimeout(id);
  }, [data, refetch]);
  return enabled && data?.chat ? { ...data, now } : null;
}

/** "5 min", "1h 15m". */
export function awayFor(m: number): string {
  const n = Math.max(1, Math.floor(m));
  return n < 60 ? `${n} min` : minutes(n);
}

/** The line at the top of a chat ticket. */
export function VisitorPresenceBar({ p }: { p: (VisitorPresence & { now: number }) | null }) {
  const { t } = useTranslation("inbox");
  if (!p) return null;
  const away = minutesAway(p, p.now);
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line px-3 text-xs" data-testid="visitor-presence">
      <Tooltip content={t("visitorPresence.hint")}>
        <span tabIndex={0} className="flex min-w-0 items-center gap-1.5 rounded-sm outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]">
          <span className={cn("size-2 shrink-0 rounded-full", p.present ? "bg-tone-green-solid" : "bg-tone-gray-solid")} aria-hidden />
          <span className={cn("truncate", p.present ? cn("font-medium", tone.green.text) : "text-fg-3")}>
            {p.present ? t("visitorPresence.here") : away === null ? t("visitorPresence.never") : t("visitorPresence.away", { time: awayFor(away) })}
          </span>
        </span>
      </Tooltip>
      {!p.present && p.email_follow_up && (
        <span className="flex min-w-0 items-center gap-1.5 text-fg-3">
          <Mail className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{t("visitorPresence.email")}</span>
        </span>
      )}
    </div>
  );
}

/** The composer's delivery line on a chat ticket: in the chat, and by email while the visitor is away. */
export function chatReplyKey(p: VisitorPresence | null): "composer.chatReply" | "composer.chatReplyHere" | "composer.chatReplyAway" {
  if (!p) return "composer.chatReply";
  return !p.present && p.email_follow_up ? "composer.chatReplyAway" : "composer.chatReplyHere";
}
