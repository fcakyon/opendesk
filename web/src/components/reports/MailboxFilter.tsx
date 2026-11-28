// "All mailboxes", "No mailbox" (chat, phone, API) or one mailbox, next to the team filter.
// The report then counts the tickets that reply from it (tickets.mailbox_id). Shown once the
// workspace has two mailboxes, and only to those who may list them (agents and up).

import { useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Picker, type PickerItem } from "@/components/ui/picker";
import type { Mailbox } from "@/lib/api/types";
import { q } from "@/lib/queries";
import { FilterButton } from "@/components/ui/button";

const ALL = "__all";
export const NO_MAILBOX = "none";
const none: Mailbox[] = [];

export function useReportMailboxes(): Mailbox[] {
  return useQuery({ ...q.mailboxes(), retry: false }).data ?? none;
}

/** The ticket-list filter for the open-work cards: the mailbox, or every mailbox left out for none. */
export function openWorkMailbox(mailbox: string | undefined, mailboxes: Mailbox[]): { mailbox_id?: string; mailbox_not?: string } {
  if (!mailbox) return {};
  if (mailbox !== NO_MAILBOX) return { mailbox_id: mailbox };
  return mailboxes.length ? { mailbox_not: mailboxes.map((m) => m.id).join(",") } : {};
}

const noMailboxMark = <span aria-hidden className="size-2 shrink-0 rounded-full border border-dashed border-line-strong" />;

export function MailboxFilter({ mailboxes, value, onChange }: { mailboxes: Mailbox[]; value: string | undefined; onChange: (v: string | undefined) => void }) {
  const { t } = useTranslation("reports");
  const sorted = [...mailboxes].sort((a, b) => a.name.localeCompare(b.name));
  const items: PickerItem[] = [
    { value: ALL, label: t("filter.allMailboxes"), icon: <Inbox className="text-fg-3" /> },
    { value: NO_MAILBOX, label: t("filter.noMailbox"), icon: noMailboxMark, hint: t("filter.noMailboxHint") },
    ...sorted.map((m) => ({ value: m.id, label: m.name, hint: m.email, keywords: [m.email], icon: <Inbox className="text-fg-3" /> })),
  ];
  const cur = value && value !== NO_MAILBOX ? mailboxes.find((m) => m.id === value) : undefined;
  const label = cur?.name ?? (value === NO_MAILBOX ? t("filter.noMailbox") : t("filter.allMailboxes"));
  return (
    <Picker
      items={items}
      value={value ?? ALL}
      onSelect={(v) => onChange(v === ALL ? undefined : v)}
      placeholder={t("filter.searchMailboxes")}
      trigger={
        <FilterButton
          aria-label={t("filter.mailboxLabel", { value: label })}
          active={!!value}
          icon={value === NO_MAILBOX ? noMailboxMark : <Inbox className="size-3.5 text-fg-3" />}
          label={label}
        />
      }
    />
  );
}
