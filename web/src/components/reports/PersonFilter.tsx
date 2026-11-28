// "All people" or one member, next to the team filter. The report then counts that member's
// tickets (overview) and shows their row alone (Agents). Admins pick anyone; another member
// only themselves, as the server allows.

import { useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@/components/ui/avatar";
import { Picker, type PickerItem } from "@/components/ui/picker";
import type { Member } from "@/lib/api/types";
import { q } from "@/lib/queries";
import { atLeast, useRole, useSession } from "@/lib/session";
import { FilterButton } from "@/components/ui/button";

const ALL = "__all";
const none: Member[] = [];

/** The people the caller may narrow the report to: every member but viewers for admins, else themselves. */
export function reportPeople(members: Member[], me: string, admin: boolean): Member[] {
  return members
    .filter((m) => m.role !== "viewer" && (admin || m.user.id === me))
    .sort((a, b) => a.user.name.localeCompare(b.user.name));
}

export function PersonFilter({ value, onChange }: { value: string | undefined; onChange: (v: string | undefined) => void }) {
  const { t } = useTranslation("reports");
  const me = useSession((s) => s.user?.id ?? "");
  const admin = atLeast(useRole(), "admin");
  const members = useQuery({ ...q.members(), retry: false }).data ?? none;
  const people = reportPeople(members, me, admin);
  const items: PickerItem[] = [
    { value: ALL, label: t("filter.allPeople"), icon: <UserRound className="text-fg-3" /> },
    ...people.map((m) => ({ value: m.user.id, label: m.user.name, icon: <Avatar name={m.user.name} src={m.user.avatar_url} size="xs" />, keywords: [m.user.email] })),
  ];
  const cur = value ? members.find((m) => m.user.id === value) : undefined;
  const label = cur?.user.name ?? t("filter.allPeople");
  return (
    <Picker
      items={items}
      value={value ?? ALL}
      onSelect={(v) => onChange(v === ALL ? undefined : v)}
      placeholder={t("filter.searchPeople")}
      trigger={
        <FilterButton
          aria-label={t("filter.personLabel", { value: label })}
          active={!!value}
          icon={cur ? <Avatar name={cur.user.name} src={cur.user.avatar_url} size="xs" /> : <UserRound className="size-3.5 text-fg-3" />}
          label={label}
        />
      }
    />
  );
}
