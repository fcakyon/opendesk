// Mock contact imports (contracts/imports.md "Contacts"): a CSV file is read in the browser on
// upload, and a run adds the people in chunks, announcing its progress to the person who started it.

import type { ContactImport, ContactImportMapping, ContactImportMatch, ContactImportOnMatch, ContactImportUpload } from "@/lib/api/types";
import { db, type WsData } from "../db";
import { publish } from "../gateway";
import { HttpError, get, invalid, notFound, post, respond } from "../router";
import { nowIso, uuid } from "../util";
import { importPerson } from "./resources";

type Upload = ContactImportUpload & { header: string[]; data: string[][] };
type Run = { x: ContactImport; upload: Upload; mapping: ContactImportMapping; lines: number[] };
type State = { uploads: Upload[]; runs: Run[]; timers: Map<string, ReturnType<typeof setInterval>> };
const states = new Map<string, State>();
function stateOf(ws: WsData): State {
  let s = states.get(ws.workspace.id);
  if (!s) {
    s = { uploads: [], runs: [], timers: new Map() };
    states.set(ws.workspace.id, s);
  }
  return s;
}

const CHUNK = 20;
const TICK = 350;

// A cell as the import takes it: an export's formula guard (a ' before = + - @ tab or CR) comes off,
// so an exported file imports as it was.
const cellValue = (v: string) => {
  const t = v.trim();
  return (/^'[=+\-@\t\r]/.test(t) ? t.slice(1) : t).trim();
};

function parseCsv(text: string): string[][] {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const first = t.split(/\r?\n/, 1)[0] ?? "";
  const sep = [",", ";", "\t"].sort((a, b) => first.split(b).length - first.split(a).length)[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

const aliases: Record<keyof Omit<ContactImportMapping, "fields">, string[]> = {
  email: ["email", "email address", "e mail", "mail"],
  name: ["name", "full name", "contact name", "customer"],
  phone: ["phone", "phone number", "mobile", "telephone"],
  company: ["company", "organization", "organisation", "account"],
  external_id: ["external id", "customer id", "user id", "id"],
  notes: ["notes", "note", "comments"],
  labels: ["labels", "tags", "label", "tag"],
};
const norm = (h: string) => h.toLowerCase().replace(/[\s_\-.]+/g, " ").trim();

function suggest(header: string[]): ContactImportMapping {
  const out: ContactImportMapping = {};
  const used = new Set<number>();
  for (const [field, names] of Object.entries(aliases) as [keyof typeof aliases, string[]][]) {
    for (const n of names) {
      const i = header.findIndex((h, k) => !used.has(k) && norm(h) === n);
      if (i >= 0) {
        used.add(i);
        out[field] = header[i];
        break;
      }
    }
  }
  return out;
}

function publishRun(ws: WsData, x: ContactImport) {
  publish(ws, "contact_import.updated", { import: x }, { topics: [`user:${db.meId}`] });
}

function finish(ws: WsData, run: Run, status: ContactImport["status"], error = "") {
  const s = stateOf(ws);
  clearInterval(s.timers.get(run.x.id));
  s.timers.delete(run.x.id);
  run.x.status = status;
  run.x.error = error;
  run.x.finished_at = nowIso();
  publishRun(ws, run.x);
}

function tick(ws: WsData, run: Run) {
  const { x, upload, mapping } = run;
  if (x.status !== "running") return;
  const col = (rec: string[], name?: string) => {
    const i = name ? upload.header.indexOf(name) : -1;
    return i >= 0 ? cellValue(rec[i] ?? "") : "";
  };
  const end = Math.min(x.processed + CHUNK, x.total);
  for (let i = x.processed; i < end; i++) {
    const rec = upload.data[i]!;
    try {
      const labels = col(rec, mapping.labels).split(/[,;|]/);
      const r = importPerson(
        ws,
        { email: col(rec, mapping.email), name: col(rec, mapping.name), phone: col(rec, mapping.phone), company: col(rec, mapping.company), external_id: col(rec, mapping.external_id), notes: col(rec, mapping.notes), labels },
        x.match_on,
        x.on_match,
      );
      x[r]++;
    } catch (e) {
      x.failed++;
      if (x.errors.length < 50) x.errors.push({ line: run.lines[i]!, message: e instanceof HttpError ? e.message : "This row could not be saved." });
    }
  }
  x.processed = end;
  if (end >= x.total) finish(ws, run, "done");
  else publishRun(ws, x);
}

export function registerContactImports() {
  post("/v1/contacts/import/upload", async (ctx) => {
    const f = ctx.form?.get("file");
    if (!(f instanceof File)) throw invalid("file is required");
    if (!/\.(csv|tsv|txt)$/i.test(f.name)) throw new HttpError(422, "file_type_refused", "Upload a .csv file. Spreadsheets can save one with File, then Download or Export, as CSV.");
    const [header, ...rows] = parseCsv(await f.text());
    if (!header || !rows.length) throw new HttpError(422, "csv_unreadable", "The file has no rows under its header.");
    const up: Upload = {
      upload_id: uuid(),
      filename: f.name,
      rows: rows.length,
      columns: header.map((name, i) => ({ name, samples: rows.map((r) => cellValue(r[i] ?? "")).filter(Boolean).slice(0, 3).map((v) => v.slice(0, 80)) })),
      suggested: suggest(header),
      header,
      data: rows,
    };
    stateOf(ctx.ws).uploads.push(up);
    const { header: _h, data: _d, ...out } = up;
    return respond(201, out);
  });

  post("/v1/contacts/imports", (ctx) => {
    const b = ctx.body as { upload_id: string; mapping: ContactImportMapping; match_on: ContactImportMatch; on_match: ContactImportOnMatch };
    const s = stateOf(ctx.ws);
    const upload = s.uploads.find((u) => u.upload_id === b.upload_id);
    if (!upload) throw new HttpError(404, "not_found", "The uploaded file is gone. Upload it again.");
    const m = b.mapping ?? {};
    for (const c of [m.name, m.email, m.phone, m.company, m.external_id, m.notes, m.labels]) {
      if (c && !upload.header.includes(c)) throw invalid(`The file has no column called ${c}.`);
    }
    if (!m.email && !m.name) throw invalid("Map at least a name or an email column.");
    if (b.match_on === "email" && !m.email) throw invalid("Map an email column to find people by email.");
    if (b.match_on === "external_id" && !m.external_id) throw invalid("Map an external id column to find people by it.");
    if (s.runs.filter((r) => r.x.status === "running").length >= 2) throw new HttpError(409, "conflict", "Two imports are already running. Wait for one to finish.");
    const x: ContactImport = {
      id: uuid(),
      filename: upload.filename,
      status: "running",
      match_on: b.match_on,
      on_match: b.on_match,
      total: upload.rows,
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      error: "",
      created_at: nowIso(),
      finished_at: null,
    };
    const run: Run = { x, upload, mapping: m, lines: upload.data.map((_, i) => i + 2) };
    s.runs.unshift(run);
    s.uploads = s.uploads.filter((u) => u !== upload);
    s.timers.set(x.id, setInterval(() => tick(ctx.ws, run), TICK));
    return respond(201, structuredClone(x));
  });

  get("/v1/contacts/imports", (ctx) => ({ data: stateOf(ctx.ws).runs.map((r) => r.x) }));
  get("/v1/contacts/imports/:id", (ctx) => {
    const run = stateOf(ctx.ws).runs.find((r) => r.x.id === ctx.params.id);
    if (!run) throw notFound("Import");
    return structuredClone(run.x);
  });
  post("/v1/contacts/imports/:id/cancel", (ctx) => {
    const run = stateOf(ctx.ws).runs.find((r) => r.x.id === ctx.params.id);
    if (!run) throw notFound("Import");
    if (run.x.status === "running") finish(ctx.ws, run, "cancelled");
    return respond(200, structuredClone(run.x));
  });
}
