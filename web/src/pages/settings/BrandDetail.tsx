// Settings > Brands > a brand (contracts/teams.md): overview (name, colour,
// language, logo, default), its addresses, its chat widgets and its help
// center. Name, colour, language, slug and help center settings save
// together from the save bar; pictures upload straight away.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, BookOpen, ChevronRight, ExternalLink, Inbox, LayoutDashboard, MessageCircle, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackLink, NoAccess, Row, Section, SettingsPage } from "@/components/layout";
import { SaveBar } from "@/components/settings/SaveBar";
import { StatePill } from "@/components/settings2/bits";
import { HelpDomainSection } from "@/components/settings2/helpDomain";
import { PortalSignInSection } from "@/components/settings2/portalSignIn";
import { MotionList, MotionRow } from "@/components/settings2/motion";
import { SettingsEmpty } from "@/components/settings2/SettingsEmpty";
import { BrandMark, Note, TeamChip, TeamPick, useTeams } from "@/components/settings2/teams";
import { UnsavedGuard } from "@/components/settings2/UnsavedGuard";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty";
import { Field, TextInput } from "@/components/ui/input";
import { ImageUpload } from "@/components/ui/image-upload";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { ColorField } from "@/components/widget/fields";
import { MailboxIcon } from "@/components/mailboxes/kinds";
import { LOCALE_NAMES, SUPPORTED } from "@/i18n";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/client";
import type { Brand } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { relLong } from "@/lib/format";
import { bareUrl, helpAddressForm, withSlug } from "@/lib/helpCenter";
import { q, qk, removeFromList, upsertInList } from "@/lib/queries";
import { atLeast, useRole, useWorkspace } from "@/lib/session";
import { tone } from "@/lib/tones";
import { SLUG } from "./Brands";
import { WIDGET_SECRET_ANCHOR, WidgetSecretDialog, WidgetSecretLaterDialog } from "./WidgetDetail";
import { sameJSON } from "@/lib/sameJSON";

export type BrandTab = "overview" | "addresses" | "widgets" | "help";

type Draft = { name: string; color: string; locale: string; slug: string; help_center: { enabled: boolean; title: string } };
const toDraft = (b: Brand): Draft => ({ name: b.name, color: b.color, locale: b.locale, slug: b.slug, help_center: { enabled: b.help_center.enabled, title: b.help_center.title } });

export default function BrandDetail() {
  const { t } = useTranslation("settingsTeams");
  const { brandId } = useParams({ from: "/app/settings/brands/$brandId" });
  const admin = atLeast(useRole(), "admin");
  const { data, isLoading } = useQuery({ ...q.brands(), enabled: admin });
  const brand = data?.find((b) => b.id === brandId);
  const back = <BackLink to="/settings/brands">{t("brands.back")}</BackLink>;

  if (!admin)
    return (
      <SettingsPage title={t("brands.title")} back={back}>
        <NoAccess what="brands" />
      </SettingsPage>
    );
  if (isLoading)
    return (
      <SettingsPage title={<Skeleton className="h-5 w-40" />} back={back}>
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-60 w-full rounded-lg" />
      </SettingsPage>
    );
  if (!brand)
    return (
      <SettingsPage title={t("brands.title")} back={back}>
        <Section flush>
          <EmptyState
            lit={3}
            title={t("brands.notFound")}
            description={t("brands.notFoundBody")}
            action={
              <Button size="sm" asChild>
                <Link to="/settings/brands">{t("brands.backToList")}</Link>
              </Button>
            }
          />
        </Section>
      </SettingsPage>
    );
  return <BrandEditor key={brand.id} brand={brand} brands={data ?? []} />;
}

