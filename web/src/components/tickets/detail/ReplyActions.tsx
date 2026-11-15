// The actions of the saved replies used in a draft, shown above it so nothing happens
// silently: "+ refund", "− new", "→ Billing", "→ Ada". They apply to the ticket only once the
// message is sent.

import { X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Member, SavedReply, SavedReplyActions } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { tone } from "@/lib/tones";

/** The merged actions of the replies used, in the order they were used (a later team or assignee wins). */
export function mergeReplyActions(replies: SavedReply[], ids: string[]): SavedReplyActions {
  const add: string[] = [];
  const remove: string[] = [];
  let team: string | null | undefined;
  let assignee: string | null | undefined;
  for (const id of ids) {
    const a = replies.find((r) => r.id === id)?.actions;
    if (!a) continue;
    for (const t of a.add_tags ?? []) if (!add.some((x) => x.toLowerCase() === t.toLowerCase())) add.push(t);
    for (const t of a.remove_tags ?? []) if (!remove.some((x) => x.toLowerCase() === t.toLowerCase())) remove.push(t);
    if (a.team_id) team = a.team_id;
    if (a.assignee_id) assignee = a.assignee_id;
  }
  return {
    add_tags: add,
    remove_tags: remove.filter((t) => !add.some((x) => x.toLowerCase() === t.toLowerCase())),
    team_id: team ?? null,
    assignee_id: assignee ?? null,
  };
}

/** The chips' texts for these actions. */
export function replyActionLabels(a: SavedReplyActions, teamName: (id: string) => string | undefined, members: Member[]): string[] {
  const out = [...(a.add_tags ?? []).map((t) => `+ ${t}`), ...(a.remove_tags ?? []).map((t) => `− ${t}`)];
  if (a.team_id) out.push(`→ ${teamName(a.team_id) ?? "?"}`);
  if (a.assignee_id) out.push(`→ ${members.find((m) => m.user.id === a.assignee_id)?.user.name ?? "?"}`);
  return out;
}

export function ReplyActionChips({ labels, onDrop }: { labels: string[]; onDrop: () => void }) {
  const { t } = useTranslation("inbox");
  if (!labels.length) return null;
  return (
    <div role="status" className={cn("mx-3 mb-2 flex items-start gap-2 rounded-md px-2.5 py-1.5 text-[12px]", tone.blue.soft)}>
      <Zap className={cn("mt-1 size-3.5 shrink-0", tone.blue.text)} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        <span className="text-fg-2">{t("composer.replyActions")}</span>
        {labels.map((l) => (
          <span key={l} className="mono rounded bg-surface px-1.5 py-0.5 text-[11.5px] text-fg ring-1 ring-line">
            {l}
          </span>
        ))}
      </span>
      <button
        type="button"
        aria-label={t("composer.dropReplyActions")}
        title={t("composer.dropReplyActions")}
        onClick={onDrop}
        className="flex size-5 shrink-0 items-center justify-center rounded text-fg-3 hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
