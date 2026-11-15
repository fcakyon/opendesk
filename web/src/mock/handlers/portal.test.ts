import { describe, expect, it } from "vitest";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: ws ? { "OD-Workspace": ws } : {} });
  return { status: r.status, body: await r.json() };
}

describe("mock customer portal", () => {
  installMock();

  it("starts a request that then shows in the customer's list with their words", async () => {
    const slug = db.workspaces[0].brands.find((b) => b.help_center.enabled)!.slug;
    const before = (await call("GET", "/v1/customer/portal/tickets")).body.data.length;
    const made = await call("POST", "/v1/customer/portal/tickets", { workspace_slug: slug, subject: "  Printer   is down ", body: "  It will not print  " });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ subject: "Printer is down", status: "open" });
    const list = (await call("GET", "/v1/customer/portal/tickets")).body.data;
    expect(list.length).toBe(before + 1);
    expect((await call("GET", `/v1/customer/portal/tickets/${made.body.id}/messages`)).body.data).toMatchObject([{ direction: "inbound", body_text: "It will not print" }]);
    expect((await call("POST", "/v1/customer/portal/tickets", { workspace_slug: slug, subject: " ", body: "x" })).status).toBe(422);
    expect((await call("POST", "/v1/customer/portal/tickets", { workspace_slug: "nope", subject: "x", body: "x" })).status).toBe(404);
  });

  it("takes an uploaded file once, onto the request it starts", async () => {
    const slug = db.workspaces[0].brands.find((b) => b.help_center.enabled)!.slug;
    const ws = db.workspaces[0].workspace.id;
    const upload = async (name: string, size = 12) => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(size)], name, { type: "image/png" }));
      const r = await dispatch("http://mock/v1/customer/portal/attachments", { method: "POST", body: form, headers: { "OD-Workspace": ws } });
      return { status: r.status, body: await r.json() };
    };
    const shot = await upload("shot.png");
    expect(shot.status).toBe(201);
    expect(shot.body).toMatchObject({ filename: "shot.png", content_type: "image/png", size_bytes: 12 });
    expect((await upload("run.exe")).status).toBe(422);
    expect((await upload("huge.png", 10 * 1024 * 1024 + 1)).status).toBe(413);

    const made = await call("POST", "/v1/customer/portal/tickets", { workspace_slug: slug, subject: "With a file", body: "x", attachment_ids: [shot.body.id] });
    expect(made.status).toBe(201);
    const msgs = (await call("GET", `/v1/customer/portal/tickets/${made.body.id}/messages`)).body.data;
    expect(msgs[0].attachments).toMatchObject([{ id: shot.body.id, filename: "shot.png" }]);
    // The same file cannot go on a second request, and a made-up id is refused.
    expect((await call("POST", "/v1/customer/portal/tickets", { workspace_slug: slug, subject: "Again", body: "x", attachment_ids: [shot.body.id] })).status).toBe(422);
    expect((await call("POST", "/v1/customer/portal/tickets", { workspace_slug: slug, subject: "Six", body: "x", attachment_ids: Array(6).fill("x") })).status).toBe(422);
  });
});
