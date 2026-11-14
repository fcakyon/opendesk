import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Slash, Trash2, Users } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsPage } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Field, SearchInput, TextInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty";
import { SettingsEmpty } from "@/components/settings2/SettingsEmpty";
import { Kbd } from "@/components/ui/kbd";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { ListSkeleton, MonoChip } from "@/components/settings2/bits";
import { rowSpring } from "@/components/settings2/motion";
import { TeamChip, TeamPick, useTeams } from "@/components/settings2/teams";
import { TemplateEditor } from "@/components/templates/TemplateEditor";
import { api } from "@/lib/api/endpoints";
import type { SavedReply } from "@/lib/api/types";
import { q, qk, removeFromList, upsertInList } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { relShort } from "@/lib/format";
import { cn } from "@/lib/cn";
import { tone } from "@/lib/tones";
import { sameJSON } from "@/lib/sameJSON";

// The reply's actions are edited as text here (labels comma-separated).
type Draft = { title: string; shortcut: string; body_html: string; team_id: string | null; addTags: string; removeTags: string; actTeam: string | null; actAssignee: string | null };
const empty: Draft = { title: "", shortcut: "", body_html: "", team_id: null, addTags: "", removeTags: "", actTeam: null, actAssignee: null };
const toDraft = (r: SavedReply): Draft => ({
  title: r.title,
  shortcut: r.shortcut,
  body_html: r.body_html,
  team_id: r.team_id ?? null,
  addTags: (r.actions?.add_tags ?? []).join(", "),
  removeTags: (r.actions?.remove_tags ?? []).join(", "),
  actTeam: r.actions?.team_id ?? null,
  actAssignee: r.actions?.assignee_id ?? null,
});
const splitTags = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const toBody = (d: Draft) => ({
  title: d.title,
  shortcut: d.shortcut,
  body_html: d.body_html,
  team_id: d.team_id,
  actions: { add_tags: splitTags(d.addTags), remove_tags: splitTags(d.removeTags), team_id: d.actTeam, assignee_id: d.actAssignee },
});
const NOBODY = "__none";
const NEW = "__new";

function cleanShortcut(s: string) {
  return s
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 32);
}

