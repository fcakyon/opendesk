// Reactions on a wiki comment: emoji chips with their counts (the reader's own one tinted,
// who reacted in the tooltip), and a small picker: the usual few at the top, then search
// and the wiki's emoji. Readers see them; people who may comment toggle them.

import { SmilePlus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { SearchInput } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import type { WikiReaction } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { EMOJI, searchEmoji } from "../emoji";

/** A comment takes up to this many different emoji (contracts/wiki.md "Comments"). */
export const MAX_REACTION_KINDS = 20;

export const QUICK_REACTIONS = ["👍", "❤️", "🎉", "😄", "👀", "🙏", "✅", "🚀"];

export function ReactionPicker({ onPick, trigger, open, onOpenChange }: { onPick: (emoji: string) => void; trigger: ReactNode; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation("wiki");
  const [query, setQuery] = useState("");
  const found = query.trim() ? searchEmoji(query) : null;
  const pick = (e: string) => {
    onPick(e);
    onOpenChange(false);
    setQuery("");
  };
  const cell = (e: string) => (
    <button
      key={e}
      type="button"
      onClick={() => pick(e)}
      aria-label={e}
      className="flex size-8 items-center justify-center rounded-md text-[18px] leading-none transition-[background-color,transform] hover:bg-hover focus-visible:bg-hover focus-visible:outline-none active:scale-90 motion-reduce:active:scale-100"
    >
      {e}
    </button>
  );
  return (
    <Popover open={open} onOpenChange={(o) => (onOpenChange(o), o || setQuery(""))} trigger={trigger} align="end" className="w-[292px] p-0">
      <div className="flex items-center justify-between gap-0.5 border-b border-line px-1.5 py-1.5">{QUICK_REACTIONS.map(cell)}</div>
      <div className="border-b border-line p-2">
        <SearchInput
          autoFocus
          value={query}
          onChange={setQuery}
          placeholder={t("comments.searchEmoji")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && found?.[0]) {
              e.preventDefault();
              pick(found[0]);
            }
          }}
        />
      </div>
      <div className="max-h-[220px] overflow-y-auto p-1.5" role="listbox" aria-label={t("comments.react")}>
        {found ? (
          found.length ? (
            <div className="grid grid-cols-8 gap-0.5">{found.map(cell)}</div>
          ) : (
            <p className="px-2 py-5 text-center text-[12.5px] text-fg-3">{t("icon.none")}</p>
          )
        ) : (
          EMOJI.map((g) => (
            <div key={g.id} className="mb-1.5 last:mb-0">
              <div className="label-caps px-1 pb-1 pt-0.5">{t(`icon.groups.${g.id}`)}</div>
              <div className="grid grid-cols-8 gap-0.5">{g.emoji.map(([e]) => cell(e))}</div>
            </div>
          ))
        )}
      </div>
    </Popover>
  );
}

/** "You, Maya Chen and Alex": who reacted, the reader first named "You". */
function useNames() {
  const { t } = useTranslation("wiki");
  const me = useSession((s) => s.user?.id);
  const { data: members = [] } = useQuery(q.members());
  return (ids: string[]) => {
    const names = ids.map((id) => (id === me ? t("comments.you") : (members.find((m) => m.user.id === id)?.user.name ?? t("comments.someone"))));
    return new Intl.ListFormat(undefined, { type: "conjunction" }).format(names);
  };
}

export function AddReaction({ onPick, className }: { onPick: (emoji: string) => void; className?: string }) {
  const { t } = useTranslation("wiki");
  const [open, setOpen] = useState(false);
  return (
    <ReactionPicker
      open={open}
      onOpenChange={setOpen}
      onPick={onPick}
      trigger={
        <Tooltip content={t("comments.react")}>
          <button
            type="button"
            aria-label={t("comments.react")}
            className={cn("flex size-6 items-center justify-center rounded-md text-fg-4 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg", className)}
          >
            <SmilePlus className="size-3.5" />
          </button>
        </Tooltip>
      }
    />
  );
}

export function Reactions({ reactions, canReact, onToggle }: { reactions: WikiReaction[]; canReact: boolean; onToggle: (emoji: string, on: boolean) => void }) {
  const { t } = useTranslation("wiki");
  const me = useSession((s) => s.user?.id);
  const names = useNames();
  if (!reactions.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {reactions.map((r) => {
        const mine = !!me && r.users.includes(me);
        return (
          <Tooltip key={r.emoji} content={t("comments.reactedWith", { names: names(r.users), emoji: r.emoji })}>
            <button
              type="button"
              disabled={!canReact}
              aria-pressed={mine}
              aria-label={t("comments.reactedWith", { names: names(r.users), emoji: r.emoji })}
              onClick={() => onToggle(r.emoji, !mine)}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-[12px] leading-none transition-colors disabled:cursor-default",
                mine ? "border-[color-mix(in_oklab,var(--tone-blue-solid)_40%,transparent)] bg-tone-blue-soft text-tone-blue" : "border-line bg-surface text-fg-2 enabled:hover:border-line-strong enabled:hover:bg-hover",
              )}
            >
              <span className="text-[13px]">{r.emoji}</span>
              <span className="mono tabular-nums">{r.users.length}</span>
            </button>
          </Tooltip>
        );
      })}
      {canReact && reactions.length < MAX_REACTION_KINDS && <AddReaction onPick={(e) => onToggle(e, !reactions.find((r) => r.emoji === e)?.users.includes(me ?? ""))} className="rounded-full" />}
    </div>
  );
}
