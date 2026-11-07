import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowUpRight, AtSign, Building2, Copy, FolderClosed, Globe, Inbox, Lock, MoreHorizontal, Pencil, Plus, Search, Tag, Trash2, UserRound, Users } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SettingsPage, Section, ListRow } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsEmpty } from "@/components/settings2/SettingsEmpty";
import { ViewDrawer } from "@/components/settings2/ViewDrawer";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { IconTile, ListSkeleton } from "@/components/settings2/bits";
import { Avatar } from "@/components/ui/avatar";
import { TagChip } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { orderBy, useListMutation } from "@/components/settings2/optimistic";
import { SortableList } from "@/components/settings2/Sortable";
import { TeamChip, useTeams } from "@/components/settings2/teams";
import { ViewIcon, viewIconTone, viewName } from "@/components/tickets/ViewIcon";
import { viewAudience, viewAudienceHint, viewDeleteBody } from "@/components/settings2/viewAudience";
import { splitList } from "@/components/settings2/viewFilters";
import { useCompanyItems, useContactItems } from "@/components/settings2/pickers";
import { ChannelIcon, PriorityIcon, SeverityChip, StatusIcon, channelLabel, priorityLabel, severityLabel, statusLabel } from "@/components/tickets/bits";
import { api } from "@/lib/api/endpoints";
import type { TicketFilters, View } from "@/lib/api/types";
import { q, qk } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { cn } from "@/lib/cn";
import { groupViews, orderViews, type ViewEntry } from "@/lib/viewSections";

const chip =
  "inline-flex h-5 max-w-[220px] shrink-0 items-center gap-1 rounded-sm bg-sunken px-1.5 text-[11px] text-fg-2 ring-1 ring-inset ring-line-soft [&_svg]:size-3 [&_svg]:shrink-0";

