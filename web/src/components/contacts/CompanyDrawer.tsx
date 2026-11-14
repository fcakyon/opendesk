import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Building2, Pencil, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { dur, ease, springs } from "@/lib/motion";
import { PresenceList, PresenceRow } from "@/components/motion";
import { Drawer } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar } from "@/components/ui/avatar";
import { ImageUpload } from "@/components/ui/image-upload";
import { Button } from "@/components/ui/button";
import { Field, Textarea, TextInput } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { Company } from "@/lib/api/types";
import { fullDate, relShort, shortDate } from "@/lib/format";
import { useCompanyAvatar } from "@/lib/pictures";
import { q, qk } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";
import { CompanyGlyph, Detail, fieldLabel, fieldsOf, fieldText, MiniStat, none } from "./bits";
import { DrawerSkeleton } from "./ContactDrawer";
import { RecordFields, RecordLabels, useRecordFields } from "./LabelsAndFields";
import { dropCompany, patchCompany, restore, snapshot } from "./cache";

export { CompanyGlyph } from "./bits";

type Tab = "overview" | "people";

const swap = { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4, transition: { duration: dur.fast, ease: ease.out } }, transition: springs.row };

export function CompanyDrawer({ companyId, onClose }: { companyId: string | null; onClose: () => void }) {
  const { t } = useTranslation("contacts");
  const confirm = useConfirm();
  const reduce = useReducedMotion();
  const canEdit = atLeast(useRole(), "agent");
  const [tab, setTab] = useState<Tab>("overview");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { data: c, isLoading, error } = useQuery({ ...q.company(companyId ?? ""), enabled: !!companyId });
  const picture = useCompanyAvatar();
  const { data: defs } = useRecordFields("company");
  const definedKeys = new Set((defs ?? []).map((f) => f.key));
  useEffect(() => {
    setTab("overview");
    setEditing(false);
    setDirty(false);
  }, [companyId]);
  const requestClose = () => {
    if (!dirty) return onClose();
    confirm.show(t("drawer.discardCompany"), onClose, { title: t("drawer.discardTitle"), confirmLabel: t("drawer.discard"), danger: true });
  };

  return (
    <Drawer
      open={!!companyId}
      onOpenChange={(o) => !o && requestClose()}
      title={c?.name ?? t("company")}
      width={560}
      onEscapeKeyDown={(e) => {
        if (dirty) {
          e.preventDefault();
          requestClose();
        }
      }}
      onInteractOutside={(e) => {
        if (dirty) {
          e.preventDefault();
          requestClose();
        }
      }}
      header={
        <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-fg-3">
          <Building2 className="size-3.5" />
          <span>{t("company")}</span>
        </div>
      }
    >
      {error ? (
        <EmptyState lit={3} title={t("drawer.companyNotFound")} description={errorMessage(error)} />
      ) : isLoading || !c ? (
        <DrawerSkeleton />
      ) : (
        <div className="flex min-h-full flex-col">
          <div className="flex items-start gap-3.5 px-5 pb-4 pt-5">
            {canEdit ? (
              <ImageUpload
                compact
                size="md"
                shape="square"
                name={c.name}
                value={c.avatar_url}
                source={c.avatar_source}
                onChange={async (file) => {
                  await picture.upload.mutateAsync({ id: c.id, file });
                }}
                onRemove={async () => {
                  await picture.remove.mutateAsync(c.id);
                }}
                onRefresh={async () => {
                  await picture.refresh.mutateAsync(c.id);
                  toast.info(t("drawer.pictureRefresh"));
                }}
              />
            ) : (
              <CompanyGlyph name={c.name} src={c.avatar_url} size="xl" />
            )}
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[16px] font-semibold tracking-[-0.015em]">{c.name}</h2>
              <div className="mono mt-1 truncate text-xs text-fg-3">{c.domain || t("noDomain")}</div>
              <div className="mt-2.5">
                <RecordLabels kind="company" record={c} />
              </div>
            </div>
            {canEdit && !editing && (
              <Button size="sm" variant="secondary" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
                {t("drawer.edit")}
              </Button>
            )}
          </div>
          <div className="grid grid-cols-3 divide-x divide-line-soft border-y border-line-soft">
            <MiniStat label={t("col.people")} value={c.contact_count.toLocaleString()} />
            <MiniStat label={t("col.created")} value={<span title={fullDate(c.created_at)}>{shortDate(c.created_at)}</span>} />
            <MiniStat label={t("col.updated")} value={<span title={fullDate(c.updated_at)}>{relShort(c.updated_at)}</span>} />
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {editing ? (
              <motion.div key="edit" {...(reduce ? {} : swap)}>
                <EditCompany
                  key={c.id + c.updated_at}
                  c={c}
                  onDirty={setDirty}
                  onDeleted={onClose}
                  onDone={() => {
                    setDirty(false);
                    setEditing(false);
                  }}
                />
              </motion.div>
            ) : (
              <motion.div key="view" className="flex flex-1 flex-col" {...(reduce ? {} : swap)}>
                <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex flex-1 flex-col">
                  <TabsList className="sticky top-0 z-10 bg-surface px-4">
                    <TabsTrigger value="overview" icon={<Building2 />}>
                      {t("drawer.overview")}
                    </TabsTrigger>
                    <TabsTrigger value="people" icon={<Users />} count={c.contact_count}>
                      {t("drawer.people")}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="outline-none">
                    <div className="flex flex-col gap-6 px-5 py-4">
                      <RecordFields kind="company" record={c} />
                      <dl className="divide-y divide-line-soft">
                        <Detail label={t("field.domain")} mono>
                          {c.domain || none}
                        </Detail>
                        <Detail label={t("field.externalId")} mono>
                          {c.external_id || none}
                        </Detail>
                        {fieldsOf(c, definedKeys).map(([k, v]) => (
                          <Detail key={k} label={fieldLabel(k)} mono>
                            {fieldText(v)}
                          </Detail>
                        ))}
                      </dl>
                      <section>
                        <h3 className="label-caps mb-2">{t("field.notes")}</h3>
                        {c.notes ? (
                          <p className="whitespace-pre-wrap rounded-lg bg-sunken px-3.5 py-3 text-[13px] leading-5 text-fg-2">{c.notes}</p>
                        ) : (
                          <p className="text-[12.5px] text-fg-4">{t("drawer.noNotes")}</p>
                        )}
                      </section>
                    </div>
                  </TabsContent>
                  <TabsContent value="people" className="flex-1 outline-none">
                    <People companyId={c.id} />
                  </TabsContent>
                </Tabs>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </Drawer>
  );
}

function People({ companyId }: { companyId: string }) {
  const { t } = useTranslation("contacts");
  const list = useInfiniteQuery(q.contacts({ company_id: companyId }));
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  if (list.isLoading)
    return (
      <div className="flex flex-col gap-3 p-5">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    );
  if (!rows.length) return <EmptyState compact lit={2} title={t("drawer.noPeople")} description={t("drawer.noPeopleHint")} />;
  return (
    <div role="list" className="py-1">
      <PresenceList>
      {rows.map((p) => (
        <PresenceRow key={p.id}>
        <div role="listitem">
          <Link
            to="/contacts/{-$contactId}"
            params={{ contactId: p.id }}
            search={{ q: undefined, company: undefined }}
            className="flex items-center gap-2.5 border-b border-line-soft px-5 py-2.5 transition-colors hover:bg-sunken"
          >
            <Avatar name={p.name || p.email || "?"} src={p.avatar_url} size="lg" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium" data-ph-mask>
                {p.name || t("unnamed")}
              </span>
              <span className="mono block truncate text-[11.5px] text-fg-3" data-ph-mask>
                {p.email}
              </span>
            </span>
            <span className="mono text-[11px] text-fg-4">{t("ticketCount", { count: p.ticket_count })}</span>
          </Link>
        </div>
        </PresenceRow>
      ))}
      </PresenceList>
      {list.hasNextPage && (
        <div className="flex justify-center py-3">
          <Button size="xs" variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t("showMore")}
          </Button>
        </div>
      )}
    </div>
  );
}

function EditCompany({ c, onDirty, onDeleted, onDone }: { c: Company; onDirty: (d: boolean) => void; onDeleted: () => void; onDone: () => void }) {
  const { t } = useTranslation("contacts");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [name, setName] = useState(c.name);
  const [domain, setDomain] = useState(c.domain);
  const [externalId, setExternalId] = useState(c.external_id ?? "");
  const [notes, setNotes] = useState(c.notes);
  const [error, setError] = useState<string | null>(null);
  const dirty = name !== c.name || domain !== c.domain || externalId !== (c.external_id ?? "") || notes !== c.notes;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const save = useMutation({
    mutationFn: () => api.companies.update(c.id, { name: name.trim(), domain: domain.trim().toLowerCase(), external_id: externalId.trim() || null, notes }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: qk.company(c.id) });
      const snap = snapshot(qc, [qk.company(c.id), qk.companyLists]);
      patchCompany(qc, { ...c, name: name.trim(), domain: domain.trim().toLowerCase(), external_id: externalId.trim() || null, notes });
      return { snap };
    },
    onError: (e, _v, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      setError(errorMessage(e));
    },
    onSuccess: (u) => {
      patchCompany(qc, u);
      onDirty(false);
      toast.success(t("toast.companySaved"));
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.companies.remove(c.id),
    onSuccess: () => {
      dropCompany(qc, c.id);
      qc.removeQueries({ queryKey: qk.company(c.id) });
      void qc.invalidateQueries({ queryKey: qk.contactLists });
      toast.success(t("toast.companyDeleted"));
      onDeleted();
    },
  });

  return (
    <form
      className="flex flex-col gap-4 px-5 py-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return setError(t("error.companyName"));
        setError(null);
        save.mutate();
      }}
    >
      <Field label={t("field.name")}>{(p) => <TextInput {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={t("field.domain")}>{(p) => <TextInput {...p} className="mono" value={domain} onChange={(e) => setDomain(e.target.value)} />}</Field>
      <Field label={t("field.externalId")} hint={t("field.companyExternalIdHint")}>{(p) => <TextInput {...p} className="mono" value={externalId} onChange={(e) => setExternalId(e.target.value)} />}</Field>
      <Field label={t("field.notes")}>{(p) => <Textarea {...p} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
      {error && (
        <p role="alert" className="text-xs text-danger-fg">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-line-soft pt-4">
        <Button
          variant="danger"
          icon={<Trash2 className="size-3.5" />}
          onClick={() =>
            confirm.show(t("confirm.deleteCompanyBody"), () => remove.mutateAsync(), {
              title: t("confirm.deleteTitle", { name: c.name }),
              confirmLabel: t("confirm.deleteCompanyConfirm"),
              danger: true,
            })
          }
        >
          {t("drawer.delete")}
        </Button>
        <Button variant="ghost" className="ml-auto" onClick={onDone}>
          {t("cancel")}
        </Button>
        <Button variant="primary" type="submit" loading={save.isPending} disabled={!dirty}>
          {t("drawer.save")}
        </Button>
      </div>
    </form>
  );
}
