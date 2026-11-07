import { describe, expect, it } from "vitest";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: ws ? { "OD-Workspace": ws } : {} });
  return { status: r.status, body: r.status === 204 || r.status === 202 ? null : await r.json() };
}

describe("workspace products", () => {
  installMock();

  it("refuses to turn every product off, and keeps a workspace on Pages alone", async () => {
    const r = await call("PATCH", "/v1/workspace", { settings: { tickets_enabled: false, mail_enabled: false, pages_enabled: false } });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("at_least_one_product_required");
    expect((await call("PATCH", "/v1/workspace", { settings: { tickets_enabled: false, mail_enabled: false } })).status).toBe(200);
    await call("PATCH", "/v1/workspace", { settings: { tickets_enabled: true, mail_enabled: true } });
  });

  it("turns Mail off with the Mail switch", async () => {
    await call("PATCH", "/v1/workspace", { settings: { mail_enabled: false } });
    expect((await call("GET", "/v1/workspace")).body.mail_available).toBe(false);
    expect((await call("GET", "/v1/collab")).body.enabled).toBe(false);
    await call("PATCH", "/v1/workspace", { settings: { mail_enabled: true } });
    expect((await call("GET", "/v1/collab")).body.enabled).toBe(true);
  });
});