export default function SavedReplies() {
  const { t } = useTranslation("settingsInbox");
  const reduce = useReducedMotion();
  const { data: replies, isLoading } = useQuery(q.savedReplies());
  const role = useRole();
  const canEdit = atLeast(role, "agent");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [error, setError] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const term = query.trim().toLowerCase();
    return [...(replies ?? [])]
      .filter((r) => !term || r.title.toLowerCase().includes(term) || r.shortcut.toLowerCase().includes(term))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [replies, query]);

  const current = replies?.find((r) => r.id === selected) ?? null;
  const base: Draft = current ? toDraft(current) : empty;
  const dirty = selected !== null && !sameJSON(draft, base);
  const { teams } = useTeams();
  const { data: members } = useQuery(q.members());
  const { t: tt } = useTranslation("settingsTeams");
  const teamById = new Map(teams.map((x) => [x.id, x]));

  // Open the first reply once the list is in.
  useEffect(() => {
    if (selected === null && replies?.length) {
      const first = [...replies].sort((a, b) => a.title.localeCompare(b.title))[0];
      setSelected(first.id);
      setDraft(toDraft(first));
    }
  }, [replies, selected]);

  const open = (id: string | null) => {
    const go = () => {
      setError(null);
      setSelected(id);
      const r = replies?.find((x) => x.id === id);
      setDraft(r ? toDraft(r) : empty);
    };
    if (dirty)
      confirm.show(t("savedReplies.discardBody"), go, {
        title: t("common.discardTitle"),
        confirmLabel: t("common.discard"),
        danger: true,
      });
    else go();
  };

  const save = useMutation({
    mutationFn: (d: Draft) => (selected && selected !== NEW ? api.savedReplies.update(selected, toBody(d)) : api.savedReplies.create(toBody(d))),
    onSuccess: (r) => {
      upsertInList(qc, qk.savedReplies, r);
      setSelected(r.id);
      setDraft(toDraft(r));
      toast.success(t("savedReplies.saved"));
    },
    onError: (e) => toast.error(e, t("savedReplies.saveFailed")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.savedReplies.remove(id),
    onMutate: async (id) => {
      const prev = qc.getQueryData<SavedReply[]>(qk.savedReplies);
      removeFromList(qc, qk.savedReplies, id);
      setSelected(null);
      setDraft(empty);
      return { prev };
    },
    onError: (e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.savedReplies, ctx.prev);
      toast.error(e, t("savedReplies.deleteFailed"));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.savedReplies }),
  });

  const submit = () => {
    setError(null);
    if (!draft.title.trim()) return setError(t("savedReplies.needTitle"));
    if (!draft.body_html) return setError(t("savedReplies.needBody"));
    const taken = replies?.some((r) => r.id !== selected && draft.shortcut && r.shortcut === draft.shortcut);
    if (taken) return setError(t("savedReplies.shortcutTaken", { shortcut: draft.shortcut }));
    save.mutate({ ...draft, title: draft.title.trim() });
  };

  return (
    <SettingsPage
      wide
      title={t("savedReplies.title")}
      description={
        <>
          {t("savedReplies.descriptionBefore")} <Kbd>/</Kbd> {t("savedReplies.descriptionAfter")}
        </>
      }
      actions={
        canEdit && (
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => open(NEW)}>
            {t("savedReplies.new")}
          </Button>
        )
      }
    >
      {!isLoading && !replies?.length && selected !== NEW ? (
        <div className="rounded-lg border border-line bg-surface shadow-xs">
          <SettingsEmpty
            art="settings"
            title={t("savedReplies.emptyTitle")}
            description={t("savedReplies.emptyHint")}
            action={
              canEdit && (
                <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => open(NEW)}>
                  {t("savedReplies.new")}
                </Button>
              )
            }
            tips={[
              { label: t("savedReplies.emptyTips.slash"), icon: <Slash /> },
              { label: t("savedReplies.emptyTips.team"), icon: <Users /> },
            ]}
          />
        </div>
      ) : (
        <div className="grid min-h-[520px] grid-cols-1 overflow-hidden rounded-lg border border-line bg-surface shadow-xs md:grid-cols-[300px_1fr]">
          <div className="flex min-h-0 flex-col border-b border-line bg-sunken/50 md:border-b-0 md:border-r">
            <div className="flex flex-col gap-2 border-b border-line-soft p-2.5">
              <SearchInput value={query} onChange={setQuery} placeholder={t("savedReplies.find")} />
              <span className="label-caps px-1">{t("savedReplies.count", { count: replies?.length ?? 0 })}</span>
            </div>
            <div className="max-h-[600px] flex-1 overflow-y-auto p-1.5">
              {isLoading ? (
                <ListSkeleton rows={5} />
              ) : !sorted.length && selected !== NEW ? (
                <EmptyState compact lit={1} title={t("savedReplies.noMatches")} description={t("savedReplies.noMatchesHint")} />
              ) : (
                <AnimatePresence initial={false}>
                  {selected === NEW && (
                    <motion.div
                      key={NEW}
                      layout={reduce ? false : "position"}
                      initial={reduce ? false : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{
                        opacity: 0,
                        transition: { duration: reduce ? 0 : 0.12 },
                      }}
                      transition={rowSpring}
                      className="flex flex-col justify-center gap-1 rounded-md bg-surface px-2.5 py-2 shadow-xs ring-1 ring-line"
                    >
                      <span className="truncate text-[13px] font-medium">{draft.title || t("savedReplies.untitled")}</span>
                      <span className="flex">
                        {draft.shortcut ? <MonoChip>/{draft.shortcut}</MonoChip> : <span className="text-[11px] text-fg-4">{t("savedReplies.newBadge")}</span>}
                      </span>
                    </motion.div>
                  )}
                  {sorted.map((r) => (
                    <motion.button
                      key={r.id}
                      layout={reduce ? false : "position"}
                      initial={reduce ? false : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{
                        opacity: 0,
                        transition: { duration: reduce ? 0 : 0.12 },
                      }}
                      transition={rowSpring}
                      type="button"
                      onClick={() => r.id !== selected && open(r.id)}
                      aria-current={r.id === selected}
                      className={cn(
                        "flex w-full flex-col justify-center gap-1 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-hover",
                        r.id === selected && "bg-surface shadow-xs ring-1 ring-line hover:bg-surface",
                      )}
                    >
                      <span className="flex w-full items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.title}</span>
                        <span className="mono shrink-0 text-[10.5px] text-fg-4">{relShort(r.updated_at)}</span>
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5">
                        {r.shortcut ? (
                          <MonoChip className={cn("max-w-full truncate", tone.blue.chip, "border-transparent")}>/{r.shortcut}</MonoChip>
                        ) : (
                          <span className="text-[11px] text-fg-4">{t("savedReplies.noShortcut")}</span>
                        )}
                        {r.team_id && teamById.get(r.team_id) && <TeamChip team={teamById.get(r.team_id)!} size="xs" />}
                      </span>
                    </motion.button>
                  ))}
                </AnimatePresence>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            {selected === null ? (
              <div className="flex flex-1 items-center justify-center p-8">
                <EmptyState lit={3} title={t("savedReplies.pickTitle")} description={t("savedReplies.pickHint")} />
              </div>
            ) : (
              <form
                className="flex flex-1 flex-col"
                onSubmit={(e) => {
                  e.preventDefault();
                  // The editor's link form submits through portals too.
                  if (e.target === e.currentTarget) submit();
                }}
              >
                <div className={cn("grid grid-cols-1 gap-3 p-5", teams.length || draft.team_id ? "sm:grid-cols-[1fr_160px_180px]" : "sm:grid-cols-[1fr_200px]")}>
                  <Field label={t("savedReplies.titleLabel")}>
                    {(f) => (
                      <TextInput
                        {...f}
                        disabled={!canEdit}
                        value={draft.title}
                        maxLength={120}
                        placeholder={t("savedReplies.titlePlaceholder")}
                        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                      />
                    )}
                  </Field>
                  <Field label={t("savedReplies.shortcutLabel")} optional>
                    {(f) => (
                      <TextInput
                        {...f}
                        disabled={!canEdit}
                        value={draft.shortcut}
                        placeholder="refund"
                        className="mono"
                        leading={<span className="mono text-[12px] text-fg-3">/</span>}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            shortcut: cleanShortcut(e.target.value),
                          }))
                        }
                      />
                    )}
                  </Field>
                  {(teams.length > 0 || draft.team_id) && (
                    <Field label={tt("scoped.replyTeam")}>
                      {() => <TeamPick className="w-full" size="md" value={draft.team_id} noneLabel={tt("scoped.everyone")} disabled={!canEdit} onChange={(team_id) => setDraft((d) => ({ ...d, team_id }))} />}
                    </Field>
                  )}
                </div>
                <div
                  className="mx-5 mb-5 flex flex-1 flex-col gap-1.5"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canEdit) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                >
                  <TemplateEditor
                    key={selected}
                    kind="reply"
                    value={draft.body_html}
                    onChange={(html) => setDraft((d) => ({ ...d, body_html: html }))}
                    placeholder={t("savedReplies.bodyPlaceholder")}
                    minHeight={220}
                    disabled={!canEdit}
                    ariaLabel={t("savedReplies.bodyLabel")}
                  />
                  <span className="text-[11.5px] leading-4 text-fg-4">{t("savedReplies.variablesHint")}</span>
                </div>
                <fieldset className="mx-5 mb-5 grid grid-cols-1 gap-3 rounded-lg border border-line p-3 sm:grid-cols-2" disabled={!canEdit}>
                  <legend className="px-1 text-[12.5px] font-medium">{t("savedReplies.actionsTitle")}</legend>
                  <p className="text-[11.5px] leading-4 text-fg-4 sm:col-span-2">{t("savedReplies.actionsHint")}</p>
                  <Field label={t("savedReplies.addTags")} optional>
                    {(f) => <TextInput {...f} value={draft.addTags} placeholder={t("savedReplies.tagsPlaceholder")} onChange={(e) => setDraft((d) => ({ ...d, addTags: e.target.value }))} />}
                  </Field>
                  <Field label={t("savedReplies.removeTags")} optional>
                    {(f) => <TextInput {...f} value={draft.removeTags} placeholder={t("savedReplies.tagsPlaceholder")} onChange={(e) => setDraft((d) => ({ ...d, removeTags: e.target.value }))} />}
                  </Field>
                  <Field label={t("savedReplies.setTeam")} optional>
                    {() => <TeamPick className="w-full" size="md" value={draft.actTeam} noneLabel={t("savedReplies.noChange")} disabled={!canEdit} onChange={(actTeam) => setDraft((d) => ({ ...d, actTeam }))} />}
                  </Field>
                  <Field label={t("savedReplies.setAssignee")} optional>
                    {() => (
                      <Select
                        className="w-full"
                        aria-label={t("savedReplies.setAssignee")}
                        disabled={!canEdit}
                        value={draft.actAssignee ?? NOBODY}
                        onChange={(v) => setDraft((d) => ({ ...d, actAssignee: v === NOBODY ? null : v }))}
                        options={[
                          { value: NOBODY, label: t("savedReplies.noChange") },
                          ...(members ?? []).filter((m) => m.role !== "viewer").map((m) => ({ value: m.user.id, label: m.user.name })),
                        ]}
                      />
                    )}
                  </Field>
                </fieldset>
                {canEdit && (
                  <div className="flex items-center gap-2 border-t border-line bg-sunken px-5 py-3">
                    {selected !== NEW && current && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Trash2 className="size-3.5" />}
                        onClick={() =>
                          confirm.show(
                            <>
                              <span className="font-medium text-fg">{current.title}</span> {t("savedReplies.deleteBody")}
                            </>,
                            () => remove.mutateAsync(current.id),
                            {
                              title: t("savedReplies.deleteTitle"),
                              confirmLabel: t("common.delete"),
                              danger: true,
                            },
                          )
                        }
                      >
                        {t("common.delete")}
                      </Button>
                    )}
                    <span role="alert" className="flex-1 text-xs text-danger-fg">
                      {error}
                    </span>
                    {(dirty || selected === NEW) && (
                      <>
                        <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">
                          <span className={cn("size-1.5 rounded-full", tone.amber.solid)} aria-hidden />
                          {selected === NEW ? t("savedReplies.newReply") : t("savedReplies.unsaved")}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setError(null);
                            if (selected === NEW) open(null);
                            else setDraft(base);
                          }}
                        >
                          {selected === NEW ? t("common.cancel") : t("savedReplies.revert")}
                        </Button>
                      </>
                    )}
                    <Button variant="primary" size="sm" type="submit" loading={save.isPending} disabled={!dirty && selected !== NEW}>
                      {t("savedReplies.save")}
                    </Button>
                  </div>
                )}
              </form>
            )}
          </div>
        </div>
      )}
    </SettingsPage>
  );
}
