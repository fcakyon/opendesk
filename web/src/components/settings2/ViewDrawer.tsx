// A view's editor: its name, icon, who sees it, its section and filters. One drawer for
// Settings › Views and the sidebar's Views (a new view, Edit and Duplicate open it in place).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, FolderClosed, Globe, Lock, UserRound, UsersRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/dialog";
import { Field, TextInput } from "@/components/ui/input";
import { Picker } from "@/components/ui/picker";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { IconTile } from "@/components/settings2/bits";
import { TeamPick, useTeams } from "@/components/settings2/teams";
import { ViewIconField } from "@/components/settings2/ViewIconField";
import { ViewIcon } from "@/components/tickets/ViewIcon";
import { Segmented } from "@/components/ui/tabs";
import { viewAudience, viewAudienceHint } from "@/components/settings2/viewAudience";
import { canWriteView, copyPersonalNote, copyView, makeRoom, viewRights } from "@/components/settings2/viewCopy";
import { cleanFilters, clearField, fieldOps, filterOp, hasFilter, joinList, splitList, withOp, type FilterOp, type OpField } from "@/components/settings2/viewFilters";
import { CompaniesPick, ContactsPick, MultiPick, SinglePick, ValueButton, channelItems, priorityItems, severityFilterItems, statusItems, useMailboxItems, useMemberItems, useTagItems, useTeamItems } from "@/components/settings2/pickers";
import { useDisplay } from "@/components/tickets/fields";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { Channel, Priority, Severity, TicketFilters, TicketStatus, View, ViewIcon as ViewIconValue } from "@/lib/api/types";
import { q, qk, upsertInList } from "@/lib/queries";
import { atLeast, useRole, useUser } from "@/lib/session";
import { cn } from "@/lib/cn";
import { cleanSection, clipSection, groupViews, matchSection, sectionKey, sectionProblem, viewSections } from "@/lib/viewSections";

/**
 * The view editor: `view` to change one, else a new view, started from a copy of `copyOf`
 * (Duplicate) that is saved right after it.
 */
