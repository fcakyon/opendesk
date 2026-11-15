// A brand's customer portal sign-in (contracts/customer-portal.md "Provider sign-in"):
// a password, the company's own OIDC identity provider, or either. The provider is checked
// when the settings are saved, so they save on their own button, not with the brand's bar.
// A customer whose provider account changed can be allowed one new link, for 15 minutes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Row, Section } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { TextInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/client";
import type { Brand, PortalAuthMode, PortalAuthSettings } from "@/lib/api/types";
import { config } from "@/lib/config";
import { qk, upsertInList } from "@/lib/queries";

type Draft = { mode: PortalAuthMode; issuer: string; clientId: string; secret: string; create: boolean };

const toDraft = (s: PortalAuthSettings): Draft => ({ mode: s.mode, issuer: s.issuer, clientId: s.client_id, secret: "", create: s.create_contacts });

/** Where the provider sends the customer back to: the API's callback for this brand. */
export const portalCallbackUrl = (slug: string) => `${config.apiUrl}/v1/public/help/${encodeURIComponent(slug)}/portal/sso/callback`;

export function PortalSignInSection({ brand }: { brand: Brand }) {
  const { t } = useTranslation("settingsTeams");
  const { data } = useQuery({ queryKey: qk.brandPortalAuth(brand.id), queryFn: () => api.brands.portalAuth(brand.id) });
  return (
    <Section title={t("portalAuth.title")} description={t("portalAuth.hint", { name: brand.name })}>
      {data ? <Form key={`${data.mode}:${data.issuer}:${data.client_id}:${data.create_contacts}`} brand={brand} saved={data} /> : null}
      {data && data.mode !== "local" && <RelinkRow brand={brand} />}
    </Section>
  );
}

function Form({ brand, saved }: { brand: Brand; saved: PortalAuthSettings }) {
  const { t } = useTranslation("settingsTeams");
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(toDraft(saved));
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => {
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const provider = draft.mode !== "local";
  const base = toDraft(saved);
  const dirty = draft.mode !== base.mode || (provider && (draft.issuer !== base.issuer || draft.clientId !== base.clientId || draft.secret !== "" || draft.create !== base.create));
  const needsSecret = provider && !saved.secret_configured && !draft.secret.trim();
  const ready = !provider || (/^https:\/\/\S+$/.test(draft.issuer.trim()) && !!draft.clientId.trim() && !needsSecret);

  const save = useMutation({
    mutationFn: () =>
      api.brands.update(brand.id, {
        portal_auth: provider
          ? {
              mode: draft.mode,
              issuer: draft.issuer.trim(),
              client_id: draft.clientId.trim(),
              ...(draft.secret.trim() ? { client_secret: draft.secret } : {}),
              create_contacts: draft.create,
            }
          : { mode: "local" },
      }),
    onSuccess: (b) => {
      upsertInList(qc, qk.brands, b);
      void qc.invalidateQueries({ queryKey: qk.brandPortalAuth(brand.id) });
      toast.success(t("portalAuth.saved"));
    },
    onError: (e) => {
      if (isApiError(e, "invalid_oidc_config")) return setError(t("portalAuth.invalid"));
      if (isApiError(e, "oidc_secret_required")) return setError(t("portalAuth.secretRequired"));
      toast.error(e, t("portalAuth.saveFailed"));
    },
  });

  return (
    <>
      <Row label={t("portalAuth.mode")} description={t("portalAuth.modeHint")}>
        <Select
          className="w-[280px]"
          aria-label={t("portalAuth.mode")}
          value={draft.mode}
          onChange={(mode) => set({ mode })}
          options={(["local", "local_and_oidc", "oidc"] as const).map((m) => ({ value: m, label: t(`portalAuth.modes.${m}`) }))}
        />
      </Row>
      {provider && (
        <>
          <Row label={t("portalAuth.issuer")} description={t("portalAuth.issuerHint")} htmlFor="portal-issuer">
            <TextInput id="portal-issuer" className="mono w-[320px]" spellCheck={false} placeholder="https://login.acme.com" value={draft.issuer} onChange={(e) => set({ issuer: e.target.value })} />
          </Row>
          <Row label={t("portalAuth.clientId")} htmlFor="portal-client-id">
            <TextInput id="portal-client-id" className="mono w-[320px]" spellCheck={false} autoComplete="off" value={draft.clientId} onChange={(e) => set({ clientId: e.target.value })} />
          </Row>
          <Row label={t("portalAuth.secret")} description={t("portalAuth.secretHint")} htmlFor="portal-secret">
            <TextInput
              id="portal-secret"
              className="mono w-[320px]"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={saved.secret_configured ? t("portalAuth.secretSaved") : ""}
              value={draft.secret}
              onChange={(e) => set({ secret: e.target.value })}
            />
          </Row>
          <Row label={t("portalAuth.callback")} description={t("portalAuth.callbackHint")}>
            <span className="mono max-w-[300px] truncate text-[12px] text-fg-2">{portalCallbackUrl(brand.slug)}</span>
            <CopyButton value={portalCallbackUrl(brand.slug)} label={t("portalAuth.copy")} />
          </Row>
          <Row label={t("portalAuth.create")} description={draft.create ? t("portalAuth.createOn") : t("portalAuth.createOff")}>
            <Switch aria-label={t("portalAuth.create")} checked={draft.create} onCheckedChange={(create) => set({ create })} />
          </Row>
        </>
      )}
      <Row label={error ? <span className="text-danger-fg">{error}</span> : ""} className="justify-end">
        <Button variant="primary" loading={save.isPending} disabled={!dirty || !ready || save.isPending} onClick={() => save.mutate()}>
          {t("portalAuth.save")}
        </Button>
      </Row>
    </>
  );
}

/** Allows one contact's next provider sign-in to replace their old link. */
function RelinkRow({ brand }: { brand: Brand }) {
  const { t } = useTranslation("settingsTeams");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const allow = useMutation({
    mutationFn: async () => {
      const wanted = email.trim().toLowerCase();
      const found = await api.contacts.search({ q: wanted, limit: 20 });
      const contact = found.data.find((c) => c.email?.toLowerCase() === wanted);
      if (!contact) throw new Error("no_contact");
      return api.brands.authorizeRelink(brand.id, contact.id);
    },
    onSuccess: () => {
      toast.success(t("portalAuth.relinkDone", { email: email.trim() }));
      setEmail("");
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "no_contact") return setError(t("portalAuth.relinkNone"));
      if (isApiError(e, "reauth_required")) return setError(t("portalAuth.relinkReauth"));
      setError(errorMessage(e, t("portalAuth.relinkFailed")));
    },
  });
  return (
    <Row label={t("portalAuth.relink")} description={error ?? t("portalAuth.relinkHint")} htmlFor="portal-relink" stack>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          allow.mutate();
        }}
      >
        <TextInput id="portal-relink" type="email" className="w-[280px]" placeholder={t("portalAuth.relinkEmail")} spellCheck={false} value={email} onChange={(e) => { setError(null); setEmail(e.target.value); }} />
        <Button type="submit" variant="secondary" loading={allow.isPending} disabled={!email.trim() || allow.isPending}>
          {t("portalAuth.relinkAction")}
        </Button>
      </form>
    </Row>
  );
}
