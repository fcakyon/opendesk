// The new page popup (contracts/wiki.md "In the main sidebar"), from the Pages section's "+",
// the header's New menu and the command menu: where it goes (the workspace, a teamspace or
// private), then a page, a database or a canvas, one of the team's templates or a starter, or
// files to import, dropped or picked, which open the import dialog with them. It adds to Pages
// (contracts/pages.md), or to the wiki when opened from the wiki or while Pages is off.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, FileText, LayoutDashboard, Table2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { openImport, quickAdd, useQuickAdd } from "@/app/quickAdd";
import { Dialog } from "@/components/ui/dialog";
import { Select, type SelectOption } from "@/components/ui/select";
import { TeamDot } from "@/components/tickets/teams";
import { q } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { AreaProvider, areaPath, useArea, useDefaultArea } from "@/lib/wiki/area";
import { spaceBody, type SpaceKey } from "@/lib/wiki/tree";
import { useCreatePage, useTitle, useUseTemplate, type NewPage } from "./hooks";
import { Drop } from "./ImportDialog";
import { PageIcon } from "./PageTree";
import { starterDatabase } from "./database/starter";
import { TEMPLATES, templatePage } from "./templates";

/** How many templates the popup lists; the templates page has them all. */
const SHOWN_TEMPLATES = 5;

export function NewPageDialog() {
  const start = useQuickAdd((s) => s.newPage);
  const area = useDefaultArea(start?.area);
  return (
    <AreaProvider area={area}>
      <NewPage />
    </AreaProvider>
  );
}

function NewPage() {
  const { t } = useTranslation("wiki");
  const title = useTitle();
  const area = useArea();
  const start = useQuickAdd((s) => s.newPage);
  const create = useCreatePage();
  const fromTemplate = useUseTemplate();
  const me = useSession((s) => s.user?.id);
  const { data: teams = [] } = useQuery(q.teams());
  const { data: templates = [] } = useQuery(q.wikiTemplates());
  const [space, setSpace] = useState<SpaceKey>(start?.space ?? "workspace");
  const close = quickAdd.closePage;

  const places = useMemo<SelectOption<SpaceKey>[]>(
    () => [
      { value: "workspace", label: t("sidebar.workspace") },
      ...teams
        .filter((team) => !team.private || (!!me && team.member_ids.includes(me)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((team) => ({ value: `team:${team.id}` as SpaceKey, label: team.name, icon: <TeamDot team={team} /> })),
      ...(me ? [{ value: "private" as SpaceKey, label: t("sidebar.private") }] : []),
    ],
    [teams, me, t],
  );

  const make = (body: NewPage) => create.mutate({ ...body, ...spaceBody(space) }, { onSuccess: close });
  // The team's own templates first; a wiki without any offers the starters.
  const own = templates.filter((n) => !n.parent_id).slice(0, SHOWN_TEMPLATES);
  const starters = own.length ? [] : TEMPLATES.slice(0, SHOWN_TEMPLATES);

  return (
    <Dialog open={!!start} onOpenChange={(o) => !o && close()} title={t("newPage.title")} size="md">
      <div className="flex flex-col gap-5 pb-2">
        <label className="flex items-center gap-3">
          <span className="shrink-0 text-[12.5px] text-fg-3">{t("newPage.in")}</span>
          <Select value={space} onChange={setSpace} options={places} className="min-w-0 flex-1" aria-label={t("newPage.in")} />
        </label>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Kind icon={<FileText />} label={t("newPage.page")} hint={t("newPage.pageHint")} busy={create.isPending} onPick={() => make({})} />
          <Kind icon={<Table2 />} label={t("newPage.database")} hint={t("newPage.databaseHint")} busy={create.isPending} onPick={() => make({ kind: "database", database: starterDatabase("table", t) })} />
          <Kind icon={<LayoutDashboard />} label={t("newPage.canvas")} hint={t("newPage.canvasHint")} busy={create.isPending} onPick={() => make({ kind: "canvas" })} />
        </div>

        <section aria-labelledby="new-page-templates">
          <div className="mb-1 flex items-center">
            <h3 id="new-page-templates" className="label-caps">
              {t("newPage.fromTemplate")}
            </h3>
            <Link to={areaPath(area, "templates")} onClick={close} className="ml-auto flex items-center gap-1 text-[12px] text-fg-3 transition-colors hover:text-fg">
              {t("templatesPage.all")}
              <ArrowRight className="size-3" />
            </Link>
          </div>
          <ul className="-mx-1 flex flex-col">
            {own.map((tpl) => (
              <TemplateRow
                key={tpl.id}
                icon={<PageIcon icon={tpl.icon} kind={tpl.kind} />}
                label={title(tpl.title)}
                onPick={() => {
                  close();
                  void fromTemplate(tpl);
                }}
              />
            ))}
            {starters.map((tpl) => (
              <TemplateRow key={tpl.id} icon={<PageIcon icon={tpl.icon} />} label={t(`templates.${tpl.id}.title`)} hint={t(`templates.${tpl.id}.hint`)} onPick={() => make(templatePage(t, tpl.id))} />
            ))}
          </ul>
        </section>

        <section aria-labelledby="new-page-import">
          <h3 id="new-page-import" className="label-caps mb-1.5">
            {t("newPage.import")}
          </h3>
          <Drop compact invalid={false} onFiles={(list) => list?.length && openImport(null, { files: [...list], space, area })} />
        </section>
      </div>
    </Dialog>
  );
}

function Kind({ icon, label, hint, busy, onPick }: { icon: ReactNode; label: string; hint: string; busy: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onPick}
      className="flex flex-col items-start gap-1 rounded-lg border border-line bg-surface p-3 text-left shadow-xs outline-none transition-[border-color,background-color] hover:border-line-strong hover:bg-canvas focus-visible:shadow-[0_0_0_2px_var(--focus)] disabled:opacity-60 [&_svg]:size-4 [&_svg]:text-fg-3"
    >
      {icon}
      <span className="mt-1 text-[13px] font-medium text-fg">{label}</span>
      <span className="text-[11.5px] leading-[16px] text-fg-3">{hint}</span>
    </button>
  );
}

function TemplateRow({ icon, label, hint, onPick }: { icon: ReactNode; label: string; hint?: string; onPick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onPick} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover">
        {icon}
        <span className="shrink-0 text-[12.5px] text-fg">{label}</span>
        {hint && <span className="min-w-0 truncate text-[12px] text-fg-4">{hint}</span>}
      </button>
    </li>
  );
}
