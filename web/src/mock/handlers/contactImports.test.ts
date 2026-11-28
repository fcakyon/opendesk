import { afterEach, describe, expect, it, vi } from "vitest";
import type { Contact, ContactImport, ContactImportUpload } from "@/lib/api/types";
import { mappingProblem } from "@/components/contacts/ImportDialog";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]!.workspace.id;
  const form = body instanceof FormData;
  const r = await dispatch(`http://mock${path}`, { method, body: form ? body : body ? JSON.stringify(body) : undefined, headers: { "OD-Workspace": ws } });
  const type = r.headers.get("content-type") ?? "";
  return { status: r.status, headers: r.headers, body: type.includes("json") ? await r.json() : await r.text() };
}

function csv(text: string) {
  const fd = new FormData();
  fd.append("file", new File([text], "people.csv", { type: "text/csv" }));
  return fd;
}

describe("mock contact export", () => {
  installMock();

  it("exports the people asked for as a CSV file, formulas neutralized", async () => {
    const mine = db.workspaces[0]!.contacts[0]!;
    mine.name = "=SUM(1+1)";
    const r = await call("POST", "/v1/contacts/export", { ids: [mine.id] });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("content-disposition")).toContain("attachment");
    const lines = (r.body as string).replace(String.fromCharCode(0xfeff), "").trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Name,Email,/);
    expect(lines[1]).toContain("'=SUM(1+1)");
  });

  it("wants ids or a filter, not both or neither", async () => {
    expect((await call("POST", "/v1/contacts/export", {})).status).toBe(422);
    expect((await call("POST", "/v1/contacts/export", { ids: ["nope"] })).status).toBe(404);
  });
});

describe("mock contact import", () => {
  installMock();
  afterEach(() => vi.useRealTimers());

  it("maps a file, adds the people in chunks and counts what it skipped and what failed", async () => {
    vi.useFakeTimers();
    const before = db.workspaces[0]!.contacts.length;
    const existing = db.workspaces[0]!.contacts.find((c) => c.email)!;
    const file = `Full name,E-mail,Company\nNew One,new.one@example.test,Acme Imports\n${existing.name},${existing.email},\nBroken,not-an-email,\n`;
    const up = (await call("POST", "/v1/contacts/import/upload", csv(file))).body as ContactImportUpload;
    expect(up.rows).toBe(3);
    expect(up.suggested).toMatchObject({ name: "Full name", email: "E-mail", company: "Company" });

    const started = await call("POST", "/v1/contacts/imports", { upload_id: up.upload_id, mapping: up.suggested, match_on: "email", on_match: "skip" });
    expect(started.status).toBe(201);
    const id = (started.body as ContactImport).id;
    await vi.advanceTimersByTimeAsync(1000);
    const done = (await call("GET", `/v1/contacts/imports/${id}`)).body as ContactImport;
    expect(done).toMatchObject({ status: "done", processed: 3, created: 1, skipped: 1, failed: 1 });
    expect(done.errors).toEqual([{ line: 4, message: "The email address is not valid." }]);
    expect(db.workspaces[0]!.contacts).toHaveLength(before + 1);
    const added = db.workspaces[0]!.contacts.find((c) => c.email === "new.one@example.test") as Contact;
    expect(added.company?.name).toBe("Acme Imports");
  });

  it("imports an export as it was, its formula guards taken off", async () => {
    vi.useFakeTimers();
    const ws = db.workspaces[0]!;
    const ann = ws.contacts.find((c) => c.email)!;
    ann.phone = "+1 555 0134";
    ann.notes = "=1+1";
    const exported = (await call("POST", "/v1/contacts/export", { ids: [ann.id] })).body as string;
    expect(exported).toContain("'+1 555 0134");
    const up = (await call("POST", "/v1/contacts/import/upload", csv(exported))).body as ContactImportUpload;
    expect(up.columns.find((c) => c.name === "Phone")?.samples).toEqual(["+1 555 0134"]);
    ann.phone = "";
    ann.notes = "";
    const x = (await call("POST", "/v1/contacts/imports", { upload_id: up.upload_id, mapping: { name: "Name", email: "Email", phone: "Phone", notes: "Notes" }, match_on: "email", on_match: "overwrite" })).body as ContactImport;
    await vi.advanceTimersByTimeAsync(1000);
    expect((await call("GET", `/v1/contacts/imports/${x.id}`)).body).toMatchObject({ status: "done", updated: 1, failed: 0 });
    expect(ws.contacts.find((c) => c.id === ann.id)).toMatchObject({ phone: "+1 555 0134", notes: "=1+1" });
  });

  it("refuses a mapping that cannot find people or name a column the file lacks", async () => {
    const up = (await call("POST", "/v1/contacts/import/upload", csv("Name,Email\nA,a@example.test\n"))).body as ContactImportUpload;
    const start = (mapping: object, match_on = "email") => call("POST", "/v1/contacts/imports", { upload_id: up.upload_id, mapping, match_on, on_match: "skip" });
    expect((await start({ email: "Nope" })).status).toBe(422);
    expect((await start({})).status).toBe(422);
    expect((await start({ name: "Name" })).status).toBe(422);
    expect((await start({ email: "Email" }, "external_id")).status).toBe(422);
    expect((await call("POST", "/v1/contacts/import/upload", csv("Name,Email\n"))).status).toBe(422);
  });

  it("can be stopped", async () => {
    vi.useFakeTimers();
    const rows = Array.from({ length: 60 }, (_, i) => `P${i},p${i}@bulk.test`).join("\n");
    const up = (await call("POST", "/v1/contacts/import/upload", csv(`Name,Email\n${rows}\n`))).body as ContactImportUpload;
    const x = (await call("POST", "/v1/contacts/imports", { upload_id: up.upload_id, mapping: up.suggested, match_on: "email", on_match: "skip" })).body as ContactImport;
    await vi.advanceTimersByTimeAsync(400);
    const stopped = (await call("POST", `/v1/contacts/imports/${x.id}/cancel`)).body as ContactImport;
    expect(stopped.status).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(5000);
    const after = (await call("GET", `/v1/contacts/imports/${x.id}`)).body as ContactImport;
    expect(after.processed).toBe(stopped.processed);
    expect(after.processed).toBeLessThan(60);
  });
});

describe("the import's mapping check", () => {
  it("needs a name or an email, and the column it finds people by", () => {
    expect(mappingProblem({}, "email")).toBe("identity");
    expect(mappingProblem({ name: "Name" }, "email")).toBe("email");
    expect(mappingProblem({ email: "Email" }, "external_id")).toBe("external_id");
    expect(mappingProblem({ email: "Email" }, "email")).toBeNull();
    expect(mappingProblem({ name: "Name", external_id: "Id" }, "external_id")).toBeNull();
  });
});
