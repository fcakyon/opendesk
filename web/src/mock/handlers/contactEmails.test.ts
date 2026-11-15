import { describe, expect, it } from "vitest";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: ws ? { "OD-Workspace": ws } : {},
  });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

describe("mock contact emails", () => {
  installMock();

  it("adds, swaps and removes extra addresses, and keeps an address with one contact", async () => {
    const [a, b] = db.workspaces[0]!.contacts.filter((c) => c.email && c.emails.length === 0);
    const base = `/v1/contacts/${a!.id}/emails`;

    const added = await call("POST", base, { email: " Home@Example.org " });
    expect(added.status).toBe(201);
    expect(added.body.emails).toEqual(["home@example.org"]);

    // One contact holds an address, primary or extra.
    expect((await call("POST", base, { email: "home@example.org" })).status).toBe(409);
    expect((await call("POST", base, { email: b!.email })).status).toBe(409);
    expect((await call("POST", `/v1/contacts/${b!.id}/emails`, { email: "home@example.org" })).status).toBe(409);
    expect((await call("PATCH", `/v1/contacts/${b!.id}`, { email: "home@example.org" })).status).toBe(409);
    expect((await call("POST", base, { email: "nope" })).status).toBe(422);

    const found = await call("GET", "/v1/contacts?q=home@example");
    expect(found.body.data.map((c: { id: string }) => c.id)).toEqual([a!.id]);

    const oldPrimary = a!.email;
    const swapped = await call("POST", `${base}/${encodeURIComponent("home@example.org")}/make-primary`);
    expect(swapped.body).toMatchObject({ email: "home@example.org", emails: [oldPrimary] });
    expect((await call("POST", `${base}/${encodeURIComponent("none@example.org")}/make-primary`)).status).toBe(404);

    const removed = await call("DELETE", `${base}/${encodeURIComponent(oldPrimary!)}`);
    expect(removed.body.emails).toEqual([]);
    expect((await call("DELETE", `${base}/${encodeURIComponent(oldPrimary!)}`)).status).toBe(404);
  });
});
