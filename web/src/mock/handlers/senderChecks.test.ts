import { afterEach, describe, expect, it } from "vitest";
import type { Mailbox, Message, Widget } from "@/lib/api/types";
import { normalizeFormSender } from "@/components/settings/ContactFormsField";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";
import { addMessage } from "../tickets";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: ws ? { "OD-Workspace": ws } : {} });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

describe("mock sender checks", () => {
  installMock();
  const ws = () => db.workspaces[0];
  afterEach(() => {
    db.stepUp = "ok";
  });

  it("seeds a contact form message and an unverified reply that kept its status", () => {
    const form = ws().messages.find((m) => m.form_sender);
    expect(form?.form_sender).toBe("website@margin.app");
    const formTicket = ws().tickets.find((t) => t.id === form!.ticket_id)!;
    expect(formTicket.contact?.email).toBe(form!.from_email);

    const unverified = ws().messages.find((m) => m.auth_failed)!;
    expect(unverified.reply_to).toBeTruthy();
    const t = ws().tickets.find((x) => x.id === unverified.ticket_id)!;
    expect(t.status).toBe("solved");
    const kept = ws().activities.find((a) => a.ticket_id === t.id && a.type === "status_changed" && a.data.reason === "sender_unverified");
    expect(kept?.data).toMatchObject({ from: "solved", to: "solved", message_id: unverified.id });
  });

  it("an unverified reply does not reopen, a verified one does", () => {
    const t = ws().tickets.find((x) => x.channel === "email" && x.status === "pending" && !x.spam)!;
    addMessage(ws(), t, { kind: "reply", direction: "inbound", html: "<p>Change the bank account</p>", auth_failed: true });
    expect(t.status).toBe("pending");
    addMessage(ws(), t, { kind: "reply", direction: "inbound", html: "<p>Thanks</p>" });
    expect(t.status).toBe("open");
  });

  it("validates and stores trusted form senders", async () => {
    const m = (await call("GET", "/v1/mailboxes")).body.data[0] as Mailbox;
    const ok = await call("PATCH", `/v1/mailboxes/${m.id}`, { trusted_form_senders: ["Website@Example.com", "@forms.example.com", "website@example.com"] });
    expect(ok.status).toBe(200);
    expect((ok.body as Mailbox).trusted_form_senders).toEqual(["website@example.com", "@forms.example.com"]);
    for (const bad of [["@gmail.com"], ["nope"], [m.email]]) {
      expect((await call("PATCH", `/v1/mailboxes/${m.id}`, { trusted_form_senders: bad })).status).toBe(422);
    }
    const cleared = await call("PATCH", `/v1/mailboxes/${m.id}`, { trusted_form_senders: [] });
    expect((cleared.body as Mailbox).trusted_form_senders).toEqual([]);
  });

  it("stores whether a mailbox keeps automatic mail", async () => {
    const m = (await call("GET", "/v1/mailboxes")).body.data[0] as Mailbox;
    expect(m.keep_automatic_mail).toBe(false);
    const on = await call("PATCH", `/v1/mailboxes/${m.id}`, { keep_automatic_mail: true });
    expect((on.body as Mailbox).keep_automatic_mail).toBe(true);
    const off = await call("PATCH", `/v1/mailboxes/${m.id}`, { keep_automatic_mail: false });
    expect((off.body as Mailbox).keep_automatic_mail).toBe(false);
  });

  it("normalizes form sender entries like the API", () => {
    expect(normalizeFormSender(" Website@Company.com ")).toBe("website@company.com");
    expect(normalizeFormSender("@Forms.Company.com")).toBe("@forms.company.com");
    expect(normalizeFormSender("@company")).toBeNull();
    expect(normalizeFormSender("website")).toBeNull();
  });

  it("creates a widget without its secret when the owner-level gate is not passed", async () => {
    const brand = ws().brands[0];
    const open = await call("POST", "/v1/widgets", { brand_id: brand.id, name: "Docs site" });
    expect(open.status).toBe(201);
    expect(open.body).toMatchObject({ secret_available: true });
    expect((open.body as { secret: string }).secret).toMatch(/^wsec_/);

    db.stepUp = "reauth_required";
    const gated = await call("POST", "/v1/widgets", { brand_id: brand.id, name: "Shop" });
    expect(gated.status).toBe(201);
    expect(gated.body).toMatchObject({ secret_available: false });
    expect("secret" in (gated.body as object)).toBe(false);
    const id = (gated.body as Widget).id;
    const rotate = await call("POST", `/v1/widgets/${id}/secret/rotate`);
    expect(rotate.status).toBe(403);
    expect((rotate.body as { code: string }).code).toBe("reauth_required");

    db.stepUp = "ok";
    expect((await call("POST", `/v1/widgets/${id}/secret/rotate`)).body).toMatchObject({ secret: expect.stringMatching(/^wsec_/) });
  });

  it("keeps sender checks out of messages that are not inbound email", () => {
    const chat = ws().messages.filter((m: Message) => m.direction === "outbound");
    expect(chat.every((m) => !m.auth_failed && !m.form_sender && !m.reply_to)).toBe(true);
  });
});
