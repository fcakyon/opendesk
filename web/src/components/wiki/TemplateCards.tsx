// The starter templates as cards: a real outline to fill in rather than a blank page.

import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { TEMPLATES, type TemplateId } from "./templates";

export function StarterTemplates({ ids, onPick, busy, compact, more }: { ids: readonly TemplateId[]; onPick: (id: TemplateId) => void; busy: boolean; compact?: boolean; more?: boolean }) {
  const { t } = useTranslation("wiki");
  return (
    <section className={cn("w-full", compact ? "mt-10" : "relative z-10 mt-6 max-w-[640px]")} aria-labelledby="wiki-templates">
      <div className={cn("mb-2 flex items-center", !compact && "justify-center")}>
        <h2 id="wiki-templates" className="label-caps">
          {t("templates.heading")}
        </h2>
        {more && (
          <Link to="/wiki/templates" className="ml-auto flex items-center gap-1 text-[12px] text-fg-3 transition-colors hover:text-fg">
            {t("templatesPage.all")}
            <ArrowRight className="size-3" />
          </Link>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {ids.map((id) => {
          const tpl = TEMPLATES.find((x) => x.id === id)!;
          return (
            <button
              key={id}
              type="button"
              disabled={busy}
              onClick={() => onPick(id)}
              className="group flex flex-col items-start gap-1.5 rounded-lg border border-line bg-surface p-3 text-left shadow-xs outline-none transition-[border-color,box-shadow,transform] hover:border-line-strong active:scale-[0.99] disabled:opacity-60 focus-visible:shadow-[0_0_0_2px_var(--focus)] motion-reduce:transition-none"
            >
              <span className="text-[18px] leading-none" aria-hidden>
                {tpl.icon}
              </span>
              <span className="text-[13px] font-medium text-fg">{t(`templates.${id}.title`)}</span>
              <span className="text-xs leading-[17px] text-fg-3">{t(`templates.${id}.hint`)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