/** A view's filters as a row of small chips, each with its indicator. */
function FilterChips({ f }: { f: TicketFilters }) {
  const { t } = useTranslation("settingsInbox");
  useTranslation("indicators");
  const members = useQuery(q.members()).data;
  const teams = useQuery(q.teams()).data;
  const mailboxes = useQuery(q.mailboxes()).data;
  const tags = useQuery(q.tags()).data;
  const contacts = useContactItems(splitList(f.contact_not));
  const companies = useCompanyItems(splitList(f.company_not));
  const or = (xs: string[]) => xs.join(" / ");
  const out: ReactNode[] = [];
  if (f.status?.length)
    out.push(
      <span key="s" className={chip}>
        {f.status.map((s) => (
          <StatusIcon key={s} status={s} />
        ))}
        <span className="truncate">{or(f.status.map((s) => statusLabel(s)))}</span>
      </span>,
    );
  if (f.priority?.length)
    out.push(
      <span key="p" className={chip}>
        {f.priority.map((p) => (
          <PriorityIcon key={p} priority={p} />
        ))}
        <span className="truncate">{or(f.priority.map((p) => priorityLabel(p)))}</span>
      </span>,
    );
  if (f.severity?.length)
    out.push(
      <span key="sev" className={chip}>
        {f.severity.map((s) => (s === "none" ? null : <SeverityChip key={s} severity={s} />))}
        <span className="truncate">{or(f.severity.map((s) => (s === "none" ? t("views.noSeverity") : severityLabel(s))))}</span>
      </span>,
    );
  if (f.assignee) {
    const m = members?.find((x) => x.user.id === f.assignee);
    out.push(
      <span key="a" className={chip}>
        {m ? <Avatar name={m.user.name || m.user.email} src={m.user.avatar_url} size="xs" className="!size-3.5" /> : <UserRound />}
        <span className="truncate">
          {f.assignee === "me"
            ? t("views.assignedToViewer")
            : f.assignee === "none"
              ? t("views.unassigned")
              : t("views.assignedTo", {
                  name: m?.user.name ?? t("views.aTeammate"),
                })}
        </span>
      </span>,
    );
  }
  const teamNames = (list: string) =>
    or(
      splitList(list).map((id) =>
        id === "mine" ? t("views.myTeams") : id === "none" ? t("views.noTeam") : (teams?.find((x) => x.id === id)?.name ?? t("views.unknown")),
      ),
    );
  const mailboxNames = (list: string) => or(splitList(list).map((id) => mailboxes?.find((x) => x.id === id)?.email ?? t("views.aMailbox")));
  if (f.team_id)
    out.push(
      <span key="t" className={chip}>
        <Users />
        <span className="truncate">{t("views.teamNamed", { name: teamNames(f.team_id) })}</span>
      </span>,
    );
  if (f.team_not)
    out.push(
      <span key="tn" className={chip}>
        <Users />
        <span className="truncate">{t("views.notTeamNamed", { name: teamNames(f.team_not) })}</span>
      </span>,
    );
  if (f.mailbox_id)
    out.push(
      <span key="m" className={chip}>
        <Inbox />
        <span className="truncate">{t("views.inMailbox", { name: mailboxNames(f.mailbox_id) })}</span>
      </span>,
    );
  if (f.mailbox_not)
    out.push(
      <span key="mn" className={chip}>
        <Inbox />
        <span className="truncate">{t("views.notInMailbox", { name: mailboxNames(f.mailbox_not) })}</span>
      </span>,
    );
  if (f.received_at)
    out.push(
      <span key="r" className={chip}>
        <AtSign />
        <span className="truncate">{t("views.writtenTo", { address: f.received_at })}</span>
      </span>,
    );
  if (contacts.length)
    out.push(
      <span key="ctn" className={chip}>
        <UserRound />
        <span className="truncate">{t("views.notContact", { name: or(contacts.map((c) => c.label)) })}</span>
      </span>,
    );
  if (companies.length)
    out.push(
      <span key="cpn" className={chip}>
        <Building2 />
        <span className="truncate">{t("views.notCompany", { name: or(companies.map((c) => c.label)) })}</span>
      </span>,
    );
  const tagColor = (name: string) => tags?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.color;
  for (const name of splitList(f.tag)) out.push(<TagChip key={`g:${name}`} name={name} color={tagColor(name)} className="h-5" />);
  if (f.tag_not)
    out.push(
      <span key="gn" className={chip}>
        <Tag />
        <span className="truncate">{t("views.withoutLabels", { labels: splitList(f.tag_not).join(", ") })}</span>
      </span>,
    );
  if (f.untagged)
    out.push(
      <span key="gu" className={chip}>
        <Tag />
        {t("views.noLabel")}
      </span>,
    );
  if (f.channel)
    out.push(
      <span key="c" className={chip}>
        <ChannelIcon channel={f.channel} />
        {channelLabel(f.channel)}
      </span>,
    );
  if (f.channel_not?.length)
    out.push(
      <span key="cn" className={chip}>
        {f.channel_not.map((c) => (
          <ChannelIcon key={c} channel={c} />
        ))}
        <span className="truncate">{t("views.notChannel", { channel: or(f.channel_not.map((c) => channelLabel(c))) })}</span>
      </span>,
    );
  if (f.q)
    out.push(
      <span key="q" className={chip}>
        <Search />
        <span className="truncate">{t("views.matching", { q: f.q })}</span>
      </span>,
    );
  if (!out.length)
    out.push(
      <span key="all" className={chip}>
        {t("views.allTickets")}
      </span>,
    );
  return <div className="mt-1.5 flex flex-wrap items-center gap-1">{out}</div>;
}

// A view's tile: its colour, else blue when shared, as before icons.
const viewTile = (v: View) => viewIconTone(v.icon) ?? (v.shared ? "blue" : "gray");

