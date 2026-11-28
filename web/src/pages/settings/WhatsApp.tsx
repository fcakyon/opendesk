// WhatsApp (contracts/whatsapp.md): connect a WhatsApp Business number through Meta's Cloud
// API, check and subscribe its webhook, and pull the message templates Meta approved.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Plus, RefreshCw, Trash2, Webhook } from "lucide-react";
import { type ChangeEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Section, SettingsPage } from "@/components/layout";
import { type ItemState, IconTile, ListSkeleton, StatePill } from "@/components/settings2/bits";
import { SettingsEmpty } from "@/components/settings2/SettingsEmpty";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { CopyField } from "@/components/ui/copy-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, TextInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { WhatsAppConnection } from "@/lib/api/types";
import { relShort } from "@/lib/format";
import { q, qk, removeFromList, upsertInList } from "@/lib/queries";
import { atLeast, useRole } from "@/lib/session";

const TEMPLATE_STATUS = ["approved", "pending", "rejected"] as const;
type TemplateStatusKey = (typeof TEMPLATE_STATUS)[number];
const templateStatusKey = (status: string): TemplateStatusKey | null => {
  const key = status.toLowerCase();
  return (TEMPLATE_STATUS as readonly string[]).includes(key) ? (key as TemplateStatusKey) : null;
};
/** A template's review state as a pill: approved runs, a pending or rejected one does very little. */
const templatePill = (status: string): ItemState => {
  switch (templateStatusKey(status)) {
    case "approved":
      return "active";
    case "pending":
      return "pending";
    case "rejected":
      return "failing";
    default:
      return "disabled";
  }
};

function connectionState(c: WhatsAppConnection): { state: ItemState; key: "connected" | "error" } {
  return c.status === "error" ? { state: "failing", key: "error" } : { state: "active", key: "connected" };
}

