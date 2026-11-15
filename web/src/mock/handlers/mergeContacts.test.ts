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

describe("mock merge contacts", () => {
  installMock();

  it("moves tickets and addresses to the contact that stays, and removes the other", async () => {
    const ws = db.workspaces[0]!;
    const [keep, gone] = ws.contacts.filter((c) => c.email && !c.blocked && !c.external_id && c.ticket_count > 0);
    const goneTickets = ws.tickets.filter((t) => t.contact?.id === gone!.id).length;
    const keepTickets = ws.tickets.filter((t) => t.contact?.id === keep!.id).length;
    const goneEmail = gone!.email;

    expect((await call("POST", `/v1/contacts/${gone!.id}/merge`, { into: gone!.id })).status).toBe(422);
    expect((await call("POST", `/v1/contacts/${gone!.id}/merge`, { into: "nope" })).status).toBe(404);

    const merged = await call("POST", `/v1/contacts/${gone!.id}/merge`, { into: keep!.id });
    expect(merged.status).toBe(200);
    expect(merged.body.id).toBe(keep!.id);
    expect(merged.body.emails).toContain(goneEmail);
    expect(merged.body.ticket_count).toBe(keepTickets + goneTickets);
    expect((await call("GET", `/v1/contacts/${gone!.id}`)).status).toBe(404);
    expect(ws.tickets.some((t) => t.contact?.id === gone!.id)).toBe(false);
  });
});