function BrandEditor({ brand, brands }: { brand: Brand; brands: Brand[] }) {
  const { t } = useTranslation("settingsTeams");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { tab = "overview" } = useSearch({ from: "/app/settings/brands/$brandId" });
  const { data: mailboxes } = useQuery(q.mailboxes());
  const { data: widgets } = useQuery(q.widgets());
  const base = useMemo(() => toDraft(brand), [brand]);
  const [draft, setDraft] = useState<Draft>(base);
  const [prevBase, setPrevBase] = useState(base);
  useEffect(() => {
    if (sameJSON(draft, prevBase)) setDraft(base);
    setPrevBase(base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  const dirty = !sameJSON(draft, base);
  const slugBad = !SLUG.test(draft.slug);
  const addresses = (mailboxes ?? []).filter((m) => m.brand_id === brand.id);
  const brandWidgets = (widgets ?? []).filter((w) => w.brand_id === brand.id).sort((a, b) => a.position - b.position);

  const save = useMutation({
    mutationFn: () =>
      api.brands.update(brand.id, {
        ...(draft.name !== base.name ? { name: draft.name.trim() } : {}),
        ...(draft.color !== base.color ? { color: draft.color } : {}),
        ...(draft.locale !== base.locale ? { locale: draft.locale } : {}),
        ...(draft.slug !== base.slug ? { slug: draft.slug } : {}),
        ...(!sameJSON(draft.help_center, base.help_center) ? { help_center: { ...draft.help_center, title: draft.help_center.title.trim() } } : {}),
      }),
    onSuccess: (b) => {
      upsertInList(qc, qk.brands, b);
      setDraft(toDraft(b));
      toast.success(t("brands.saved"));
    },
    onError: (e) => toast.error(e, t("brands.saveFailed")),
  });

  const makeDefault = () =>
    confirm.show(t("brands.makeDefaultBody", { name: brand.name }), async () => {
      await api.brands.makeDefault(brand.id);
      await qc.invalidateQueries({ queryKey: qk.brands });
      void qc.invalidateQueries({ queryKey: qk.widgetSettings });
      void qc.invalidateQueries({ queryKey: qk.workspace });
      toast.success(t("brands.nowDefault", { name: brand.name }));
    }, { title: t("brands.makeDefaultTitle", { name: brand.name }), confirmLabel: t("brands.makeDefault") });

  const remove = () =>
    confirm.show(
      t("brands.deleteBody", { name: brand.name, count: brandWidgets.length }),
      async () => {
        await api.brands.remove(brand.id);
        removeFromList(qc, qk.brands, brand.id);
        void qc.invalidateQueries({ queryKey: qk.widgets });
        toast.success(t("brands.deleted", { name: brand.name }));
        void navigate({ to: "/settings/brands" });
      },
      { title: t("brands.deleteTitle", { name: brand.name }), confirmLabel: t("brands.delete"), danger: true, typeToConfirm: brand.name },
    );

  const setTab = (v: string) => void navigate({ to: "/settings/brands/$brandId", params: { brandId: brand.id }, search: { tab: v === "overview" ? undefined : (v as BrandTab) }, replace: true });

  return (
    <SettingsPage
      back={<BackLink to="/settings/brands">{t("brands.back")}</BackLink>}
      title={
        <span className="flex items-center gap-3">
          <BrandMark brand={{ ...brand, color: draft.color }} size="md" />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate">{brand.name}</span>
              {brand.is_default && <span className={cn("inline-flex h-[19px] items-center rounded-sm px-1.5 text-[10.5px] font-medium tracking-normal", tone.blue.chip)}>{t("brands.default")}</span>}
            </span>
            <span className="mono block truncate text-[12px] font-normal tracking-normal text-fg-3">{bareUrl(brand.help_center.url)}</span>
          </span>
        </span>
      }
    >
      <UnsavedGuard when={dirty && !save.isPending} allow={(p) => p.startsWith(`/settings/brands/${brand.id}`) && !p.includes("/widgets/")} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="-mt-3 mb-6">
          <TabsTrigger value="overview" icon={<LayoutDashboard />}>
            {t("brands.tabs.overview")}
          </TabsTrigger>
          <TabsTrigger value="addresses" icon={<Inbox />} count={addresses.length}>
            {t("brands.tabs.addresses")}
          </TabsTrigger>
          <TabsTrigger value="widgets" icon={<MessageCircle />} count={brandWidgets.length}>
            {t("brands.tabs.widgets")}
          </TabsTrigger>
          <TabsTrigger value="help" icon={<BookOpen />}>
            {t("brands.tabs.help")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-9 outline-none">
          <Overview brand={brand} draft={draft} setDraft={setDraft} />
          <Section title={t("brands.manage")} danger={!brand.is_default}>
            <Row label={brand.is_default ? t("brands.isDefault") : t("brands.makeDefaultTitle", { name: brand.name })} description={brand.is_default ? t("brands.isDefaultHint") : t("brands.makeDefaultHint")}>
              {!brand.is_default && (
                <Button icon={<Star className="size-3.5" />} onClick={makeDefault}>
                  {t("brands.makeDefault")}
                </Button>
              )}
            </Row>
            {!brand.is_default && (
              <Row label={t("brands.deleteTitle", { name: brand.name })} description={addresses.length ? t("brands.deleteBlocked", { count: addresses.length }) : t("brands.deleteHint")}>
                <Button variant="danger" icon={<Trash2 className="size-3.5" />} disabled={addresses.length > 0} onClick={remove}>
                  {t("brands.delete")}
                </Button>
              </Row>
            )}
          </Section>
        </TabsContent>

        <TabsContent value="addresses" className="outline-none">
          <Addresses brand={brand} />
        </TabsContent>

        <TabsContent value="widgets" className="outline-none">
          <Widgets brand={brand} />
        </TabsContent>

        <TabsContent value="help" className="flex flex-col gap-9 outline-none">
          <HelpCenter brand={brand} draft={draft} setDraft={setDraft} base={base} />
        </TabsContent>
      </Tabs>
      {brands.length < 2 && tab === "overview" && <Note className="-mt-4">{t("brands.singleNote")}</Note>}
      <SaveBar dirty={dirty} saving={save.isPending} disabled={!draft.name.trim() || slugBad || (draft.help_center.title.trim().length > 60)} onSave={() => save.mutate()} onDiscard={() => setDraft(base)} />
    </SettingsPage>
  );
}

function Overview({ brand, draft, setDraft }: { brand: Brand; draft: Draft; setDraft: (f: (d: Draft) => Draft) => void }) {
  const { t } = useTranslation("settingsTeams");
  const ws = useWorkspace();
  return (
    <Section title={t("brands.overview")} description={t("brands.overviewHint")}>
      <Row label={t("brands.name")} htmlFor="brand-name">
        <TextInput id="brand-name" className="w-[280px]" maxLength={60} invalid={!draft.name.trim()} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
      </Row>
      <Row label={t("brands.color")} description={t("brands.colorHint")} stack>
        <ColorField value={draft.color} onChange={(color) => setDraft((d) => ({ ...d, color }))} brand={ws?.settings.brand_color} />
      </Row>
      <Row label={t("brands.locale")} description={t("brands.localeHint")}>
        <Select
          className="w-[220px]"
          aria-label={t("brands.locale")}
          value={draft.locale || "__ws"}
          onChange={(v) => setDraft((d) => ({ ...d, locale: v === "__ws" ? "" : v }))}
          options={[{ value: "__ws", label: t("brands.localeWorkspace") }, ...SUPPORTED.map((l) => ({ value: l as string, label: LOCALE_NAMES[l] }))]}
        />
      </Row>
      <BrandImageRow brand={brand} slot="logo" label={t("brands.logo")} hint={t("brands.logoHint")} />
    </Section>
  );
}

function BrandImageRow({
  brand,
  slot,
  label,
  hint,
  fallback,
  fallbackHint,
}: {
  brand: Brand;
  slot: "logo" | "help_center_logo" | "help_center_favicon";
  label: string;
  hint: string;
  /** What is shown while the slot is empty (the help center logo falls back to the brand logo). */
  fallback?: string | null;
  fallbackHint?: string;
}) {
  const qc = useQueryClient();
  const src = brand.images[slot];
  const usesFallback = !src && !!fallback;
  return (
    <Row label={label} description={usesFallback && fallbackHint ? `${hint} ${fallbackHint}` : hint}>
      <ImageUpload
        name={brand.name}
        shape="square"
        size="md"
        placeholder={usesFallback ? <img src={fallback} alt="" className="size-full object-cover opacity-60" /> : undefined}
        value={src}
        onChange={async (f) => {
          upsertInList(qc, qk.brands, await api.brands.uploadImage(brand.id, slot, f));
        }}
        onRemove={
          src
            ? async () => {
                try {
                  upsertInList(qc, qk.brands, await api.brands.removeImage(brand.id, slot));
                } catch (e) {
                  toast.error(e);
                }
              }
            : undefined
        }
      />
    </Row>
  );
}

function Addresses({ brand }: { brand: Brand }) {
  const { t } = useTranslation("settingsTeams");
  const { data: mailboxes, isLoading } = useQuery(q.mailboxes());
  const { teams } = useTeams();
  const list = (mailboxes ?? []).filter((m) => m.brand_id === brand.id);
  const add = (
    <Button variant="primary" size="sm" asChild icon={<Plus className="size-3.5" />}>
      <Link to="/settings/mailboxes/new" search={{ brand: brand.id }}>
        {t("brands.addAddress")}
      </Link>
    </Button>
  );
  return (
    <Section flush title={t("brands.addressesTitle")} description={t("brands.addressesHint", { name: brand.name })} actions={list.length > 0 && add}>
      {isLoading ? (
        <div className="p-4">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !list.length ? (
        <SettingsEmpty
          art="inbox"
          title={t("brands.addressesEmpty")}
          description={t("brands.addressesEmptyHint", { name: brand.name })}
          action={add}
          tips={[{ label: t("brands.addressesTip"), icon: <Inbox /> }]}
        />
      ) : (
        <MotionList>
          {list.map((m) => {
            const team = teams.find((x) => x.id === m.team_id);
            return (
              <MotionRow key={m.id}>
                <Link
                  to="/settings/mailboxes/$mailboxId"
                  params={{ mailboxId: m.id }}
                  className="group flex min-h-12 items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0 hover:bg-sunken"
                >
                  <MailboxIcon kind={m.inbound_kind} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="mono truncate text-[12.5px] font-medium">{m.email}</span>
                      {brand.default_mailbox_id === m.id && <span className="text-[11px] text-fg-4">{t("brands.defaultAddress")}</span>}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-fg-3">
                      {m.aliases.length ? t("brands.aliasList", { list: m.aliases.join(", ") }) : m.name}
                    </div>
                  </div>
                  {team ? <TeamChip team={team} /> : <span className="text-[12px] text-fg-4">{t("brands.noTeam")}</span>}
                  <ChevronRight className="size-4 text-fg-4" aria-hidden />
                </Link>
              </MotionRow>
            );
          })}
        </MotionList>
      )}
    </Section>
  );
}

function Widgets({ brand }: { brand: Brand }) {
  const { t } = useTranslation("settingsTeams");
  const { data: widgets, isLoading } = useQuery(q.widgets());
  const { teams } = useTeams();
  const [creating, setCreating] = useState(false);
  const list = (widgets ?? []).filter((w) => w.brand_id === brand.id).sort((a, b) => a.position - b.position);
  const add = (variant: "primary" | "secondary") => (
    <Button variant={variant} size={variant === "secondary" ? "sm" : undefined} icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
      {t("brands.addWidget")}
    </Button>
  );
  return (
    <Section flush title={t("brands.widgetsTitle")} description={t("brands.widgetsHint")} actions={list.length > 0 && add("secondary")}>
      {isLoading ? (
        <div className="p-4">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !list.length ? (
        <SettingsEmpty
          art="generic"
          title={t("brands.widgetsEmpty")}
          description={t("brands.widgetsEmptyHint")}
          action={add("primary")}
          tips={[{ label: t("brands.widgetsTip"), icon: <MessageCircle /> }]}
        />
      ) : (
        <MotionList>
          {list.map((w) => {
            const team = teams.find((x) => x.id === w.team_id);
            return (
              <MotionRow key={w.id}>
                <Link
                  to="/settings/brands/$brandId/widgets/$widgetId"
                  params={{ brandId: brand.id, widgetId: w.id }}
                  className="group flex min-h-14 items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0 hover:bg-sunken"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full text-white" style={{ background: w.settings.color || brand.color || "var(--fg)" }}>
                    <MessageCircle className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{w.name}</div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-fg-3">
                      <span className="mono truncate text-[11.5px]">{w.settings.allowed_origins[0] ?? t("brands.anySite")}</span>
                      {w.settings.topics.length > 0 && <span className="shrink-0 text-fg-4">· {t("brands.topicCount", { count: w.settings.topics.length })}</span>}
                    </div>
                  </div>
                  {team && <TeamChip team={team} />}
                  {w.seen_at ? (
                    <StatePill state={w.settings.enabled ? "active" : "disabled"}>{w.settings.enabled ? t("brands.widgetLive") : t("brands.widgetHidden")}</StatePill>
                  ) : (
                    <StatePill state="pending">{t("widget.notInstalled")}</StatePill>
                  )}
                  <ChevronRight className="size-4 text-fg-4" aria-hidden />
                </Link>
              </MotionRow>
            );
          })}
        </MotionList>
      )}
      {creating && <NewWidgetDialog brand={brand} onClose={() => setCreating(false)} />}
    </Section>
  );
}

function NewWidgetDialog({ brand, onClose }: { brand: Brand; onClose: () => void }) {
  const { t } = useTranslation("settingsTeams");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; secret: string | null } | null>(null);

  const create = useMutation({
    mutationFn: () => api.widgets.create({ brand_id: brand.id, name: name.trim(), team_id: teamId }),
    onSuccess: ({ secret, secret_available, ...w }) => {
      upsertInList(qc, qk.widgets, w);
      void qc.invalidateQueries({ queryKey: qk.brands });
      // Without the owner-level gate the answer carries no secret: rotate to see one.
      setCreated({ id: w.id, secret: secret_available && secret ? secret : null });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const openWidget = (id: string, hash?: string) => {
    onClose();
    void navigate({ to: "/settings/brands/$brandId/widgets/$widgetId", params: { brandId: brand.id, widgetId: id }, hash });
  };

  if (created && !created.secret)
    return (
      <WidgetSecretLaterDialog
        title={t("brands.widgetCreated", { name: name.trim() })}
        onClose={() => openWidget(created.id)}
        onReveal={() => openWidget(created.id, WIDGET_SECRET_ANCHOR)}
      />
    );
  if (created)
    return (
      <WidgetSecretDialog
        secret={created.secret}
        title={t("brands.widgetCreated", { name: name.trim() })}
        description={t("brands.widgetSecretHint")}
        onClose={() => openWidget(created.id)}
      />
    );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("brands.addWidget")}
      description={t("brands.addWidgetHint", { name: brand.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form="new-widget" loading={create.isPending}>
            {t("brands.createWidget")}
          </Button>
        </>
      }
    >
      <form
        id="new-widget"
        className="flex flex-col gap-4 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return setError(t("widget.nameRequired"));
          create.mutate();
        }}
      >
        <Field label={t("widget.name")} hint={t("widget.nameHint")} error={error}>
          {({ id, invalid }) => <TextInput id={id} autoFocus invalid={invalid} value={name} maxLength={60} placeholder={t("widget.namePlaceholder")} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label={t("widget.team")} hint={t("widget.teamHint")}>
          {() => <TeamPick className="w-full" size="md" value={teamId} noneLabel={t("widget.noTeam")} onChange={setTeamId} />}
        </Field>
      </form>
    </Dialog>
  );
}

function HelpCenter({ brand, draft, setDraft, base }: { brand: Brand; draft: Draft; setDraft: (f: (d: Draft) => Draft) => void; base: Draft }) {
  const { t } = useTranslation("settingsTeams");
  const ws = useWorkspace();
  const slugChanged = draft.slug !== base.slug;
  const slugBad = !SLUG.test(draft.slug);
  const form = helpAddressForm(brand);
  const onDomain = brand.help_center.domain?.status === "active";
  return (
    <>
      <Section title={t("help.title")} description={t("help.hint", { name: brand.name })}>
        <Row label={t("help.enabled")} description={draft.help_center.enabled ? t("help.enabledOn") : t("help.enabledOff")}>
          <Switch aria-label={t("help.enabled")} checked={draft.help_center.enabled} onCheckedChange={(enabled) => setDraft((d) => ({ ...d, help_center: { ...d.help_center, enabled } }))} />
        </Row>
        <Row label={t("help.pageTitle")} description={t("help.pageTitleHint")} htmlFor="hc-title">
          <TextInput
            id="hc-title"
            className="w-[280px]"
            maxLength={70}
            value={draft.help_center.title}
            invalid={draft.help_center.title.trim().length > 60}
            placeholder={t("help.pageTitlePlaceholder", { name: brand.name })}
            onChange={(e) => setDraft((d) => ({ ...d, help_center: { ...d.help_center, title: e.target.value } }))}
          />
        </Row>
        <Row label={t("help.url")} description={!brand.help_center.enabled ? t("help.urlOff") : onDomain ? t("help.urlHintDomain") : t("help.urlHint")}>
          {brand.help_center.enabled ? (
            <a
              href={brand.help_center.url}
              target="_blank"
              rel="noreferrer"
              aria-label={t("help.open")}
              className="mono group inline-flex max-w-[300px] items-center gap-1 rounded-sm text-[12px] text-fg-2 hover:text-fg"
            >
              <span className="truncate">{bareUrl(brand.help_center.url)}</span>
              <ExternalLink className="size-3 shrink-0 text-fg-3 group-hover:text-fg" aria-hidden />
            </a>
          ) : (
            <span className="mono max-w-[300px] truncate text-[12px] text-fg-4">{bareUrl(brand.help_center.url)}</span>
          )}
          <CopyButton value={brand.help_center.url} label={t("help.copy")} />
        </Row>
        <Row label={t("help.slug")} description={t("help.slugHint")} stack>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-0">
              {form.kind === "path" && <span className="mono flex h-8 items-center rounded-l-md border border-r-0 border-line bg-sunken px-2.5 text-[12px] text-fg-3">{form.prefix}</span>}
              <TextInput
                className={cn("mono w-[220px]", form.kind === "path" ? "rounded-l-none" : "rounded-r-none")}
                aria-label={t("help.slug")}
                value={draft.slug}
                maxLength={40}
                invalid={slugBad}
                onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value.toLowerCase() }))}
              />
              {form.kind === "subdomain" && <span className="mono flex h-8 items-center rounded-r-md border border-l-0 border-line bg-sunken px-2.5 text-[12px] text-fg-3">.{form.suffix}</span>}
            </div>
            {slugBad && (
              <p role="alert" className="text-[12px] text-danger-fg">
                {t("brands.slugInvalid")}
              </p>
            )}
            {slugChanged && !slugBad && (
              <Note tone="amber" icon={<AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />}>
                {onDomain
                  ? t("help.slugWarningDomain", { old: bareUrl(brand.help_center.default_url), url: bareUrl(withSlug(brand, draft.slug)), domain: brand.help_center.domain!.hostname })
                  : t("help.slugWarning", { old: bareUrl(brand.help_center.default_url), url: bareUrl(withSlug(brand, draft.slug)) })}
              </Note>
            )}
          </div>
        </Row>
      </Section>
      <HelpDomainSection brand={brand} />
      <PortalSignInSection brand={brand} />
      <Section title={t("help.look")} description={t("help.lookHint")}>
        <BrandImageRow
          brand={brand}
          slot="help_center_logo"
          label={t("help.logo")}
          hint={t("help.logoHint")}
          fallback={brand.images.logo || ws?.avatar_url}
          fallbackHint={brand.images.logo ? t("help.logoUsesBrand") : t("help.logoUsesWorkspace")}
        />
        <BrandImageRow brand={brand} slot="help_center_favicon" label={t("help.favicon")} hint={t("help.faviconHint")} />
        <Row label={t("help.articles")} description={t("help.articlesHint")}>
          <Button size="sm" variant="ghost" asChild iconRight={<ArrowRight className="size-3.5" />}>
            <Link to="/kb" search={{ brand: brand.id }}>
              {t("help.openKb")}
            </Link>
          </Button>
        </Row>
      </Section>
      <p className="-mt-5 text-[12px] text-fg-4">{t("help.updated", { when: relLong(brand.updated_at) })}</p>
    </>
  );
}
