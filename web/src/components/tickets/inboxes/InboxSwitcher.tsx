// Under an inbox folder's title, which ticket inbox it lists: every one, or one reply address
// (?mailbox=). Each inbox can also go to the sidebar as a section of its own from here.

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Inbox, PanelLeft, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useSaveSidebarPrefs, useSidebarPrefs } from "@/lib/collab/hooks";
import { isInboxSection, setInboxSection } from "@/lib/collab/inboxSections";
import { cn } from "@/lib/cn";
import { q } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { quickAdd } from "@/app/quickAdd";
import { useBackIntoLabel } from "./backInto";

export function InboxSwitcher({ mailbox, onPick }: { mailbox: string | undefined; onPick: (id: string | undefined) => void }) {
  const { t } = useTranslation("inbox");
  const role = useRole();
  const prefs = useSidebarPrefs();
  const save = useSaveSidebarPrefs();
  const backInto = useBackIntoLabel("mailbox");
  const { data: mailboxes } = useQuery(q.mailboxes());
  const list = mailboxes ?? [];
  // One address takes every ticket: nothing to switch between.
  if (list.length < 2 && !mailbox) return null;
  const current = list.find((m) => m.id === mailbox);
  const scope = current ? { kind: "mailbox" as const, id: current.id } : null;
  const inSection = scope ? isInboxSection(prefs, scope) : false;
  return (
    <div className="flex items-center gap-1 px-4 pb-2">
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={t("inboxes.switcher")}
            className={cn(
              "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-line px-2 text-xs text-fg-2 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover",
              current && "border-line-strong text-fg",
            )}
          >
            <Inbox className="size-3.5 shrink-0 text-fg-3" />
            <span className="truncate">{current ? current.name || current.email : t("inboxes.allInboxes")}</span>
            <ChevronDown className="size-3 shrink-0 text-fg-4" />
          </button>
        </MenuTrigger>
        <MenuContent align="start" className="w-[260px]">
          <MenuLabel>{t("inboxes.switcher")}</MenuLabel>
          <MenuItem icon={<Check className={cn(mailbox && "invisible")} />} onSelect={() => onPick(undefined)}>
            {t("inboxes.allInboxes")}
          </MenuItem>
          {list.map((m) => (
            <MenuItem key={m.id} icon={<Check className={cn(m.id !== mailbox && "invisible")} />} onSelect={() => onPick(m.id)}>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{m.name || m.email}</span>
                {m.name && <span className="mono min-w-0 truncate text-[11px] text-fg-4">{m.email}</span>}
              </span>
            </MenuItem>
          ))}
          {atLeast(role, "admin") && (
            <>
              <MenuSeparator />
              <MenuItem icon={<Plus />} onSelect={() => quickAdd.inbox({})}>
                {t("inboxes.add")}
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
      {scope && (
        <button
          type="button"
          onClick={() => save.mutate(setInboxSection(prefs, scope, !inSection), { onError: (e) => toast.error(e, t("inboxes.saveFailed")) })}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          <PanelLeft className="size-3.5" />
          {inSection ? backInto : t("inboxes.ownSection")}
        </button>
      )}
    </div>
  );
}
