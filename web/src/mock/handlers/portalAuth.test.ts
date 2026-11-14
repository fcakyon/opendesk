import { describe, expect, it } from "vitest";
import type { Brand, PortalAuthSettings } from "@/lib/api/types";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: ws ? { "OD-Workspace": ws } : {} });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

describe("mock customer portal sign-in", () => {
  installMock();

  it("keeps a brand local until a provider is saved, and never returns the secret", async () => {
    const brand = ((await call("GET", "/v1/brands")).body.data as Brand[]).find((b) => b.slug === "pressroom")!;
    expect(brand.portal_auth).toEqual({ mode: "local" });
    const path = `/v1/brands/${brand.id}`;

    expect((await call("PATCH", path, { portal_auth: { mode: "oidc", issuer: "http://insecure.example", client_id: "c", client_secret: "s" } })).body.code).toBe("invalid_oidc_config");
    expect((await call("PATCH", path, { portal_auth: { mode: "oidc", issuer: "https://login.acme.com", client_id: "c" } })).body.code).toBe("oidc_secret_required");

    const saved = (await call("PATCH", path, { portal_auth: { mode: "local_and_oidc", issuer: "https://login.acme.com", client_id: "c", client_secret: "s", create_contacts: true } })).body as Brand;
    expect(saved.portal_auth.mode).toBe("local_and_oidc");
    const read = (await call("GET", `${path}/portal/auth`)).body as PortalAuthSettings & { client_secret?: string };
    expect(read).toEqual({ mode: "local_and_oidc", issuer: "https://login.acme.com", client_id: "c", secret_configured: true, create_contacts: true });
    expect(read.client_secret).toBeUndefined();

    // An omitted secret keeps the saved one for the same provider, and is refused for another.
    expect((await call("PATCH", path, { portal_auth: { mode: "oidc", issuer: "https://login.acme.com", client_id: "c" } })).status).toBe(200);
    expect((await call("PATCH", path, { portal_auth: { mode: "oidc", issuer: "https://login.other.com", client_id: "c" } })).body.code).toBe("oidc_secret_required");

    // The portal's public config says how to sign in, once the help center is on.
    expect((await call("GET", `/v1/public/help/${brand.slug}/portal/config`)).status).toBe(404);
    await call("PATCH", path, { help_center: { enabled: true } });
    expect((await call("GET", `/v1/public/help/${brand.slug}/portal/config`)).body.auth_mode).toBe("oidc");

    await call("PATCH", path, { portal_auth: { mode: "local" } });
    const cleared = (await call("GET", `${path}/portal/auth`)).body as PortalAuthSettings;
    expect(cleared).toEqual({ mode: "local", issuer: "", client_id: "", secret_configured: false, create_contacts: false });
  });

  it("allows a relink for a contact that can sign in, once per request", async () => {
    const brand = ((await call("GET", "/v1/brands")).body.data as Brand[])[0];
    const contact = db.workspaces[0].contacts.find((c) => !c.blocked)!;
    const path = `/v1/brands/${brand.id}/portal/relink-authorizations`;
    const ok = await call("POST", path, { contact_id: contact.id });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ brand_id: brand.id, contact_id: contact.id });
    expect(Date.parse(ok.body.expires_at) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect((await call("POST", path, { contact_id: "00000000-0000-0000-0000-000000000000" })).status).toBe(404);
  });
});