export default function Views() {
  const { data: views, isLoading } = useQuery(q.views());
  const role = useRole();
  const canEdit = atLeast(role, "agent");
  const { t } = useTranslation("settingsInbox");
  const confirm = useConfirm();
  const [editing, setEditing] = useState<View | "new" | null>(null);
  const navigate = useNavigate();
  // The copy being made: from a row's menu here, or ?duplicate=<id> (the sidebar's Duplicate).
  const [copying, setCopying] = useState<View | null>(null);
  const search = useSearch({ from: "/app/settings/views" });
  const copyOf = copying ?? (canEdit && search.duplicate ? views?.find((v) => v.id === search.duplicate) : undefined);
  const closeCopy = () => {
    setCopying(null);
    if (search.duplicate) void navigate({ to: "/settings/views", search: {}, replace: true });
  };

  // In the sidebar's order: a section's views together, at its first view's place.
  const sorted = useMemo(() => orderViews(views ?? []), [views]);
  // What drags: a view on its own or a whole section; a section's views drag inside it.
  const entries = useMemo(() => groupViews(views ?? []).map((e) => ({ id: e.kind === "view" ? e.view.id : `section:${e.key}`, entry: e })), [views]);
  const idsOf = (e: ViewEntry) => (e.kind === "view" ? [e.view.id] : e.views.map((v) => v.id));
  const { teams } = useTeams();
  const teamById = new Map(teams.map((x) => [x.id, x]));

  const toggleShared = useListMutation<View, { id: string; shared: boolean }>(
    qk.views,
    (v) => api.views.update(v.id, { shared: v.shared }),
    (rows, v) => rows.map((r) => (r.id === v.id ? { ...r, shared: v.shared } : r)),
    { errorText: t("views.updateFailed") },
  );
  const reorder = useListMutation<View, string[]>(
    qk.views,
    async (ids) => {
      const next = orderBy(sorted, ids);
      const changed = next.filter((n) => sorted.find((o) => o.id === n.id)?.position !== n.position);
      await Promise.all(changed.map((n) => api.views.update(n.id, { position: n.position })));
    },
    (rows, ids) => orderBy(rows, ids),
    { errorText: t("views.reorderFailed") },
  );
  const remove = useListMutation<View, string>(
    qk.views,
    (id) => api.views.remove(id),
    (rows, id) => rows.filter((r) => r.id !== id),
    {
      errorText: t("views.deleteFailed"),
    },
  );

  const newButton = (size?: "sm") =>
    canEdit && (
      <Button variant={size ? "secondary" : "primary"} size={size} icon={<Plus className="size-3.5" />} onClick={() => setEditing("new")}>
        {t("views.new")}
      </Button>
    );

  return (
    <SettingsPage title={t("views.title")} description={t("views.description")} actions={newButton()}>
      <Section flush title={views ? t("views.count", { count: sorted.length }) : undefined}>
        {isLoading ? (
          <ListSkeleton rows={3} />
        ) : !sorted.length ? (
          <SettingsEmpty
            art="views"
            title={t("views.emptyTitle")}
            description={t("views.emptyHint")}
            action={newButton()}
            tips={[
              { label: t("views.emptyTips.sidebar"), icon: <Globe /> },
              { label: t("views.emptyTips.personal"), icon: <Lock /> },
            ]}
          />
        ) : (
          <SortableList
            items={entries}
            disabled={!canEdit}
            onReorder={(ids) => reorder.mutate(ids.flatMap((id) => idsOf(entries.find((x) => x.id === id)!.entry)))}
            handleLabel={({ entry: e }) => (e.kind === "view" ? t("views.reorderAria", { name: e.view.name }) : t("views.reorderSectionAria", { name: e.name }))}
            renderRow={({ entry: e }, handle) =>
              e.kind === "view" ? (
                viewRow(e.view, handle)
              ) : (
                <div role="group" aria-label={t("views.inSection", { name: e.name })}>
                  <div className="group relative flex h-9 items-center gap-2 border-b border-line-soft bg-sunken/60 px-4 text-[12.5px] font-medium text-fg-2">
                    {handle}
                    <FolderClosed className="size-3.5 shrink-0 text-fg-3" />
                    <span className="min-w-0 truncate">{e.name}</span>
                    <span className="mono text-[11px] font-normal text-fg-4">{e.views.length}</span>
                  </div>
                  <SortableList
                    items={e.views}
                    disabled={!canEdit}
                    // Inside a section only: the section keeps its place among the others.
                    onReorder={(ids) => reorder.mutate(entries.flatMap((x) => (x.entry === e ? ids : idsOf(x.entry))))}
                    handleLabel={(v) => t("views.reorderAria", { name: v.name })}
                    renderRow={(v, h) => viewRow(v, h)}
                  />
                </div>
              )
            }
          />
        )}
      </Section>
      {copyOf ? (
        <ViewDrawer key={copyOf.id} view={null} copyOf={copyOf} views={sorted} nextPosition={sorted.length} onClose={closeCopy} />
      ) : (
        editing && <ViewDrawer view={editing === "new" ? null : editing} views={sorted} nextPosition={sorted.length} onClose={() => setEditing(null)} />
      )}
    </SettingsPage>
  );

  function viewRow(v: View, handle: ReactNode) {
    return (
                <ListRow onClick={canEdit ? () => setEditing(v) : undefined} className="items-start py-3">
                  {handle}
                  <IconTile tone={viewTile(v)} className="mt-0.5">
                    {v.icon?.kind === "text" ? <span className="text-[12px] font-semibold leading-none">{v.icon.value}</span> : <ViewIcon icon={v.icon} size={20} />}
                  </IconTile>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{viewName(v)}</span>
                      {v.team_id && teamById.get(v.team_id) ? (
                        <TeamChip team={teamById.get(v.team_id)!} size="xs" />
                      ) : (
                        <Tooltip content={viewAudienceHint(t, viewAudience(v))}>
                          <span className="inline-flex items-center gap-1 text-[11px] text-fg-4">
                            {v.shared ? <Globe className="size-3" /> : <Lock className="size-3" />}
                            {v.shared ? t("views.shared") : t("views.personal")}
                          </span>
                        </Tooltip>
                      )}
                    </div>
                    <FilterChips f={v.filters} />
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-1 self-center">
                      <span className={cn("mr-1 hidden", !v.team_id && "sm:flex")} onClick={(e) => e.stopPropagation()}>
                        <Switch
                          checked={v.shared}
                          onCheckedChange={(shared) => toggleShared.mutate({ id: v.id, shared })}
                          aria-label={t("views.showToEveryone", {
                            name: v.name,
                          })}
                        />
                      </span>
                      <Menu>
                        <MenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={t("common.actionsFor", {
                              name: v.name,
                            })}
                            onClick={(e) => e.stopPropagation()}
                            className="flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem icon={<Pencil />} onSelect={() => setEditing(v)}>
                            {t("common.edit")}
                          </MenuItem>
                          <MenuItem icon={<Copy />} onSelect={() => setCopying(v)}>
                            {t("views.duplicate")}
                          </MenuItem>
                          <MenuItem
                            icon={<ArrowUpRight />}
                            onSelect={() =>
                              void navigate({
                                to: "/views/$viewId/{-$ticketId}",
                                params: { viewId: v.id, ticketId: undefined },
                              })
                            }
                          >
                            {t("views.open")}
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            danger
                            icon={<Trash2 />}
                            onSelect={() =>
                              confirm.show(
                                <>
                                  <span className="font-medium text-fg">{v.name}</span> {viewDeleteBody(t, viewAudience(v), v.team_id ? teamById.get(v.team_id)?.name : null)}
                                </>,
                                () => remove.mutateAsync(v.id),
                                {
                                  title: t("views.deleteTitle"),
                                  confirmLabel: t("views.deleteConfirm"),
                                  danger: true,
                                },
                              )
                            }
                          >
                            {t("common.delete")}
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    </div>
                  )}
                </ListRow>
    );
  }
}
