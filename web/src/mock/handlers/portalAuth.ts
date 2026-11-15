// How customers sign in to a brand's portal in mock mode (contracts/customer-portal.md):
// the brand's provider settings, the relink permission and the portal's public config.
// The provider itself is out of reach here, so "Continue with SSO" has nowhere to go.

import type { Brand, PortalAuthMode, PortalAuthSettings } from "@/lib/api/types";
import { db, type WsData } from "../db";
import { HttpError, forbidden, get, invalid, notFound, post, respond, type Ctx } from "../router";
import { isAdmin } from "../teams";
import { uuid } from "../util";

const MODES: PortalAuthMode[] = ["local", "oidc", "local_and_oidc"];

/** What the API keeps beside a brand's mode; the client secret is only ever "configured". */
const settings = new Map<string, Omit<PortalAuthSettings, "mode">>();
const blank = (): Omit<PortalAuthSettings, "mode"> => ({ issuer: "", client_id: "", secret_configured: false, create_contacts: false });

function findBrand(ctx: Ctx): Brand {
  const b = ctx.ws.brands.find((x) => x.id === ctx.params.id);
  if (!b) throw notFound("Brand");
  return b;
}

function requireAdmin(ws: WsData) {
  if (!isAdmin(ws, db.meId)) throw forbidden("Only admins can change this");
}

/** PATCH /v1/brands/{id} with portal_auth: the same checks as the API, short of reaching the provider. */
export function writePortalAuth(b: Brand, input: Record<string, unknown>) {
  const mode = input.mode as PortalAuthMode;
  if (!MODES.includes(mode)) throw new HttpError(422, "invalid_oidc_config", "Enter a valid HTTPS OIDC issuer and client configuration.");
  const prev = settings.get(b.id) ?? blank();
  if (mode === "local") {
    settings.delete(b.id);
    b.portal_auth = { mode };
    return;
  }
  const issuer = typeof input.issuer === "string" ? input.issuer.trim() : "";
  const clientId = typeof input.client_id === "string" ? input.client_id.trim() : "";
  const secret = typeof input.client_secret === "string" ? input.client_secret : undefined;
  if (!/^https:\/\/[^/\s]+(\/\S*)?$/.test(issuer) || !clientId || (secret !== undefined && !secret.trim())) {
    throw new HttpError(422, "invalid_oidc_config", "Enter a valid HTTPS OIDC issuer and client configuration.");
  }
  if (secret === undefined && (issuer !== prev.issuer || clientId !== prev.client_id || !prev.secret_configured)) {
    throw new HttpError(422, "oidc_secret_required", "Enter the client secret for this provider configuration.");
  }
  settings.set(b.id, { issuer, client_id: clientId, secret_configured: true, create_contacts: input.create_contacts === true });
  b.portal_auth = { mode };
}

export function registerPortalAuthRoutes() {
  get("/v1/brands/:id/portal/auth", (ctx) => {
    requireAdmin(ctx.ws);
    const b = findBrand(ctx);
    return { mode: b.portal_auth.mode, ...(settings.get(b.id) ?? blank()) } satisfies PortalAuthSettings;
  });

  post("/v1/brands/:id/portal/relink-authorizations", (ctx) => {
    requireAdmin(ctx.ws);
    if (db.stepUp === "reauth_required") throw new HttpError(403, "reauth_required", "Sign in again with your second factor, if enabled, to authorize a relink.");
    const b = findBrand(ctx);
    const contact = ctx.ws.contacts.find((c) => c.id === (ctx.body as { contact_id?: string }).contact_id);
    if (!contact) throw notFound("Contact");
    if (contact.blocked) throw invalid("A blocked contact cannot relink an identity.");
    return respond(201, { id: uuid(), brand_id: b.id, contact_id: contact.id, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });
  });

  // The portal's public side: its brand, and no customer signed in.
  get("/v1/public/help/:slug/portal/config", (ctx) => {
    const slug = String(ctx.params.slug);
    for (const w of db.workspaces) {
      const b = w.brands.find((x) => x.slug === slug && x.help_center.enabled);
      if (b) {
        return {
          title: b.help_center.title || `${b.name} Help`,
          logo_url: b.images.help_center_logo || b.images.logo,
          color: b.color,
          locale: b.locale,
          locale_fixed: false,
          help_url: b.help_center.url,
          auth_mode: b.portal_auth.mode,
        };
      }
    }
    throw notFound("Help center");
  });
  post("/v1/customer/portal/auth/refresh", () => {
    throw new HttpError(401, "unauthenticated", "Sign in to continue");
  });
}
