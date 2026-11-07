// What a wiki page shows about itself above or beside its text: that it is in the trash
// (with Restore and Delete for good), that it is a template (with Use), that someone
// verified it (and until when), and for a daily note, the days around it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BadgeCheck, CalendarDays, ChevronLeft, ChevronRight, LayoutTemplate, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Calendar, parseDay } from "@/components/ui/date-picker";
import { useConfirm } from "@/components/ui/confirm";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Popover } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { WikiPage } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { fullDate, longDate, relLong } from "@/lib/format";
import { q, qk } from "@/lib/queries";
import { useNow } from "@/lib/useNow";
import { useRestorePage, useTitle } from "./hooks";
import { isoDay, useOpenDay } from "./journal";

export function TrashBanner({ page, canEdit, canDelete }: { page: WikiPage; canEdit: boolean; canDelete: boolean }) {
  const { t } = useTranslation("wiki");
  const now = useNow();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const restore = useRestorePage();
  const title = useTitle();
  if (!page.deleted_at) return null;
  const purge = new Date(Date.parse(page.deleted_at) + 30 * 86_400_000).toISOString();
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color-mix(in_srgb,var(--tone-red-solid)_30%,var(--line))] bg-tone-red-soft px-4 py-2.5 text-[12.5px] text-fg animate-rise-in motion-reduce:animate-none">
      <Trash2 className="size-4 shrink-0 text-tone-red" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{page.deleted_by ? t("trash.bannerBy", { name: page.deleted_by.name, when: relLong(page.deleted_at, now) }) : t("trash.banner")}</span>{" "}
        <span className="text-fg-2" title={fullDate(purge)}>
          {t("trash.bannerPurge", { date: longDate(purge) })}
        </span>
      </span>
      {canEdit && (
        <span className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="primary" icon={<RotateCcw />} onClick={() => void restore(page.id)}>
            {t("trash.restore")}
          </Button>
          {canDelete && (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                confirm.show(
                  page.children.length ? t("delete.withSubpages", { count: page.children.length }) : t("delete.body"),
                  async () => {
                    await api.wiki.remove(page.id);
                    qc.removeQueries({ queryKey: qk.wikiPage(page.id) });
                    void qc.invalidateQueries({ queryKey: qk.wikiTrash });
                    toast.success(t("toast.deleted", { title: title(page.title) }));
                    void navigate({ to: "/wiki/trash" });
                  },
                  { title: t("delete.title", { title: title(page.title) }), confirmLabel: t("trash.deleteForever"), danger: true },
                )
              }
            >
              {t("trash.deleteForever")}
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

export function TemplateBanner({ page, onUse, busy }: { page: WikiPage; onUse?: () => void; busy?: boolean }) {
  const { t } = useTranslation("wiki");
  if (!page.template || page.deleted_at) return null;
  return (
    <div className="flex items-center gap-3 border-b border-[color-mix(in_srgb,var(--tone-violet-solid)_25%,var(--line))] bg-tone-violet-soft px-4 py-2 text-[12.5px] text-fg">
      <LayoutTemplate className="size-4 shrink-0 text-tone-violet" />
      <span className="min-w-0 flex-1 text-fg-2">{t("templatesPage.banner")}</span>
      {onUse && (
        <Button size="sm" variant="primary" loading={busy} onClick={onUse}>
          {t("templatesPage.useThis")}
        </Button>
      )}
    </div>
  );
}

const VERIFY_DAYS = [30, 90, 180, 365] as const;

/** "Verified by Maya until 3 March" under the title; its menu verifies again or takes it away. */
export function Verification({ page, canEdit, onChange }: { page: WikiPage; canEdit: boolean; onChange: (verified: boolean, days?: number) => void }) {
  const { t } = useTranslation("wiki");
  const v = page.verification;
  if (!v && !canEdit) return null;
  const label = !v
    ? t("verify.action")
    : v.expired
      ? t("verify.expired")
      : v.until
        ? t("verify.until", { name: v.by?.name ?? "", date: longDate(v.until) })
        : t("verify.byForGood", { name: v.by?.name ?? "" });
  const chip = (
    <button
      type="button"
      disabled={!canEdit}
      className={cn(
        "mt-2 inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] transition-colors disabled:cursor-default",
        !v && "text-fg-3 hover:bg-hover hover:text-fg",
        v && !v.expired && "bg-tone-blue-soft text-tone-blue hover:brightness-95",
        v?.expired && "bg-tone-amber-soft text-tone-amber hover:brightness-95",
      )}
    >
      <BadgeCheck className="size-3.5" />
      {label}
    </button>
  );
  if (!canEdit) return chip;
  return (
    <Menu>
      <MenuTrigger asChild>{chip}</MenuTrigger>
      <MenuContent align="start" className="w-[220px]">
        <div className="label-caps px-2 pb-1 pt-1.5">{v ? t("verify.again") : t("verify.action")}</div>
        {VERIFY_DAYS.map((d) => (
          <MenuItem key={d} onSelect={() => onChange(true, d)}>
            {t("verify.forDays", { count: d })}
          </MenuItem>
        ))}
        <MenuItem onSelect={() => onChange(true)}>{t("verify.forGood")}</MenuItem>
        {v && (
          <>
            <MenuSeparator />
            <MenuItem danger onSelect={() => onChange(false)}>
              {t("verify.remove")}
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

/** A daily note's days: the one before, a calendar with dots on days that have notes, the one after. */
export function DayNav({ page }: { page: WikiPage }) {
  const { t } = useTranslation("wiki");
  // The days of the journal the note is in: the wiki's, or Pages'.
  const area = page.area ?? "wiki";
  const open = useOpenDay(area);
  const [cal, setCal] = useState(false);
  const day = parseDay(page.daily_date ?? null);
  const from = day ? isoDay(new Date(day.getFullYear(), day.getMonth() - 2, 1)) : "";
  const to = day ? isoDay(new Date(day.getFullYear(), day.getMonth() + 3, 0)) : "";
  const { data: notes = [] } = useQuery({ ...q.wikiDaily(from, to, area), enabled: !!day });
  if (!day) return null;
  const shift = (by: number) => open(new Date(day.getFullYear(), day.getMonth(), day.getDate() + by));
  const has = new Set(notes.map((n) => n.date));
  return (
    <div className="mb-3 flex items-center gap-0.5">
      <Tooltip content={t("journal.previous")}>
        <Button square variant="ghost" size="sm" aria-label={t("journal.previous")} onClick={() => void shift(-1)}>
          <ChevronLeft className="size-4" />
        </Button>
      </Tooltip>
      <Popover
        open={cal}
        onOpenChange={setCal}
        className="p-2"
        trigger={
          <Button variant="ghost" size="sm" icon={<CalendarDays />}>
            {t("journal.daily")}
          </Button>
        }
      >
        <Calendar
          value={day}
          onChange={(d) => {
            setCal(false);
            void open(d);
          }}
        />
        <p className="px-1 pt-1.5 text-[11.5px] text-fg-4">{t("journal.notesCount", { count: has.size })}</p>
      </Popover>
      <Tooltip content={t("journal.next")}>
        <Button square variant="ghost" size="sm" aria-label={t("journal.next")} onClick={() => void shift(1)}>
          <ChevronRight className="size-4" />
        </Button>
      </Tooltip>
      {isoDay(new Date()) !== page.daily_date && (
        <Button variant="ghost" size="sm" onClick={() => void open(new Date())}>
          {t("journal.today")}
        </Button>
      )}
    </div>
  );
}
