import { describe, expect, it } from "vitest";
import type { Message, Ticket, WhatsAppConnection, WhatsAppTemplate, WhatsAppTicketState } from "@/lib/api/types";
import { db } from "../db";
import { installMock } from "../index";
import { dispatch } from "../router";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: ws ? { "OD-Workspace": ws } : {},
  });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

const creds = (token: string, number = "106540352242999") => ({ phone_number_id: number, waba_id: "102290129340398", access_token: token, app_secret: "secret" });

describe("mock WhatsApp", () => {
  installMock();

  const ticketOf = async (name: string): Promise<Ticket> => {
    const list = (await call("GET", "/v1/tickets?channel=whatsapp")).body.data as Ticket[];
    return list.find((t) => t.contact?.name === name)!;
  };
  const stateOf = async (t: Ticket) => (await call("GET", `/v1/tickets/${t.id}/whatsapp`)).body as WhatsAppTicketState;

  it("seeds a connected number, its templates and two WhatsApp tickets, one with its window closed", async () => {
    const list = (await call("GET", "/v1/whatsapp/connections")).body.data as WhatsAppConnection[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "connected", display_phone_number: "+1 415-555-0100" });
    const templates = (await call("GET", `/v1/whatsapp/templates?connection_id=${list[0]!.id}`)).body.data as WhatsAppTemplate[];
    expect(templates.map((x) => x.status)).toEqual(expect.arrayContaining(["APPROVED", "PENDING", "REJECTED"]));
    const open = await stateOf(await ticketOf("Mateo Ibarra-Silva"));
    const closed = await stateOf(await ticketOf("Ana Souza-Lindqvist"));
    expect(open).toMatchObject({ connection_id: list[0]!.id, window_open: true });
    expect(closed).toMatchObject({ connection_id: list[0]!.id, window_open: false });
  });

  it("connects a number, refusing a token Meta rejects, ids that are not numbers and a duplicate", async () => {
    const at = (c: object) => call("POST", "/v1/whatsapp/connections", { credentials: c });
    expect((await at(creds("wrong"))).status).toBe(422);
    expect((await at(creds("demo", "../me"))).status).toBe(422);
    const made = await at(creds("demo"));
    expect(made.status).toBe(201);
    expect((await at(creds("demo"))).status).toBe(409);
    expect((await call("POST", `/v1/whatsapp/connections/${made.body.id}/test`)).body.status).toBe("connected");
    expect((await call("DELETE", `/v1/whatsapp/connections/${made.body.id}`)).status).toBe(204);
  });

  it("answers freely while the window is open, with receipts that move forward", async () => {
    const t = await ticketOf("Mateo Ibarra-Silva");
    const sent = await call("POST", `/v1/tickets/${t.id}/messages`, { kind: "reply", body_html: "<p>Yes, VAT is included.</p>" });
    expect(sent.status).toBe(201);
    expect((sent.body as Message).delivery_status).toBe("pending");
  });

  it("refuses a free reply once the window closed, and sends an approved template", async () => {
    const t = await ticketOf("Ana Souza-Lindqvist");
    const free = await call("POST", `/v1/tickets/${t.id}/messages`, { kind: "reply", body_html: "<p>Hello</p>" });
    expect(free.status).toBe(422);
    expect(free.body.code).toBe("whatsapp_window_closed");
    const templates = (await call("GET", "/v1/whatsapp/templates")).body.data as WhatsAppTemplate[];
    const followUp = templates.find((x) => x.name === "follow_up")!;
    const pending = templates.find((x) => x.status === "PENDING")!;
    const url = `/v1/tickets/${t.id}/whatsapp-template`;
    expect((await call("POST", url, { template_id: pending.id })).status).toBe(422);
    expect((await call("POST", url, { template_id: followUp.id, params: { "1": "Ana" } })).status).toBe(422);
    const ok = await call("POST", url, { template_id: followUp.id, params: { "1": "Ana", "2": "your invoice" } });
    expect(ok.status).toBe(201);
    expect((ok.body as Message).body_html).toBe("<p>Hi Ana, did our answer about your invoice help?</p>");
  });

  it("keeps a ticket on its number: disconnected it can't reply, connected again it can", async () => {
    const t = await ticketOf("Mateo Ibarra-Silva");
    const [c] = (await call("GET", "/v1/whatsapp/connections")).body.data as WhatsAppConnection[];
    expect((await call("DELETE", `/v1/whatsapp/connections/${c!.id}`)).status).toBe(204);
    expect((await stateOf(t)).connection_id).toBeNull();
    const refused = await call("POST", `/v1/tickets/${t.id}/messages`, { kind: "reply", body_html: "<p>Hi</p>" });
    expect(refused.body.code).toBe("whatsapp_disconnected");
    const again = await call("POST", "/v1/whatsapp/connections", { credentials: creds("demo", c!.phone_number_id) });
    expect(again.status).toBe(201);
    expect(await stateOf(t)).toMatchObject({ connection_id: again.body.id, window_open: true });
    expect((await call("POST", `/v1/tickets/${t.id}/messages`, { kind: "reply", body_html: "<p>Back</p>" })).status).toBe(201);
  });
});
