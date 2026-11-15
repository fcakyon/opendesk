import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Clock, IdCard, Link2, LogOut, MoreHorizontal, Send, ShieldCheck, Trash2, UserMinus, UserPlus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsPage, Section, ListRow } from "@/components/layout";
import { ListSkeleton, RolePill, roleTone, StatePill, SummaryStrip } from "@/components/settings2/bits";
import { MemberProfileFields, profileChanges, profileDirty, profileOf, useSaveProfile } from "@/components/settings2/MemberProfileFields";
import { MemberTeams } from "@/components/settings2/memberTeams";
import { MemberFilterBar, useMemberFilters } from "@/components/settings2/MemberFilterBar";
import { useTeams } from "@/components/settings2/teams";
import { MotionList, MotionRow } from "@/components/settings2/motion";
import { EmptyState } from "@/components/ui/empty";
import { SettingsEmpty } from "@/components/settings2/SettingsEmpty";
import { tone as tones } from "@/lib/tones";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { copyText } from "@/components/ui/copy-button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, Drawer } from "@/components/ui/dialog";
import { Field } from "@/components/ui/input";
import { Menu, MenuChoice, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuTrigger } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/client";
import type { Invitation, Member, MemberProfile, Role } from "@/lib/api/types";
import { relLong, shortDate } from "@/lib/format";
import { q, qk, removeFromList } from "@/lib/queries";
import { atLeast, reloadSession, useRole, useSession } from "@/lib/session";
import { cn } from "@/lib/cn";
import { filterMembers, memberCounts } from "@/lib/memberFilters";
import { PlanLimitHint, showLimit } from "@/components/billing/PlanLimit";
import { useLimit } from "@/components/billing/hooks";
import { useVarSuggest } from "@/components/templates/extension";

const roleLabel: Record<Role, string> = { owner: "Owner", admin: "Admin", agent: "Agent", viewer: "Viewer" };
const roleHint: Record<Exclude<Role, "owner">, string> = {
  admin: "Manages settings, mailboxes and members",
  agent: "Works tickets, contacts and articles",
  viewer: "Reads everything, changes nothing",
};

/** Which roles `me` may hand out, and whether they may manage `target` at all. */
type DeleteRule = "off" | "own" | "all";

function grantable(me: Role): Exclude<Role, "owner">[] {
  if (me === "owner") return ["admin", "agent", "viewer"];
  if (me === "admin") return ["agent", "viewer"];
  return [];
}
function canManage(me: Role, meId: string, target: Member) {
  if (target.user.id === meId || target.role === "owner") return false;
  if (me === "owner") return true;
  return me === "admin" && (target.role === "agent" || target.role === "viewer");
}

export default function Members() {
  const { t } = useTranslation("settings");
  const role = useRole();
  const [inviteOpen, setInviteOpen] = useState(false);
  const limit = useLimit("members");
  return (
    <SettingsPage
      wide
      title={t("members.title")}
      description={t("members.description")}
      actions={
        atLeast(role, "admin") && (
          <Button
            variant="primary"
            icon={<UserPlus className="size-3.5" />}
            onClick={() => (limit.atLimit ? showLimit("members", limit.max) : setInviteOpen(true))}
          >
            {t("members.invite")}
          </Button>
        )
      }
    >
      {atLeast(role, "admin") && <PlanLimitHint kind="members" className="-mt-3" />}
      <MemberSummary />
      <MembersList onInvite={atLeast(role, "admin") ? () => (limit.atLimit ? showLimit("members", limit.max) : setInviteOpen(true)) : undefined} />
      {atLeast(role, "admin") && <Invitations />}
      {inviteOpen && <InviteDialog onClose={() => setInviteOpen(false)} />}
    </SettingsPage>
  );
}