export default function WhatsApp() {
  const { t } = useTranslation("settingsWhatsapp");
  const role = useRole();
  const admin = atLeast(role, "admin");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: connections, isLoading } = useQuery(q.whatsappConnections());
  const [connecting, setConnecting] = useState(false);
  const hasConnections = !!connections?.length;
  const { data: templates, isLoading: templatesLoading } = useQuery({ ...q.whatsappTemplates(), enabled: hasConnections });
  const rows = useMemo(() => [...(templates ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language)), [templates]);

  const test = useMutation({
    mutationFn: api.whatsapp.test,
    onSuccess: (row) => {
      upsertInList(qc, qk.whatsappConnections, row);
      if (row.status === "connected") toast.success(t("connections.tested"));
      else toast.info(t("connections.testedAttention"));
    },
    onError: (e) => toast.error(e, t("connections.testError")),
  });
  const subscribe = useMutation({
    mutationFn: api.whatsapp.subscribe,
    onSuccess: (row) => {
      upsertInList(qc, qk.whatsappConnections, row);
      toast.success(t("connections.subscribed"));
    },
    onError: (e) => toast.error(e, t("connections.subscribeError")),
  });
  const disconnect = useMutation({
    mutationFn: api.whatsapp.disconnect,
    onSuccess: (_, id) => {
      removeFromList(qc, qk.whatsappConnections, id);
      void qc.invalidateQueries({ queryKey: qk.of("whatsapp", "templates") });
      toast.success(t("connections.disconnected"));
    },
    onError: (e) => toast.error(e, t("connections.disconnectError")),
  });
  const sync = useMutation({
    mutationFn: () => api.whatsapp.syncTemplates(),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.of("whatsapp", "templates") });
      if (res.synced) toast.success(t("templates.syncedCount", { count: res.synced }));
      else toast.success(t("templates.synced"));
    },
    onError: (e) => toast.error(e, t("templates.syncError")),
  });

  const add = admin && (
    <Button variant="primary" icon={<Plus />} onClick={() => setConnecting(true)}>
      {t("add")}
    </Button>
  );

  return (
    <SettingsPage wide title={t("title")} description={t("description")} actions={hasConnections ? add : undefined}>
      <Section flush title={t("connections.title")} description={t("connections.description")}>
        {isLoading ? (
          <ListSkeleton rows={2} />
        ) : !hasConnections ? (
          <SettingsEmpty
            art="settings"
            title={t("connections.emptyTitle")}
            description={t("connections.emptyBody")}
            action={add}
            tips={[
              { label: t("connections.tipChat"), icon: <MessageCircle /> },
              { label: t("connections.tipWindow"), icon: <RefreshCw /> },
              { label: t("connections.tipTemplates"), icon: <Webhook /> },
            ]}
            className="min-h-[260px]"
          />
        ) : (
          <div className="divide-y divide-line-soft">
            {connections.map((c) => {
              const state = connectionState(c);
              return (
                <div key={c.id} className="px-4 py-3.5" data-testid="whatsapp-connection">
                  <div className="flex items-start gap-3">
                    <IconTile tone="green">
                      <MessageCircle />
                    </IconTile>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium">{c.name}</span>
                        {c.display_phone_number && <span className="mono text-[12px] text-fg-2">{c.display_phone_number}</span>}
                        <StatePill state={state.state}>{t(`connections.status.${state.key}`)}</StatePill>
                      </div>
                      {c.last_error && <p className="mt-1 text-[12px] leading-[18px] text-danger-fg">{c.last_error}</p>}
                      <p className="mt-0.5 text-[12px] text-fg-3">
                        {c.verified_name && c.verified_name !== c.name ? `${t("connections.verifiedName", { name: c.verified_name })} · ` : ""}
                        {c.last_event_at ? t("connections.lastEvent", { when: relShort(c.last_event_at) }) : t("connections.noEventYet")}
                      </p>
                      {admin && c.webhook_url && (
                        <div className="mt-2 max-w-[560px]">
                          <p className="mb-1 text-[11.5px] text-fg-4">{t("connections.webhook")}</p>
                          <CopyField value={c.webhook_url} />
                        </div>
                      )}
                    </div>
                    {admin && (
                      <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                        <Button icon={<RefreshCw />} loading={test.isPending && test.variables === c.id} onClick={() => test.mutate(c.id)}>
                          {t("connections.test")}
                        </Button>
                        <Button
                          square
                          icon={<Webhook />}
                          aria-label={t("connections.subscribeLabel", { name: c.name })}
                          loading={subscribe.isPending && subscribe.variables === c.id}
                          onClick={() => subscribe.mutate(c.id)}
                        />
                        <Button
                          variant="danger"
                          square
                          icon={<Trash2 />}
                          aria-label={t("connections.disconnectLabel", { name: c.name })}
                          onClick={() => confirm.show(t("connections.disconnectBody", { name: c.name }), () => disconnect.mutateAsync(c.id), { title: t("connections.disconnectTitle"), confirmLabel: t("connections.disconnect"), danger: true })}
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {hasConnections && (
        <Section
          flush
          title={t("templates.title")}
          description={t("templates.description")}
          actions={
            admin && (
              <Button icon={<RefreshCw />} loading={sync.isPending} onClick={() => sync.mutate()}>
                {t("templates.sync")}
              </Button>
            )
          }
        >
          {templatesLoading ? (
            <ListSkeleton rows={3} />
          ) : !rows.length ? (
            <SettingsEmpty
              art="settings"
              ghost={false}
              title={t("templates.emptyTitle")}
              description={t("templates.emptyBody")}
              className="min-h-[220px]"
            />
          ) : (
            <div>
              <div className="flex items-center gap-3 border-b border-line-soft px-4 py-1.5 text-[11px] font-medium text-fg-4">
                <span className="min-w-0 flex-1">{t("templates.name")}</span>
                <span className="w-16 shrink-0">{t("templates.language")}</span>
                <span className="hidden w-24 shrink-0 sm:block">{t("templates.category")}</span>
                <span className="w-[86px] shrink-0">{t("templates.status")}</span>
              </div>
              <div className="divide-y divide-line-soft">
                {rows.map((x) => {
                  const status = templateStatusKey(x.status);
                  return (
                    <div key={x.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="min-w-0 flex-1 truncate text-[13px]">{x.name}</span>
                      <span className="mono w-16 shrink-0 truncate text-[11.5px] text-fg-3">{x.language}</span>
                      <span className="hidden w-24 shrink-0 truncate text-[11.5px] text-fg-3 sm:block">{x.category}</span>
                      <span className="w-[86px] shrink-0">
                        <StatePill state={templatePill(x.status)}>{status ? t(`templates.statusLabel.${status}`) : x.status}</StatePill>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Section>
      )}

      {connecting && <ConnectDialog onClose={() => setConnecting(false)} />}
    </SettingsPage>
  );
}

/** Connect a number with the credentials an admin copies from the Meta app. */
function ConnectDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("settingsWhatsapp");
  const qc = useQueryClient();
  const { data: brands } = useQuery(q.brands());
  const [name, setName] = useState("");
  const [brandId, setBrandId] = useState("");
  const [apiVersion, setApiVersion] = useState("");
  const [credentials, setCredentials] = useState({ phone_number_id: "", waba_id: "", access_token: "", app_secret: "", verify_token: "" });
  const [error, setError] = useState("");
  // "Default brand" is the empty value: the number joins the workspace's default brand.
  const brandOptions = [{ value: "", label: t("connect.defaultBrand") }, ...(brands ?? []).map((b) => ({ value: b.id, label: b.name }))];
  const save = useMutation({
    mutationFn: () =>
      api.whatsapp.connect({
        name: name.trim() || undefined,
        brand_id: brandId || undefined,
        credentials: {
          ...credentials,
          verify_token: credentials.verify_token.trim() || undefined,
          api_version: apiVersion.trim() || undefined,
        },
      }),
    onSuccess: (row) => {
      upsertInList(qc, qk.whatsappConnections, row);
      toast.success(t("connect.connected", { name: row.name }));
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t("connect.error"))),
  });
  const valid = [credentials.phone_number_id, credentials.waba_id, credentials.access_token, credentials.app_secret].every((v) => v.trim());
  const set = (key: keyof typeof credentials) => (e: ChangeEvent<HTMLInputElement>) => setCredentials((old) => ({ ...old, [key]: e.target.value }));
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("connect.title")}
      description={t("connect.description")}
      footer={
        <>
          <Button onClick={onClose}>{t("connect.cancel")}</Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {t("connect.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("connect.name")} hint={t("connect.nameHint")}>
          {(props) => <TextInput {...props} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label={t("connect.brand")} hint={t("connect.brandHint")} optional>
          {({ id }) => <Select id={id} value={brandId} onChange={setBrandId} options={brandOptions} placeholder={t("connect.defaultBrand")} />}
        </Field>
        <Field label={t("connect.phoneNumberId")}>
          {(props) => <TextInput {...props} autoComplete="off" spellCheck={false} className="mono" value={credentials.phone_number_id} onChange={set("phone_number_id")} />}
        </Field>
        <Field label={t("connect.wabaId")}>
          {(props) => <TextInput {...props} autoComplete="off" spellCheck={false} className="mono" value={credentials.waba_id} onChange={set("waba_id")} />}
        </Field>
        <Field label={t("connect.accessToken")} hint={t("connect.accessTokenHint")}>
          {(props) => (
            <TextInput {...props} type="password" autoComplete="new-password" spellCheck={false} className="mono" value={credentials.access_token} onChange={set("access_token")} />
          )}
        </Field>
        <Field label={t("connect.appSecret")} hint={t("connect.appSecretHint")}>
          {(props) => (
            <TextInput {...props} type="password" autoComplete="new-password" spellCheck={false} className="mono" value={credentials.app_secret} onChange={set("app_secret")} />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("connect.verifyToken")} hint={t("connect.verifyTokenHint")} optional>
            {(props) => <TextInput {...props} autoComplete="off" spellCheck={false} className="mono" value={credentials.verify_token} onChange={set("verify_token")} />}
          </Field>
          <Field label={t("connect.apiVersion")} hint={t("connect.apiVersionHint")} optional>
            {(props) => <TextInput {...props} autoComplete="off" spellCheck={false} className="mono" placeholder="v26.0" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} />}
          </Field>
        </div>
        {error && <p className="text-[12px] text-danger-fg">{error}</p>}
      </div>
    </Dialog>
  );
}
