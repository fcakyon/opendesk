import { describe, expect, it } from "vitest";
import type { KbArticle, WikiNode, WikiPage } from "@/lib/api/types";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const ws = db.workspaces[0]?.workspace.id;
  return dispatch(`http://mock${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { ...(ws ? { "OD-Workspace": ws } : {}), ...headers } });
}
async function json(method: string, path: string, body?: unknown) {
  const r = await call(method, path, body);
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

/** Runs fn with the mock's person in another role of the first workspace. */
async function asRole<T>(role: "viewer" | "agent", fn: () => Promise<T>): Promise<T> {
  const me = db.workspaces[0].members.find((m) => m.user_id === db.meId)!;
  const was = me.role;
  me.role = role;
  try {
    return await fn();
  } finally {
    me.role = was;
  }
}

describe("mock wiki desk", () => {
  installMock();

  it("seeds a ticket mention, a contact mention and a ticket list block in the handbook", async () => {
    const tree = (await json("GET", "/v1/wiki/pages")).body.data as WikiNode[];
    const page = async (title: string) => (await json("GET", `/v1/wiki/pages/${tree.find((n) => n.title === title)!.id}`)).body as WikiPage;
    const escalation = await page("Escalation process");
    const ws = db.workspaces[0];
    const urgent = ws.views.find((v) => v.name === "Urgent")!;
    expect(escalation.body_html).toMatch(/<a data-type="ticket" data-id="[0-9a-f-]{36}" href="\/tickets\/\d+">#\d+ /);
    expect(escalation.body_html).toContain(`<div data-type="tickets" data-id="${urgent.id}" data-limit="5"></div>`);
    expect((await page("Refund policy")).body_html).toMatch(/<a data-type="contact" data-id="[0-9a-f-]{36}" href="\/contacts\/[0-9a-f-]{36}">/);
  });

  it("finds tickets and contacts to mention through the app's search", async () => {
    const t = db.workspaces[0].tickets[0];
    const byNumber = (await json("GET", `/v1/search?q=${t.number}`)).body;
    expect(byNumber.tickets.some((x: { id: string }) => x.id === t.id)).toBe(true);
    expect((await json("GET", `/v1/tickets/${t.number}`)).body.id).toBe(t.id);
  });

  it("streams Ollie's writing and answers with the HTML at done", async () => {
    const r = await call("POST", "/v1/wiki/ai/write", { mode: "action_items", html: "<p>Refund the customer. Tell billing. Close the ticket.</p>", title: "Refunds" }, { Accept: "text/event-stream" });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const text = await r.text();
    const deltas = [...text.matchAll(/event: delta\ndata: (.*)\n/g)].map((m) => (JSON.parse(m[1]) as { text: string }).text).join("");
    const done = JSON.parse(/event: done\ndata: (.*)\n/.exec(text)![1]) as { html: string };
    expect(deltas).toContain('data-type="taskItem"');
    expect(done.html).toContain("Tell billing.");
    expect(done.html.match(/data-type="taskItem"/g)).toHaveLength(3);
  });

  it("checks Ollie's asks as the API does", async () => {
    const write = (b: unknown) => json("POST", "/v1/wiki/ai/write", b);
    expect((await write({ mode: "shorter" })).status).toBe(422);
    expect((await write({ mode: "custom", context_html: "<p>x</p>" })).status).toBe(422);
    expect((await write({ mode: "nonsense", html: "<p>x</p>" })).status).toBe(422);
    expect((await write({ mode: "continue", context_html: "<p>We answer within four hours.</p>" })).body.html).toMatch(/^<p>/);
    expect((await write({ mode: "custom", instructions: "Write a greeting" })).status).toBe(201);
    expect(await asRole("viewer", async () => (await write({ mode: "improve", html: "<p>x</p>" })).status)).toBe(403);
    const ws = db.workspaces[0];
    ws.ai.enabled = false;
    try {
      expect((await write({ mode: "improve", html: "<p>x</p>" })).body.code).toBe("ai_off");
    } finally {
      ws.ai.enabled = true;
    }
  });

  it("publishes a page as a draft article, keeping text and counting what stays in the wiki", async () => {
    const ws = db.workspaces[0];
    const t = ws.tickets[0];
    const other = (await json("POST", "/v1/wiki/pages", { title: "Other" })).body as WikiPage;
    const body =
      `<p>See <a data-type="ticket" data-id="${t.id}" href="/tickets/${t.number}">#${t.number} ${t.subject}</a> and <a data-type="page" data-id="${other.id}" href="/wiki/${other.id}">Other</a>.</p>` +
      `<div data-type="callout" data-icon="💡"><p>Be kind.</p></div><div data-type="database" data-id="${other.id}"></div>` +
      `<img src="/v1/attachments/00000000-0000-0000-0000-000000000001" alt="x"><div data-type="file" data-src="https://example.com/a.pdf" data-name="Policy"></div>`;
    const page = (await json("POST", "/v1/wiki/pages", { title: "Refunds runbook", body_html: body })).body as WikiPage;
    const collection = ws.collections[0];
    const r = await json("POST", "/v1/kb/articles/from-wiki", { page_id: page.id, collection_id: collection.id });
    expect(r.status).toBe(201);
    const a = r.body.article as KbArticle;
    expect(r.body.left_out).toBe(2);
    expect(a).toMatchObject({ title: "Refunds runbook", status: "draft", collection_id: collection.id });
    expect(a.body_html).toContain(`See #${t.number} ${t.subject} and Other.`);
    expect(a.body_html).toContain("<blockquote><p>Be kind.</p></blockquote>");
    expect(a.body_html).toContain('<a href="https://example.com/a.pdf">Policy</a>');
    expect(a.body_html).not.toContain("data-type");
    expect((await json("GET", `/v1/kb/articles/${a.id}`)).body.id).toBe(a.id);
  });

  it("refuses to publish without a title, for viewers, and a page the caller can't see", async () => {
    const untitled = (await json("POST", "/v1/wiki/pages", { title: "" })).body as WikiPage;
    expect((await json("POST", "/v1/kb/articles/from-wiki", { page_id: untitled.id })).status).toBe(422);
    expect((await json("POST", "/v1/kb/articles/from-wiki", { page_id: untitled.id, title: "Named here" })).body.article.title).toBe("Named here");
    expect(await asRole("viewer", async () => (await json("POST", "/v1/kb/articles/from-wiki", { page_id: untitled.id, title: "x" })).status)).toBe(403);
    expect((await json("POST", "/v1/kb/articles/from-wiki", { page_id: "00000000-0000-0000-0000-000000000000" })).status).toBe(404);
  });
});