function MembersList({ onInvite }: { onInvite?: () => void }) {
  const { t } = useTranslation("settings");
  const filter = useMemberFilters();
  const { teams } = useTeams();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const role = useRole();
  const meId = useSession((s) => s.user!.id);
  const { data, isLoading } = useQuery(q.members());
  const admin = atLeast(role, "admin");
  const [editing, setEditing] = useState<string | null>(null);
  const editingMember = data?.find((m) => m.user.id === editing);

  const patchMembers = (fn: (m: Member[]) => Member[]) => {
    const prev = qc.getQueryData<Member[]>(qk.members);
    if (prev) qc.setQueryData(qk.members, fn(prev));
    return { prev };
  };

  const changeRole = useMutation({
    mutationFn: ({ uid, role }: { uid: string; role: Role }) => api.members.update(uid, role),
    onMutate: async ({ uid, role }) => {
      await qc.cancelQueries({ queryKey: qk.members });
      return patchMembers((list) => list.map((m) => (m.user.id === uid ? { ...m, role } : m)));
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.members, ctx.prev);
      toast.error(e);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.members }),
  });

  const setDelete = useMutation({
    mutationFn: ({ uid, value }: { uid: string; value: "default" | DeleteRule }) => api.members.setMessageDelete(uid, value),
    onMutate: async ({ uid, value }) => {
      await qc.cancelQueries({ queryKey: qk.members });
      return patchMembers((list) => list.map((m) => (m.user.id === uid ? { ...m, message_delete: value === "default" ? null : value } : m)));
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.members, ctx.prev);
      toast.error(e);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.members }),
  });
  const { data: ws } = useQuery(q.workspace());
  const wsRule: DeleteRule = ws?.settings.message_delete ?? "own";

  const remove = async (m: Member) => {
    const { prev } = patchMembers((list) => list.filter((x) => x.user.id !== m.user.id));
    try {
      await api.members.remove(m.user.id);
      void qc.invalidateQueries({ queryKey: qk.billing, exact: true });
      toast.success(`${m.user.name} removed`);
    } catch (e) {
      if (prev) qc.setQueryData(qk.members, prev);
      throw e;
    }
  };

  const leave = () =>
    confirm.show(
      "You lose access to every ticket and setting in this workspace. An admin can invite you back.",
      async () => {
        try {
          await api.members.remove(meId);
        } catch (e) {
          if (isApiError(e, "owner_cannot_leave")) throw new Error("Transfer ownership before you leave.", { cause: e });
          throw e;
        }
        qc.clear();
        const s = await reloadSession();
        void navigate(s.workspaceId ? { to: "/" } : { to: "/onboarding" });
      },
      { title: "Leave this workspace?", confirmLabel: "Leave", danger: true },
    );

  const all = data ?? [];
  const counts = useMemo(() => memberCounts(data ?? [], teams), [data, teams]);
  const sorted = filterMembers(all, filter.filters, teams).sort((a, b) => {
    const r = { owner: 0, admin: 1, agent: 2, viewer: 3 } as const;
    return r[a.role] - r[b.role] || a.user.name.localeCompare(b.user.name);
  });
  // Filters are for longer lists; a link with filters set shows them whatever the size.
  const showFilters = all.length > 6 || filter.active;
  const onlySearch = !filter.filters.roles.length && !filter.filters.team && !filter.filters.statuses.length;

  return (
    <Section
      flush
      title={data ? t("members.count", { count: data.length }) : t("members.title")}
      actions={
        role !== "owner" && (
          <Button size="sm" variant="ghost" icon={<LogOut className="size-3.5" />} onClick={leave}>
            {t("members.leave")}
          </Button>
        )
      }
    >
      {!isLoading && showFilters && <MemberFilterBar state={filter} counts={counts} teams={teams} shown={sorted.length} total={all.length} />}
      {isLoading ? (
        <ListSkeleton rows={5} />
      ) : !sorted.length && filter.active ? (
        <EmptyState
          compact
          lit={3}
          title={t("members.noMatch")}
          description={onlySearch ? t("members.noMatchHint") : t("members.filter.noMatchHint")}
          action={<Button onClick={filter.clear}>{t("members.filter.clear")}</Button>}
        />
      ) : !sorted.length ? (
        <SettingsEmpty
          art="contacts"
          ghost="people"
          title={t("members.emptyTitle")}
          description={t("members.emptyHint")}
          action={
            onInvite ? (
              <Button variant="primary" icon={<UserPlus className="size-3.5" />} onClick={onInvite}>
                {t("members.invite")}
              </Button>
            ) : undefined
          }
          tips={[
            { label: t("members.emptyTips.roles"), icon: <ShieldCheck /> },
            { label: t("members.emptyTips.expire"), icon: <Clock /> },
          ]}
        />
      ) : (
        <>
          <div className="hidden h-8 items-center gap-3 border-b border-line-soft bg-sunken px-4 sm:flex">
            <span className="label-caps flex-1">{t("members.columns.person")}</span>
            <span className="label-caps w-32">{t("members.columns.joined")}</span>
            <span className="label-caps w-[120px]">{t("members.columns.role")}</span>
            <span className="w-7" />
          </div>
          <MotionList>
            {sorted.map((m) => {
              const manageable = canManage(role, meId, m);
              return (
                <MotionRow key={m.user.id}>
                  <ListRow>
                    <Avatar name={m.user.name || m.user.email} src={m.user.avatar_url} size="lg" presence={m.presence} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[13px] font-medium">
                        <span className="truncate">{m.user.name}</span>
                        {m.user.id === meId && (
                          <span className="rounded-sm bg-hover px-1.5 py-px text-[10.5px] font-medium text-fg-3">{t("members.you")}</span>
                        )}
                      </div>
                      <div className="mono truncate text-xs text-fg-3">{m.user.email}</div>
                      {m.role === "agent" && m.message_delete && (
                        <span className="mt-1 inline-flex h-5 items-center gap-1 rounded-sm bg-hover px-1.5 text-[11px] text-fg-3">
                          <Trash2 className="size-3" />
                          {t(`members.deletes.${m.message_delete}`)}
                        </span>
                      )}
                      <MemberTeams m={m} canEdit={atLeast(role, "admin")} />
                    </div>
                    <span className="hidden w-32 whitespace-nowrap text-xs tabular-nums text-fg-3 sm:block">{shortDate(m.created_at)}</span>
                    <div className="w-[120px]">
                      {manageable ? (
                        <Select
                          size="sm"
                          aria-label={`Role for ${m.user.name}`}
                          value={m.role}
                          onChange={(v) => changeRole.mutate({ uid: m.user.id, role: v })}
                          options={grantable(role)
                            .concat(m.role === "admin" && role !== "owner" ? ["admin"] : [])
                            .map((r) => ({ value: r, label: roleLabel[r], icon: <RoleDot role={r} /> }))}
                        />
                      ) : (
                        <span className="flex h-7 items-center px-0.5">
                          <RolePill role={m.role} />
                        </span>
                      )}
                    </div>
                    <div className="w-7">
                      {admin && (
                        <Menu>
                          <MenuTrigger asChild>
                            <Button size="sm" variant="ghost" square aria-label={`Actions for ${m.user.name}`}>
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem icon={<IdCard />} onSelect={() => setEditing(m.user.id)}>
                              {t("members.editProfile")}
                            </MenuItem>
                            {m.role === "agent" && (
                              <MenuSub icon={<Trash2 />} label={t("members.deleteRule")}>
                                <MenuChoice checked={!m.message_delete} onSelect={() => setDelete.mutate({ uid: m.user.id, value: "default" })}>
                                  {t("members.deleteDefault", { rule: t(`members.deletes.${wsRule}`) })}
                                </MenuChoice>
                                <MenuSeparator />
                                {(["off", "own", "all"] as const).map((r) => (
                                  <MenuChoice key={r} checked={m.message_delete === r} onSelect={() => setDelete.mutate({ uid: m.user.id, value: r })}>
                                    {t(`members.deletes.${r}`)}
                                  </MenuChoice>
                                ))}
                              </MenuSub>
                            )}
                            {manageable && (
                              <>
                                <MenuSeparator />
                                <MenuItem
                                  danger
                                  icon={<UserMinus />}
                                  onSelect={() =>
                                    confirm.show(t("members.removeBody", { name: m.user.name }), () => remove(m), {
                                      title: t("members.removeTitle"),
                                      confirmLabel: t("members.removeConfirm"),
                                      danger: true,
                                    })
                                  }
                                >
                                  {t("members.remove")}
                                </MenuItem>
                              </>
                            )}
                          </MenuContent>
                        </Menu>
                      )}
                    </div>
                  </ListRow>
                </MotionRow>
              );
            })}
          </MotionList>
        </>
      )}
      {editingMember && <ProfileDrawer key={editingMember.user.id} member={editingMember} self={editingMember.user.id === meId} onClose={() => setEditing(null)} />}
    </Section>
  );
}

