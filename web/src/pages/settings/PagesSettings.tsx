// Settings › Pages (contracts/pages.md): whether the workspace uses Pages, its teamspaces, its
// import and export, and its trash. The product's switch is also under General's Products.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Download, FileUp, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openImport } from "@/app/quickAdd";
import { Row, Section, SettingsPage } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { TeamDot } from "@/components/tickets/teams";
import { ExportWikiItems } from "@/components/wiki/Export";
import { api } from "@/lib/api/endpoints";
import type { Workspace } from "@/lib/api/types";
import { productsOf } from "@/lib/products";
import { q, qk } from "@/lib/queries";
import { atLeast, updateWorkspace, useRole } from "@/lib/session";
import { AreaProvider, inArea } from "@/lib/wiki/area";

export default function PagesSettings() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const role = useRole();
  const isAdmin = atLeast(role, "admin");
  const canEdit = atLeast(role, "agent");
  const { data: ws } = useQuery(q.workspace());
  const { data: teams = [] } = useQuery(q.teams());
  const on = productsOf(ws).pages;
  const { data: nodes = [] } = useQuery({ ...q.wikiTree(), enabled: on });
  const { data: trash = [] } = useQuery({ ...q.wikiTrash(), enabled: on });

  const toggle = useMutation({
    mutationFn: (pages_enabled: boolean) => api.workspaces.update({ settings: { pages_enabled } }),
    onSuccess: (w: Workspace) => {
      qc.setQueryData(qk.workspace, w);
      updateWorkspace(w);
      void qc.invalidateQueries({ queryKey: qk.of("wiki") });
      toast.success(t("pages.saved"));
    },
    onError: (e) => toast.error(e, t("pages.saveFailed")),
  });

  if (!ws)
    return (
      <SettingsPage title={t("pages.title")}>
        <Skeleton className="h-36 w-full rounded-lg" />
      </SettingsPage>
    );

  const p = productsOf(ws);
  // The last product on stays on (at_least_one_product_required).
  const last = on && !p.tickets && !p.mail;
  const pages = nodes.filter(inArea("pages"));
  const trashed = trash.filter(inArea("pages")).length;
  const spaces = teams
    .map((team) => ({ team, count: pages.filter((n) => n.team_id === team.id).length }))
    .sort((a, b) => b.count - a.count || a.team.name.localeCompare(b.team.name));

  return (
    <SettingsPage title={t("pages.title")} description={t("pages.description")}>
      <Section title={t("pages.product")} description={t("pages.productHint")}>
        <Row label={t("pages.use")} description={on ? t("pages.useOn") : t("pages.useOff")}>
          <Switch aria-label={t("pages.use")} checked={on} disabled={!isAdmin || last || toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} />
        </Row>
        {last && <Row label={t("pages.lastProduct")} description={t("pages.lastProductHint")} />}
      </Section>

      {on && (
        <>
          <Section
            title={t("pages.teamspaces")}
            description={t("pages.teamspacesHint")}
            actions={
              <Button size="sm" asChild>
                <Link to="/settings/teams">
                  {t("pages.manageTeams")}
                  <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            }
          >
            {spaces.length ? (
              spaces.map(({ team, count }) => (
                <Row
                  key={team.id}
                  label={
                    <span className="flex items-center gap-1.5">
                      <TeamDot team={team} />
                      {team.name}
                      {team.private && <Lock className="size-3 text-fg-4" aria-label={t("pages.privateTeam")} />}
                    </span>
                  }
                  description={team.private ? t("pages.privateTeamHint") : undefined}
                >
                  <span className="text-[12.5px] tabular-nums text-fg-3">{t("pages.pageCount", { count })}</span>
                </Row>
              ))
            ) : (
              <Row label={t("pages.noTeams")} description={t("pages.noTeamsHint")} />
            )}
          </Section>

          <Section title={t("pages.port")} description={t("pages.portHint")}>
            <Row label={t("pages.import")} description={t("pages.importHint")}>
              <Button size="sm" icon={<FileUp />} disabled={!canEdit} onClick={() => openImport(null, { area: "pages" })}>
                {t("pages.importAction")}
              </Button>
            </Row>
            <Row label={t("pages.export")} description={t("pages.exportHint")}>
              <AreaProvider area="pages">
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="sm" icon={<Download />}>
                      {t("pages.exportAction")}
                    </Button>
                  </MenuTrigger>
                  <MenuContent align="end">
                    <ExportWikiItems />
                  </MenuContent>
                </Menu>
              </AreaProvider>
            </Row>
          </Section>

          <Section title={t("pages.trash")} description={t("pages.trashHint")}>
            <Row label={t("pages.inTrash", { count: trashed })}>
              <Button size="sm" asChild>
                <Link to="/pages/trash">
                  {t("pages.openTrash")}
                  <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            </Row>
          </Section>
        </>
      )}
    </SettingsPage>
  );
}
