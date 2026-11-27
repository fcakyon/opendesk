import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@/components/ui/popover";

/** "Why?" beside a timeline line: what led to it, for the team only (never shown to the customer). */
export function WhyPopover({ title, children }: { title: string; children?: ReactNode }) {
  const { t } = useTranslation("inbox");
  return (
    <Popover
      align="start"
      className="w-72 p-3"
      trigger={
        <button type="button" className="shrink-0 rounded-sm px-1 text-[11px] text-fg-3 underline decoration-line underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {t("activity.why")}
        </button>
      }
    >
      <p className="text-[12.5px] font-medium text-fg">{title}</p>
      {children}
      <p className="mt-2 text-[11px] text-fg-4">{t("activity.whyInternal")}</p>
    </Popover>
  );
}
