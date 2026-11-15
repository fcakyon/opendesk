// The customer portal in mock mode (contracts/customer-portal.md): one signed-in customer with
// two requests, and the new-request route. The session is always live; there is no password to give.

import { HttpError, get, invalid, notFound, post, respond } from "../router";
import { db } from "../db";
import { nowIso, uuid } from "../util";

type PortalTicket = { id: string; number: number; subject: string; status: string; created_at: string; updated_at: string };
type PortalFile = { id: string; filename: string; content_type: string; size_bytes: number; url: string };
type PortalMessage = { id: string; direction: "inbound" | "outbound"; body_text: string; created_at: string; attachments: PortalFile[] };

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const tickets: PortalTicket[] = [
  { id: uuid(), number: 1048, subject: "Invoice shows the wrong billing address", status: "pending", created_at: ago(3 * 864e5), updated_at: ago(864e5) },
  { id: uuid(), number: 1031, subject: "Where do I find the API key?", status: "solved", created_at: ago(12 * 864e5), updated_at: ago(10 * 864e5) },
];
const messages = new Map<string, PortalMessage[]>([
  [tickets[0].id, [
    { id: uuid(), direction: "inbound", body_text: "Our invoice still shows the old address. Can you update it?", created_at: ago(3 * 864e5), attachments: [] },
    { id: uuid(), direction: "outbound", body_text: "Thanks for letting us know. Could you send the new address?", created_at: ago(864e5), attachments: [] },
  ]],
  [tickets[1].id, [{ id: uuid(), direction: "inbound", body_text: "Where do I find the API key?", created_at: ago(12 * 864e5), attachments: [] }]],
]);
let created = 0;
/** What a customer uploaded and has not sent yet, by id. */
const uploads = new Map<string, PortalFile>();

function brandBySlug(slug: string) {
  for (const w of db.workspaces) {
    const b = w.brands.find((x) => x.slug === slug && x.help_center.enabled);
    if (b) return b;
  }
  return undefined;
}

export function registerPortalRoutes() {
  get("/v1/public/help/:slug/portal/config", (ctx) => {
    const b = brandBySlug(String(ctx.params.slug));
    if (!b) throw notFound("Help center");
    return { title: b.help_center.title || `${b.name} Help`, logo_url: b.images.help_center_logo || b.images.logo, color: b.color, locale: b.locale, locale_fixed: false, help_url: b.help_center.url };
  });
  post("/v1/customer/portal/auth/refresh", () => {
    // The client reads only the subject from the token; the server is what validates it.
    const payload = btoa(JSON.stringify({ sub: "mock-customer" }));
    return { access_token: `mock.${payload}.sig`, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() };
  });
  get("/v1/customer/portal/tickets", () => ({ data: tickets.slice().sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)), next_cursor: null }));
  get("/v1/customer/portal/tickets/:id", (ctx) => {
    const t = tickets.find((x) => x.id === ctx.params.id);
    if (!t) throw notFound("Ticket");
    return t;
  });
  get("/v1/customer/portal/tickets/:id/messages", (ctx) => {
    if (!tickets.some((x) => x.id === ctx.params.id)) throw notFound("Ticket");
    return { data: messages.get(String(ctx.params.id)) ?? [], next_cursor: null };
  });
  post("/v1/customer/portal/attachments", (ctx) => {
    const file = ctx.form?.get("file");
    if (!(file instanceof File) || file.size === 0) throw invalid("the file is empty");
    if (file.size > 10 << 20) throw new HttpError(413, "too_large", "Files can be at most 10 MB.");
    if (/\.(exe|sh|bat|cmd|js)$/i.test(file.name)) throw new HttpError(422, "file_type_refused", "Executable files and scripts cannot be attached.");
    const id = uuid();
    const f: PortalFile = { id, filename: file.name, content_type: file.type || "application/octet-stream", size_bytes: file.size, url: URL.createObjectURL(file) };
    uploads.set(id, f);
    return respond(201, { ...f, inline: false });
  });
  post("/v1/customer/portal/tickets", (ctx) => {
    const subject = String(ctx.body.subject ?? "").split(/\s+/).filter(Boolean).join(" ");
    const body = String(ctx.body.body ?? "").trim();
    if (!subject || !body || subject.length > 200 || body.length > 10000) throw invalid("Add a subject and describe your request.");
    if (!brandBySlug(String(ctx.body.workspace_slug ?? ""))) throw notFound("Help center");
    const requested = Array.isArray(ctx.body.attachment_ids) ? (ctx.body.attachment_ids as string[]) : [];
    if (requested.length > 5) throw new HttpError(422, "too_many_files", "A request can carry at most 5 files.");
    const files = requested.map((id) => uploads.get(id));
    if (files.some((f) => !f)) throw invalid("attachment_ids must be your own unsent uploads");
    requested.forEach((id) => uploads.delete(id));
    if (++created > 10) throw new HttpError(429, "rate_limited", "Too many requests. Wait a moment and try again.");
    const now = nowIso();
    const t: PortalTicket = { id: uuid(), number: Math.max(...tickets.map((x) => x.number)) + 1, subject, status: "open", created_at: now, updated_at: now };
    tickets.push(t);
    messages.set(t.id, [{ id: uuid(), direction: "inbound", body_text: body, created_at: now, attachments: files as PortalFile[] }]);
    return respond(201, t);
  });
}
