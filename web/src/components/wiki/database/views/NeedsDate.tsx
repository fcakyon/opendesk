// What a calendar or timeline shows before it has a date property to place rows by.

import { CalendarDays } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { DbProperty } from "@/lib/api/types";
import type { ViewProps } from "../DatabaseView";

/** No date property picked: the date properties to pick from, or why there are none. The timeline shows it too. */
export function NeedsDate({ p }: { p: ViewProps }) {
  const { t } = useTranslation("wiki");
  const dates: DbProperty[] = p.db.properties.filter((x) => x.type === "date" || x.type === "created_time" || x.type === "edited_time");
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-line px-6 py-10 text-center">
      <span className="flex size-9 items-center justify-center rounded-lg bg-sunken text-fg-3 shadow-[inset_0_0_0_1px_var(--line)]">
        <CalendarDays className="size-4" />
      </span>
      {dates.length && p.canEdit ? (
        <>
          <p className="text-[13px] font-medium text-fg">{t("db.pickDateProperty")}</p>
          <div className="flex flex-wrap justify-center gap-1.5">
            {dates.map((d) => (
              <Button key={d.id} size="sm" onClick={() => p.onSettings({ ...p.view.settings, date_property: d.id })}>
                {d.name}
              </Button>
            ))}
          </div>
        </>
      ) : (
        <p className="max-w-[340px] text-[12.5px] text-fg-3">{t("db.needsDate")}</p>
      )}
    </div>
  );
}
