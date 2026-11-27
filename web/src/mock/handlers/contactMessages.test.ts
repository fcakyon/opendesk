import { describe, expect, it } from "vitest";
import type { Contact, ContactMessage, NoticePreview, Ticket } from "@/lib/api/types";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: ws ? { "OD-Workspace": ws } : {} });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

describe("mock messages to many customers", () => {
  installMock();
  const ws = () => db.workspaces[0];
  const finished = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const m = ((await call("GET", "/v1/contact-messages")).body.data as ContactMessage[]).find((x) => x.id === id)!;
      if (m.state !== "sending") return m;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("never finished");
  };

  it("counts who a send reaches and leaves out", async () => {
    const people = ws().contacts.filter((c) => c.email && !c.blocked).slice(0, 3);
    const noEmail = ws().contacts.find((c) => !c.email);
    const ids = [...people.map((c) => c.id), ...(noEmail ? [noEmail.id] : [])];
    const r = (await call("POST", "/v1/contacts/message/preview", { ids })).body as NoticePreview;
    expect(r.reaches).toBe(3);
    expect(r.skipped.no_email ?? 0).toBe(noEmail ? 1 : 0);
    expect((await call("POST", "/v1/contacts/message/preview", {})).status).toBe(422);
    expect((await call("POST", "/v1/contacts/message/preview", { ids: ["nope"] })).status).toBe(404);
  });

  it("makes a ticket for each customer, with the shared label", async () => {
    const people = ws().contacts.filter((c) => c.email && !c.blocked).slice(0, 7) as Contact[];
    const mailbox = ws().mailboxes.find((m) => m.status !== "disabled")!;
    const body = { ids: people.map((c) => c.id), mailbox_id: mailbox.id, subject: "Planned maintenance", body_html: "<p>Hi {{ contact.first_name }}</p>", label: "Maintenance" };
    for (const bad of [{ ...body, label: "" }, { ...body, subject: " " }, { ...body, body_html: "<p></p>" }, { ...body, mailbox_id: "nope" }]) {
      expect((await call("POST", "/v1/contacts/message", bad)).status).toBe(422);
    }
    const sent = await call("POST", "/v1/contacts/message", body);
    expect(sent.status).toBe(202);
    const m = sent.body as ContactMessage;
    expect(m).toMatchObject({ state: "sending", total: 7, status: "solved" });
    expect((await call("POST", "/v1/contacts/message", body)).status).toBe(409);
    const done = await finished(m.id);
    expect(done.last_error).toBe("");
    expect(done).toMatchObject({ state: "done", sent: 7, failed: 0 });
    const tickets = ws().tickets.filter((t: Ticket) => t.subject === "Planned maintenance");
    expect(tickets).toHaveLength(7);
    expect(tickets.every((t) => t.status === "solved" && t.tags.some((x) => x.name === "Maintenance"))).toBe(true);
    expect(new Set(tickets.map((t) => t.contact?.id)).size).toBe(7);
  });

  it("stops when asked", async () => {
    const people = ws().contacts.filter((c) => c.email && !c.blocked).slice(0, 12);
    const mailbox = ws().mailboxes.find((m) => m.status !== "disabled")!;
    const m = (await call("POST", "/v1/contacts/message", { ids: people.map((c) => c.id), mailbox_id: mailbox.id, subject: "Stop me", body_html: "<p>x</p>", label: "Stopped" })).body as ContactMessage;
    const stopped = (await call("POST", `/v1/contact-messages/${m.id}/cancel`)).body as ContactMessage;
    expect(stopped.state).toBe("cancelled");
    expect(ws().tickets.filter((t) => t.subject === "Stop me").length).toBeLessThan(12);
  });
});
