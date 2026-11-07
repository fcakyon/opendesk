// The member's journal (contracts/wiki.md "Journal"): today's note, opened from the sidebar
// or the command menu, made the first time. Titles are written in the person's language. Each
// area keeps its own (contracts/pages.md): the wiki's, and Pages'.

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import type { WikiArea, WikiPage } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { pageTo, useArea } from "@/lib/wiki/area";

/** YYYY-MM-DD of a day in the person's own time zone. */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayTitle(d: Date, lang?: string): string {
  return d.toLocaleDateString(lang, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/** Opens the note of a day (today by default) of the area the view is in, making it and the journal when needed. */
export function useOpenDay(asked?: WikiArea) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation("wiki");
  const inView = useArea();
  const area = asked ?? inView;
  return async (day: Date = new Date()) => {
    try {
      const page = await api.wiki.openDaily({ date: isoDay(day), title: dayTitle(day, i18n.resolvedLanguage), journal_title: t("journal.title"), area });
      qc.setQueryData<WikiPage>(qk.wikiPage(page.id), page);
      void qc.invalidateQueries({ queryKey: qk.wikiTree });
      void qc.invalidateQueries({ queryKey: qk.of("wiki", "daily") });
      void navigate(pageTo({ id: page.id, area: page.area ?? area }));
      return page;
    } catch (e) {
      toast.error(e, t("journal.failed"));
      return null;
    }
  };
}

export function useOpenToday(area?: WikiArea) {
  const open = useOpenDay(area);
  return () => open(new Date());
}
