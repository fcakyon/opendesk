import { describe, expect, it } from "vitest";
import type { ChatVerificationPage, Contact } from "@/lib/api/types";
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

// Chat visitor verification on the mock server (contracts/api.md "Contact verification").
describe("mock chat verification", () => {
  installMock();

  const ws = () => db.workspaces[0];
  const chats = (c: Contact) => ws().tickets.some((t) => t.contact?.id === c.id && t.channel === "chat");
  const contact = async (id: string) => (await call("GET", `/v1/contacts/${id}`)).body as Contact;

  it("says whether each chat visitor proved who they are", async () => {
    const signedIn = ws().contacts.find((c) => chats(c) && !!c.external_id)!;
    const typed = ws().contacts.find((c) => chats(c) && !c.external_id && !!c.email)!;
    const byEmail = ws().contacts.find((c) => !chats(c))!;
    expect((await contact(signedIn.id)).verification).toMatchObject({ status: "verified", via: "identity" });
    expect((await contact(typed.id)).verification).toEqual({ status: "unverified", via: null, verified_at: null });
    expect((await contact(byEmail.id)).verification?.status).toBe("none");
  });

  it("reads a link without verifying anyone, and verifies on the visitor's click", async () => {
    expect((await call("POST", "/v1/public/chat-verification", { token: "nope" })).status).toBe(404);
    const read = await call("POST", "/v1/public/chat-verification", { token: "demo" });
    expect(read.status).toBe(200);
    const page = read.body as ChatVerificationPage;
    expect(page).toMatchObject({ status: "pending", brand_name: expect.any(String) });
    const visitor = ws().contacts.find((c) => c.email === page.email)!;
    expect((await contact(visitor.id)).verification?.status).toBe("unverified");

    const done = await call("POST", "/v1/public/chat-verification/confirm", { token: "demo" });
    expect(done.status).toBe(200);
    expect((done.body as ChatVerificationPage).status).toBe("verified");
    expect((await contact(visitor.id)).verification).toMatchObject({ status: "verified", via: "email" });
    // Opened again, the link says so, and confirming again changes nothing.
    expect(((await call("POST", "/v1/public/chat-verification", { token: "demo" })).body as ChatVerificationPage).status).toBe("verified");
    expect((await call("POST", "/v1/public/chat-verification/confirm", { token: "demo" })).status).toBe(200);
  });
});