export function ViewDrawer({ view, copyOf, views, nextPosition, onClose }: { view: View | null; copyOf?: View; views: View[]; nextPosition: number; onClose: () => void }) {
  const { t } = useTranslation("settingsInbox");
  useTranslation("indicators");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { teams: allTeams } = useTeams();
  // Without severity in the workspace, its filter is offered only to clear one the view has.
  const display = useDisplay();
  const role = useRole();
  const me = useUser();
  const rights = viewRights(atLeast(role, "admin"), allTeams, me.id);
  // What the editor starts from: the view, the copy, or a blank view.
  const [start] = useState(() => view ?? (copyOf ? copyView(copyOf, t("views.copyName", { name: copyOf.name }), rights) : null));
  const [name, setName] = useState(start?.name ?? "");
  const [shared, setShared] = useState(start?.shared ?? true);
  const [teamId, setTeamId] = useState<string | null>(start?.team_id ?? null);
  const [icon, setIcon] = useState<ViewIconValue | null>(start?.icon ?? null);
  const [section, setSection] = useState(cleanSection(start?.section));
  const allViews = useQuery(q.views()).data;
  const inUse = viewSections(allViews ?? []);
  // Each section in use with its icon, as the sidebar shows it.
  const sectionIcon = (s: string) => {
    const e = groupViews(allViews ?? []).find((x) => x.kind === "section" && x.key === sectionKey(s));
    const i = e?.kind === "section" ? e.icon : null;
    return i ? <ViewIcon icon={i} size={14} /> : <FolderClosed />;
  };
  const sections = section && !inUse.some((s) => sectionKey(s) === sectionKey(section)) ? [...inUse, section] : inUse;
  const { t: tt } = useTranslation("settingsTeams");
  const [f, setF] = useState<TicketFilters>(start?.filters ?? { status: ["open"] });
  // The operator each row shows; it stays put while the row has no value yet.
  const [ops, setOps] = useState<Record<OpField, FilterOp>>(() => {
    const init = start?.filters ?? {};
    return { tag: filterOp(init, "tag"), team: filterOp(init, "team"), mailbox: filterOp(init, "mailbox"), channel: filterOp(init, "channel") };
  });
  const [error, setError] = useState<string | null>(null);
  const members = useMemberItems();
  const teams = useTeamItems();
  const mailboxes = useMailboxItems();
  const tagItems = useTagItems();
  // Stored names match labels in any case; show them as the label is spelled.
  const tagValues = (list: string | undefined) => splitList(list).map((n) => tagItems.find((i) => i.value.toLowerCase() === n.toLowerCase())?.value ?? n);
  // Every address tickets can be written to: each mailbox's own and its aliases.
  const mailboxRows = useQuery(q.mailboxes()).data;
  const addresses = useMemo(
    () => (mailboxRows ?? []).flatMap((m) => [m.email, ...(m.aliases ?? [])].map((a) => ({ value: a.toLowerCase(), label: a.toLowerCase(), group: m.display_name || m.name }))),
    [mailboxRows],
  );

  const initial = JSON.stringify({
    name: start?.name ?? "",
    shared: start?.shared ?? true,
    teamId: start?.team_id ?? null,
    section: cleanSection(start?.section),
    f: start?.filters ?? { status: ["open"] },
    icon: start?.icon ?? null,
  });
  const dirty = JSON.stringify({ name, shared, teamId, section, f, icon }) !== initial;
  const audience = viewAudience({ shared, team_id: teamId });
  // The original is for people the person may not create views for, so the copy is theirs alone.
  const madePersonal = copyOf && start ? viewAudience(copyOf) !== viewAudience(start) : false;

  const requestClose = () => {
    if (!dirty) return onClose();
    confirm.show(t("views.discardBody"), onClose, {
      title: t("common.discardTitle"),
      confirmLabel: t("common.discard"),
      danger: true,
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      const filters = cleanFilters(f);
      if (view) return api.views.update(view.id, { name: name.trim(), shared: teamId ? false : shared, team_id: teamId, filters, section: section || null, icon });
      const position = copyOf ? copyOf.position + 1 : nextPosition;
      const created = await api.views.create({
        // A copy keeps every other field of the original.
        ...start,
        name: name.trim(),
        shared: teamId ? false : shared,
        team_id: teamId,
        filters,
        section: section || null,
        icon,
        position,
      });
      if (copyOf) {
        // The views after the original move down one, so the copy sits right after it.
        const moves = makeRoom(views, copyOf.id, position, (v) => canWriteView(rights, v));
        const done = await Promise.allSettled(moves.map((m) => api.views.update(m.id, { position: m.position })));
        if (done.some((r) => r.status === "rejected")) toast.error(t("views.reorderFailed"));
        void qc.invalidateQueries({ queryKey: qk.views });
      }
      return created;
    },
    onSuccess: (v) => {
      upsertInList(qc, qk.views, v);
      void qc.invalidateQueries({ queryKey: qk.counts });
      toast.success(view ? t("views.saved") : t("views.created"));
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const set = <K extends keyof TicketFilters>(k: K, v: TicketFilters[K] | undefined) => setF((cur) => ({ ...cur, [k]: v }));
  const setOp = (field: OpField, op: FilterOp) => {
    setOps((cur) => ({ ...cur, [field]: op }));
    setF((cur) => withOp(cur, field, op));
  };
  const clearRow = (field: OpField) => () => {
    setOps((cur) => ({ ...cur, [field]: "is" }));
    setF((cur) => clearField(cur, field));
  };
  const opPick = (field: OpField) => <OpSelect field={field} value={ops[field]} onChange={(op) => setOp(field, op)} />;

  const assigneeItems = [
    { value: "me", label: t("views.assigneeViewer"), icon: <UserRound /> },
    {
      value: "none",
      label: t("views.unassigned"),
      icon: <span className="size-3.5 rounded-full border border-dashed border-fg-4" />,
    },
    ...members,
  ];

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && requestClose()}
      title={view ? t("views.editTitle") : copyOf ? t("views.duplicateTitle") : t("views.new")}
      width={480}
      onEscapeKeyDown={(e) => {
        if (dirty) {
          e.preventDefault();
          requestClose();
        }
      }}
      onInteractOutside={(e) => {
        e.preventDefault();
        requestClose();
      }}
    >
      <form
        className="flex min-h-full flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!name.trim()) return setError(t("views.needName"));
          save.mutate();
        }}
      >
        <div className="flex flex-1 flex-col gap-5 p-5">
          <Field label={t("views.nameLabel")}>
            {(p) => (
              <TextInput {...p} autoFocus value={name} maxLength={60} placeholder={t("views.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <ViewIconField value={icon} onChange={setIcon} name={name} />
          <Field label={t("views.sectionLabel")} hint={t("views.sectionHint")} optional>
            {(p) => (
              <Picker
                items={[
                  { value: "", label: t("views.noSection"), icon: <X /> },
                  ...sections.map((s) => ({ value: s, label: s, icon: sectionIcon(s) })),
                ]}
                value={section}
                onSelect={setSection}
                // A typed name joins the section it names in any case.
                onCreate={(typed) => {
                  // The API's rule for names: no angle brackets or control characters, at most 60 characters.
                  if (sectionProblem(typed)) return setError(t("views.sectionChars"));
                  setError(null);
                  setSection(matchSection(clipSection(typed), inUse));
                }}
                createLabel={t("views.newSection")}
                placeholder={t("views.sectionSearch")}
                emptyText={t("views.sectionEmpty")}
                width={300}
                trigger={
                  <ValueButton id={p.id} aria-describedby={p["aria-describedby"]} size="md" placeholder={t("views.noSection")} icon={section ? sectionIcon(section) : undefined} className="w-full">
                    {section || undefined}
                  </ValueButton>
                }
              />
            )}
          </Field>
          {allTeams.length > 0 || teamId ? (
            <div className="flex flex-col gap-2.5 rounded-lg border border-line px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[13px] font-medium">{tt("scoped.viewShare")}</div>
                <Segmented
                  size="xs"
                  value={audience}
                  onChange={(v) => {
                    if (v === "team") {
                      setTeamId(teamId ?? allTeams[0]?.id ?? null);
                      setShared(false);
                    } else {
                      setTeamId(null);
                      setShared(v === "everyone");
                    }
                  }}
                  options={[
                    { value: "me", label: tt("scoped.viewMe"), icon: <Lock /> },
                    { value: "team", label: tt("scoped.viewTeam"), icon: <UsersRound /> },
                    { value: "everyone", label: tt("scoped.viewEveryone"), icon: <Globe /> },
                  ]}
                />
              </div>
              {audience === "team" && <TeamPick className="w-full" value={teamId} onChange={(v) => setTeamId(v)} />}
              <div className="text-[12px] text-fg-3">{viewAudienceHint(t, audience, allTeams.find((x) => x.id === teamId)?.name)}</div>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
              <IconTile tone={shared ? "blue" : "gray"} size="sm">
                {shared ? <Globe /> : <Lock />}
              </IconTile>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{t("views.visibleTitle")}</div>
                <div className="text-[12px] text-fg-3">{viewAudienceHint(t, audience)}</div>
              </div>
              <Switch checked={shared} onCheckedChange={setShared} aria-label={t("views.visibleTitle")} />
            </div>
          )}
          {madePersonal && copyOf && (
            <p className="-mt-3 text-[12px] text-fg-3">
              {copyPersonalNote(t, copyOf, allTeams)}
            </p>
          )}

          <div>
            <div className="label-caps mb-2">{t("views.showWhere")}</div>
            <div className="flex flex-col rounded-lg border border-line bg-surface">
              <FilterRow label={t("views.filters.status")} onClear={f.status?.length ? () => set("status", undefined) : undefined}>
                <MultiPick
                  items={statusItems()}
                  values={f.status ?? []}
                  onChange={(v) => set("status", v as TicketStatus[])}
                  placeholder={t("views.any.status")}
                />
              </FilterRow>
              <FilterRow label={t("views.filters.priority")} onClear={f.priority?.length ? () => set("priority", undefined) : undefined}>
                <MultiPick
                  items={priorityItems()}
                  values={f.priority ?? []}
                  onChange={(v) => set("priority", v as Priority[])}
                  placeholder={t("views.any.priority")}
                />
              </FilterRow>
              {(display.severity || !!f.severity?.length) && (
                <FilterRow label={t("views.filters.severity")} onClear={f.severity?.length ? () => set("severity", undefined) : undefined}>
                  <MultiPick
                    items={severityFilterItems()}
                    values={f.severity ?? []}
                    onChange={(v) => set("severity", v as (Severity | "none")[])}
                    placeholder={t("views.any.severity")}
                  />
                </FilterRow>
              )}
              <FilterRow label={t("views.filters.assignee")} onClear={f.assignee ? () => set("assignee", undefined) : undefined}>
                <SinglePick items={assigneeItems} value={f.assignee} onChange={(v) => set("assignee", v)} placeholder={t("views.any.assignee")} width={280} />
              </FilterRow>
              <FilterRow label={t("views.filters.team")} onClear={hasFilter(f, "team") ? clearRow("team") : undefined}>
                {opPick("team")}
                {ops.team === "not" ? (
                  <MultiPick items={teams} values={splitList(f.team_not)} onChange={(v) => set("team_not", joinList(v))} placeholder={t("views.choose.team")} />
                ) : (
                  <MultiPick items={teams} values={splitList(f.team_id)} onChange={(v) => set("team_id", joinList(v))} placeholder={t("views.any.team")} />
                )}
              </FilterRow>
              <FilterRow label={t("views.filters.mailbox")} onClear={hasFilter(f, "mailbox") ? clearRow("mailbox") : undefined}>
                {opPick("mailbox")}
                {ops.mailbox === "not" ? (
                  <MultiPick items={mailboxes} values={splitList(f.mailbox_not)} onChange={(v) => set("mailbox_not", joinList(v))} placeholder={t("views.choose.mailbox")} />
                ) : (
                  <SinglePick items={mailboxes} value={f.mailbox_id} onChange={(v) => set("mailbox_id", v)} placeholder={t("views.any.mailbox")} width={300} />
                )}
              </FilterRow>
              <FilterRow label={t("views.filters.writtenTo")} onClear={f.received_at ? () => set("received_at", undefined) : undefined}>
                <SinglePick items={addresses} value={f.received_at} onChange={(v) => set("received_at", v)} placeholder={t("views.any.writtenTo")} width={300} />
              </FilterRow>
              <FilterRow label={t("views.filters.contact")} onClear={f.contact_not ? () => set("contact_not", undefined) : undefined}>
                <NotOp />
                <ContactsPick values={splitList(f.contact_not)} onChange={(v) => set("contact_not", joinList(v))} placeholder={t("views.choose.contact")} />
              </FilterRow>
              <FilterRow label={t("views.filters.company")} onClear={f.company_not ? () => set("company_not", undefined) : undefined}>
                <NotOp />
                <CompaniesPick values={splitList(f.company_not)} onChange={(v) => set("company_not", joinList(v))} placeholder={t("views.choose.company")} />
              </FilterRow>
              <FilterRow label={t("views.filters.tag")} onClear={hasFilter(f, "tag") ? clearRow("tag") : undefined}>
                {opPick("tag")}
                {ops.tag === "not" ? (
                  <MultiPick items={tagItems} values={tagValues(f.tag_not)} onChange={(v) => set("tag_not", joinList(v))} placeholder={t("views.choose.tag")} />
                ) : ops.tag === "is" ? (
                  <MultiPick items={tagItems} values={tagValues(f.tag)} onChange={(v) => set("tag", joinList(v))} placeholder={t("views.any.tag")} />
                ) : null}
              </FilterRow>
              <FilterRow label={t("views.filters.channel")} onClear={hasFilter(f, "channel") ? clearRow("channel") : undefined}>
                {opPick("channel")}
                {ops.channel === "not" ? (
                  <MultiPick
                    items={channelItems()}
                    values={f.channel_not ?? []}
                    onChange={(v) => set("channel_not", v.length ? (v as Channel[]) : undefined)}
                    placeholder={t("views.choose.channel")}
                  />
                ) : (
                  <SinglePick items={channelItems()} value={f.channel} onChange={(v) => set("channel", v as Channel)} placeholder={t("views.any.channel")} />
                )}
              </FilterRow>
              <FilterRow label={t("views.filters.keyword")} onClear={f.q ? () => set("q", undefined) : undefined}>
                <TextInput
                  inputSize="sm"
                  value={f.q ?? ""}
                  placeholder={t("views.keywordPlaceholder")}
                  aria-label={t("views.filters.keyword")}
                  onChange={(e) => set("q", e.target.value || undefined)}
                  className="w-full"
                />
              </FilterRow>
            </div>
          </div>
          {view && (
            <Link
              to="/views/$viewId/{-$ticketId}"
              params={{ viewId: view.id, ticketId: undefined }}
              className="inline-flex w-fit items-center gap-1 text-[12.5px] text-fg-3 underline-offset-2 hover:text-fg hover:underline"
            >
              {t("views.openThis")} <ArrowUpRight className="size-3.5" />
            </Link>
          )}
        </div>
        <div className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-surface px-5 py-3">
          <span className="flex-1 text-xs text-danger-fg">{error}</span>
          <Button variant="ghost" onClick={requestClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" loading={save.isPending}>
            {view ? t("views.save") : t("views.create")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function FilterRow({ label, children, onClear }: { label: string; children: React.ReactNode; onClear?: () => void }) {
  const { t } = useTranslation("settingsInbox");
  return (
    <div className={cn("flex min-h-11 items-center gap-3 border-b border-line-soft px-3 transition-colors last:border-0", onClear && "bg-sunken/60")}>
      <span className={cn("w-[72px] shrink-0 text-[12.5px]", onClear ? "font-medium text-fg-2" : "text-fg-3")}>{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <button
        type="button"
        aria-label={t("views.clear", { field: label.toLowerCase() })}
        onClick={onClear}
        disabled={!onClear}
        className="flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-4 hover:bg-hover hover:text-fg disabled:invisible"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** The operator of a row that only leaves tickets out, in the place of OpSelect. */
function NotOp() {
  const { t } = useTranslation("settingsInbox");
  return <span className="w-[104px] shrink-0 px-2 text-[12.5px] text-fg-2">{t("views.ops.not")}</span>;
}

/** A row's operator: is / is not, and for labels any of / none of / empty. */
function OpSelect({ field, value, onChange }: { field: OpField; value: FilterOp; onChange: (op: FilterOp) => void }) {
  const { t } = useTranslation("settingsInbox");
  const label: Record<FilterOp, string> =
    field === "tag"
      ? { is: t("views.labelOps.is"), not: t("views.labelOps.not"), empty: t("views.labelOps.empty") }
      : { is: t("views.ops.is"), not: t("views.ops.not"), empty: t("views.labelOps.empty") };
  return (
    <Select<FilterOp>
      size="sm"
      value={value}
      onChange={onChange}
      options={fieldOps[field].map((o) => ({ value: o, label: label[o] }))}
      className="w-[104px] shrink-0"
      aria-label={t("edit.operator")}
    />
  );
}
