// The AI teammate's identity inside tickets: its name (assistant_name from the
// AI config, "Ollie" by default), a tiny still Ollie on things it set, and the
// Ollie blob as the avatar on timeline lines it authored.

import { cn } from "@/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { q } from "@/lib/queries";
import { OllieMark } from "@/components/assistant/OllieMark";
import { useAssistantName } from "@/components/assistant/name";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "react-i18next";
import type { DecisionField, Ticket } from "@/lib/api/types";
import { aiDecisions, decisionNote } from "@/lib/decisions";

export { useAssistantName };

/** An activity or message the AI authored (contracts/ai.md: actor_type "ai"). */
export function isAIActor(actor: { type: string } | null | undefined) {
  return actor?.type === "ai";
}

/** What to say about a value the AI chose: "Ollie set this · 92% sure", or "Ollie set this". */
export function useOllieNote() {
  const { t } = useTranslation("inbox");
  const name = useAssistantName();
  return (ticket: Pick<Ticket, "custom"> | null | undefined, field?: DecisionField) => {
    const n = field ? decisionNote(aiDecisions(ticket), field) : null;
    const parts = [t("ollie.setThis", { name })];
    if (n?.sure != null) parts.push(t("ollie.sure", { pct: n.sure }));
    if (n?.threshold != null) parts.push(t("ollie.threshold", { pct: n.threshold }));
    return parts.join(" · ");
  };
}

/** A tiny still Ollie with "Set by Ollie"; sits on a value the AI chose. `note` replaces the tooltip. */
export function SetByOllie({ className, note, size = 12 }: { className?: string; note?: string; size?: number }) {
  const { t } = useTranslation("inbox");
  const name = useAssistantName();
  const label = note ?? t("ollie.setBy", { name });
  return (
    <Tooltip content={label}>
      <span role="img" aria-label={label} className={cn("ollie-still inline-flex shrink-0 rounded-full", className)} style={{ width: size, height: size }}>
        <OllieMark size={size} eyes={false} />
      </span>
    </Tooltip>
  );
}

/** The actor avatar on timeline lines and messages the AI wrote. */
export function OllieAvatar({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}>
      <OllieMark size={size} eyes={size >= 16} />
    </span>
  );
}

/**
 * Which of a ticket's current values the AI chose last: the latest activity of
 * each kind decides, so an agent changing it afterwards clears the mark.
 */
export function useAISet(ticketId: string) {
  const { data } = useQuery(q.activities(ticketId));
  const last: Record<string, boolean> = {};
  const tags = new Set<string>();
  for (const a of [...(data ?? [])].sort((x, y) => x.created_at.localeCompare(y.created_at))) {
    const ai = isAIActor(a.actor);
    if (a.type === "priority_changed" || a.type === "severity_changed" || a.type === "status_changed" || a.type === "assigned" || a.type === "team_changed") last[a.type] = ai;
    const tag = typeof a.data.tag === "string" ? a.data.tag : undefined;
    if (tag && a.type === "tagged") {
      if (ai) tags.add(tag);
      else tags.delete(tag);
    }
    if (tag && a.type === "untagged") tags.delete(tag);
  }
  return { priority: !!last.priority_changed, severity: !!last.severity_changed, team: !!last.team_changed, status: !!last.status_changed, assignee: !!last.assigned, tags };
}