/** An admin edits what customers see of a member (contracts/templates.md "Signatures"). */
function ProfileDrawer({ member, self, onClose }: { member: Member; self: boolean; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const confirm = useConfirm();
  const base = useMemo(() => profileOf(member), [member]);
  const [draft, setDraft] = useState<MemberProfile>(base);
  const save = useSaveProfile(member.user.id, self);
  const dirty = profileDirty(draft, base);

  const close = () => {
    if (!dirty || save.isPending) return onClose();
    confirm.show(t("members.discardBody"), onClose, {
      title: t("members.discardTitle"),
      confirmLabel: t("members.discardConfirm"),
      danger: true,
    });
  };
  // Clicks and Escape in the "{{" variable list belong to the editor, not the drawer.
  const suggesting = () => useVarSuggest.getState().open;

  return (
    <Drawer
      open
      onOpenChange={(o) => {
        if (!o) close();
      }}
      width={640}
      title={t("members.profileTitle")}
      onEscapeKeyDown={(e) => {
        if (suggesting()) e.preventDefault();
      }}
      onInteractOutside={(e) => {
        if (suggesting()) e.preventDefault();
      }}
      header={
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={member.user.name || member.user.email} src={member.user.avatar_url} size="sm" />
          <span className="truncate text-sm font-medium">{member.user.name || member.user.email}</span>
        </span>
      }
    >
      <form
        className="flex min-h-full flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          // The editor's link form submits through portals too.
          if (e.target !== e.currentTarget) return;
          if (dirty) save.mutate(profileChanges(draft, base), { onSuccess: onClose });
        }}
      >
        <div className="flex flex-1 flex-col gap-4 p-5">
          <div>
            <h2 className="text-[13px] font-semibold tracking-[-0.01em]">{t("members.profileTitle")}</h2>
            <p className="mt-0.5 text-[12px] leading-[18px] text-fg-3">{t("members.profileHint", { name: member.user.name || member.user.email })}</p>
          </div>
          <MemberProfileFields
            variant="stacked"
            other={!self}
            value={draft}
            onChange={(p) => {
              setDraft(p);
              save.clearProblems();
            }}
            problems={save.problems}
          />
        </div>
        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-sunken px-5 py-3">
          <Button variant="ghost" onClick={close}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
            {t("members.save")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function RoleDot({ role }: { role: Role }) {
  return <span className={cn("!size-1.5 rounded-full", tones[roleTone[role]].solid)} aria-hidden />;
}

/** Headcount by role, plus open invitations. */
function MemberSummary() {
  const { t } = useTranslation("settings");
  const role = useRole();
  const { data } = useQuery(q.members());
  const { data: invites } = useQuery({ ...q.invitations(), enabled: atLeast(role, "admin") });
  if (!data) return null;
  const n = (r: Role[]) => data.filter((m) => r.includes(m.role)).length;
  return (
    <SummaryStrip
      className="-mb-3"
      items={[
        { label: t("members.summary.members"), value: data.length },
        { label: t("members.summary.admins"), value: n(["owner", "admin"]), tone: roleTone.admin },
        { label: t("members.summary.agents"), value: n(["agent"]), tone: roleTone.agent },
        { label: t("members.summary.viewers"), value: n(["viewer"]), tone: roleTone.viewer },
        ...(atLeast(role, "admin") ? [{ label: t("members.summary.invited"), value: invites?.length ?? 0, tone: "amber" as const }] : []),
      ]}
    />
  );
}

function Invitations() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery(q.invitations());

  const revoke = async (inv: Invitation) => {
    const prev = qc.getQueryData<Invitation[]>(qk.invitations);
    removeFromList(qc, qk.invitations, inv.id);
    try {
      await api.invitations.revoke(inv.id);
      void qc.invalidateQueries({ queryKey: qk.billing, exact: true });
    } catch (e) {
      if (prev) qc.setQueryData(qk.invitations, prev);
      throw e;
    }
  };
  const copyLink = async (inv: Invitation) => {
    try {
      const { url } = await api.invitations.link(inv.id);
      if (await copyText(url)) toast.success(t("members.invites.linkCopied"), { description: t("members.invites.linkCopiedHint", { email: inv.email }) });
      else toast.info(url);
      void qc.invalidateQueries({ queryKey: qk.invitations });
    } catch (e) {
      toast.error(e);
    }
  };
  const resend = async (inv: Invitation) => {
    try {
      await api.invitations.resend(inv.id);
      toast.success(t("members.invites.resent", { email: inv.email }));
      void qc.invalidateQueries({ queryKey: qk.invitations });
    } catch (e) {
      toast.error(e);
    }
  };

  if (isLoading || !data?.length) return null;

  return (
    <Section flush title={t("members.invites.title")} description={t("members.invites.description")}>
      <MotionList>
        {data.map((inv) => {
          const expired = Date.parse(inv.expires_at) < Date.now();
          return (
            <MotionRow key={inv.id}>
              <ListRow>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed border-line-strong text-fg-4">
                  <UserPlus className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mono truncate text-[12.5px] text-fg">{inv.email}</div>
                  <div className="text-xs text-fg-3">
                    {inv.invited_by ? t("members.invites.by", { name: inv.invited_by.name, when: relLong(inv.created_at) }) : t("members.invites.at", { when: relLong(inv.created_at) })}
                  </div>
                </div>
                {expired ? (
                  <StatePill state="expired">{t("members.invites.expired")}</StatePill>
                ) : (
                  <StatePill state="pending">{t("members.invites.expires", { date: shortDate(inv.expires_at) })}</StatePill>
                )}
                <span className="w-[72px]">
                  <RolePill role={inv.role} />
                </span>
                <Button size="sm" variant="ghost" icon={<Link2 />} onClick={() => void copyLink(inv)}>
                  {t("members.invites.copyLink")}
                </Button>
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="sm" variant="ghost" square aria-label={t("members.invites.actions", { email: inv.email })}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem icon={<Send />} onSelect={() => void resend(inv)}>
                      {t("members.invites.resend")}
                    </MenuItem>
                    <MenuItem
                      danger
                      icon={<X />}
                      onSelect={() =>
                        confirm.show(t("members.invites.revokeBody", { email: inv.email }), () => revoke(inv), {
                          title: t("members.invites.revokeTitle"),
                          confirmLabel: t("members.invites.revoke"),
                        })
                      }
                    >
                      {t("members.invites.revoke")}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </ListRow>
            </MotionRow>
          );
        })}
      </MotionList>
    </Section>
  );
}

const emailRe = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function InviteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const role = useRole();
  const options = grantable(role);
  const [emails, setEmails] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<Role, "owner">>("agent");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const commit = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = parts.filter((p) => !emailRe.test(p));
    const good = parts.filter((p) => emailRe.test(p));
    setEmails((cur) => Array.from(new Set([...cur, ...good])));
    setText(bad.join(" "));
    setError(bad.length ? `${bad[0]} doesn't look like an email address.` : null);
  };

  const send = async () => {
    const pending = text.trim() ? [...emails, ...text.split(/[\s,;]+/).filter((p) => emailRe.test(p.trim()))] : emails;
    if (!pending.length) return setError("Add at least one email address.");
    setBusy(true);
    setError(null);
    const failed: string[] = [];
    let lastError: unknown = null;
    for (const email of pending) {
      try {
        await api.invitations.create({ email, role: inviteRole });
      } catch (e) {
        failed.push(email);
        lastError = e;
      }
    }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: qk.invitations });
    void qc.invalidateQueries({ queryKey: qk.billing, exact: true });
    const sent = pending.length - failed.length;
    if (sent) toast.success(sent === 1 ? "Invitation sent" : `${sent} invitations sent`);
    if (failed.length) {
      setEmails(failed);
      setText("");
      setError(`${failed.join(", ")}: ${errorMessage(lastError)}`);
    } else onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("members.invite")}
      description={t("members.inviteDialog.description")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={send}>
            {t("members.inviteDialog.send")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-1">
        <PlanLimitHint kind="members" compact />
        <Field label={t("members.inviteDialog.emails")} hint={t("members.inviteDialog.emailsHint")} error={error}>
          {({ id }) => (
            <div
              className={cn(
                "flex min-h-[72px] flex-wrap content-start items-start gap-1 rounded-md border border-line bg-surface p-1.5 focus-within:border-fg-3 focus-within:shadow-[0_0_0_3px_var(--focus)]",
                error && "border-danger",
              )}
              onClick={() => document.getElementById(id)?.focus()}
            >
              {emails.map((e) => (
                <span key={e} className="mono inline-flex h-6 items-center gap-1 rounded-sm border border-line bg-hover pl-2 pr-0.5 text-xs">
                  {e}
                  <button
                    type="button"
                    aria-label={`Remove ${e}`}
                    onClick={() => setEmails((cur) => cur.filter((x) => x !== e))}
                    className="flex size-5 items-center justify-center rounded text-fg-3 hover:bg-active hover:text-fg"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <input
                id={id}
                autoFocus
                value={text}
                onChange={(e) => {
                  const v = e.target.value;
                  if (/[\s,;]$/.test(v)) commit(v);
                  else setText(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commit(text);
                  } else if (e.key === "Backspace" && !text && emails.length) setEmails((cur) => cur.slice(0, -1));
                }}
                onBlur={() => text.trim() && commit(text)}
                onPaste={(e) => {
                  e.preventDefault();
                  commit(text + " " + e.clipboardData.getData("text"));
                }}
                placeholder={emails.length ? "" : "name@company.com, another@company.com"}
                className="h-6 min-w-[180px] flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-fg-4"
              />
            </div>
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium">{t("members.columns.role")}</span>
          <div role="radiogroup" aria-label={t("members.columns.role")} className="flex flex-col gap-1.5">
            {options.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={inviteRole === r}
                onClick={() => setInviteRole(r)}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                  inviteRole === r ? "border-fg-3 bg-hover" : "border-line hover:border-line-strong",
                )}
              >
                <span className={cn("flex size-3.5 items-center justify-center rounded-full border", inviteRole === r ? "border-inverse" : "border-line-strong")}>
                  {inviteRole === r && <span className="size-1.5 rounded-full bg-inverse" />}
                </span>
                <span className="flex-1">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    <RoleDot role={r} />
                    {roleLabel[r]}
                  </span>
                  <span className="block text-xs text-fg-3">{roleHint[r]}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
