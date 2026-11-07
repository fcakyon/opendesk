// A page's aliases (contracts/wiki.md "Aliases", Obsidian's): other names it goes by, which
// links, page search and unlinked mentions find it by. Small chips under the title ("Also
// called …") and in the page panel's Info. Changing them keeps the page's version, so a tab
// typing on the page never conflicts with them; they save at once.

import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import type { WikiNode, WikiPage } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { qk } from "@/lib/queries";
import { patchTree } from "./hooks";

export const MAX_ALIASES = 10;
export const MAX_ALIAS = 100;

/** Aliases as the API keeps them: whitespace folded, empty ones and repeats (any case) left out, at most 10. */
export function cleanAliases(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const a = raw.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_ALIAS);
    if (a && !out.some((o) => o.toLowerCase() === a.toLowerCase())) out.push(a);
  }
  return out.slice(0, MAX_ALIASES);
}

const withAliases = (n: WikiNode, aliases: string[]): WikiNode => {
  const { aliases: _, ...rest } = n;
  return aliases.length ? { ...rest, aliases } : rest;
};

/** Saves the page's aliases, shown at once and put back if the save fails. */
export function useSaveAliases(page: WikiPage) {
  const qc = useQueryClient();
  const { t } = useTranslation("wiki");
  return useCallback(
    async (next: string[]) => {
      const before = page.aliases ?? [];
      const show = (aliases: string[]) => {
        qc.setQueryData<WikiPage>(qk.wikiPage(page.id), (old) => (old ? { ...old, aliases } : old));
        patchTree(qc, (nodes) => nodes.map((n) => (n.id === page.id ? withAliases(n, aliases) : n)));
      };
      const aliases = cleanAliases(next);
      if (aliases.join("\u0000") === before.join("\u0000")) return;
      show(aliases);
      try {
        const saved = await api.wiki.update(page.id, { aliases });
        show(saved.aliases ?? []);
      } catch (e) {
        show(before);
        toast.error(e, t("aliases.failed"));
      }
    },
    [page.id, page.aliases, qc, t],
  );
}

type Props = {
  page: WikiPage;
  canEdit: boolean;
  /** The add field is open (the title's "Add alias" opens it). */
  adding: boolean;
  onAdding: (open: boolean) => void;
  /** "title": the line under the title, shown only with aliases or while adding; "panel": the Info tab's section. */
  variant: "title" | "panel";
};

export function AliasChips({ page, canEdit, adding, onAdding, variant }: Props) {
  const { t } = useTranslation("wiki");
  const save = useSaveAliases(page);
  const aliases = page.aliases ?? [];
  const full = aliases.length >= MAX_ALIASES;
  if (variant === "title" && !aliases.length && !adding) return null;
  const remove = (a: string) => void save(aliases.filter((x) => x !== a));
  return (
    <div
      className={cn("flex flex-wrap items-center gap-1 text-[12.5px] text-fg-3", variant === "title" && "mt-1.5 motion-safe:animate-fade-in")}
      aria-label={t("aliases.label")}
      role="group"
      // Paper shows the page, not its other names (editor/print.ts).
      data-print={variant === "title" ? "hide" : undefined}
    >
      {variant === "title" && <span className="mr-0.5">{t("aliases.alsoCalled")}</span>}
      {aliases.map((a) => (
        <span key={a} className="group/alias inline-flex h-6 max-w-full items-center gap-0.5 rounded-md bg-hover pl-1.5 pr-1 text-[12px] text-fg-2">
          <span className="truncate">{a}</span>
          {canEdit ? (
            <button
              type="button"
              aria-label={t("aliases.remove", { alias: a })}
              onClick={() => remove(a)}
              className="flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-4 opacity-60 transition-opacity hover:bg-active hover:text-fg hover:opacity-100 focus-visible:opacity-100 group-hover/alias:opacity-100"
            >
              <X className="size-3" />
            </button>
          ) : (
            <span className="w-0.5" />
          )}
        </span>
      ))}
      {canEdit && adding && !full && (
        <AliasInput
          onAdd={(a) => void save([...aliases, a])}
          onRemoveLast={() => aliases.length && remove(aliases[aliases.length - 1])}
          onClose={() => onAdding(false)}
        />
      )}
      {canEdit && !adding && !full && (aliases.length > 0 || variant === "panel") && (
        <button
          type="button"
          onClick={() => onAdding(true)}
          aria-label={t("aliases.add")}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--focus)]"
        >
          <Plus className="size-3" />
          {variant === "panel" && !aliases.length ? t("aliases.add") : null}
        </button>
      )}
      {variant === "panel" && !aliases.length && !canEdit && <span className="text-[12px] text-fg-4">{t("aliases.empty")}</span>}
      {canEdit && full && variant === "panel" && <span className="w-full text-[11.5px] text-fg-4">{t("aliases.full")}</span>}
    </div>
  );
}

/** The field a new alias is typed in: Enter or a comma adds it and keeps the field for the next; Escape or leaving closes it. */
function AliasInput({ onAdd, onRemoveLast, onClose }: { onAdd: (a: string) => void; onRemoveLast: () => void; onClose: () => void }) {
  const { t } = useTranslation("wiki");
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const commit = () => {
    const a = value.trim();
    if (a) onAdd(a);
    setValue("");
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Backspace" && !value) onRemoveLast();
  };
  return (
    <input
      ref={ref}
      value={value}
      maxLength={MAX_ALIAS}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={key}
      onBlur={() => {
        commit();
        onClose();
      }}
      placeholder={t("aliases.placeholder")}
      aria-label={t("aliases.add")}
      className="h-6 w-36 rounded-md border border-line bg-surface px-1.5 text-[12px] text-fg outline-none placeholder:text-fg-4 focus-visible:shadow-[0_0_0_2px_var(--focus)]"
    />
  );
}
