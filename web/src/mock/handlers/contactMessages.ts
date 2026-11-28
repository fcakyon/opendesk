// Messages to many customers in mock mode (contracts/api.md "Messages to many customers"): who a
// send reaches, the send itself, one ticket for each customer made a few at a time so the
// progress shows, and stopping it. Tickets are made by the mock's own POST /v1/tickets.

import type { Contact, ContactMessage, NoticePreview } from "@/lib/api/types";
import { db, type WsData } from "../db";
import { publish } from "../gateway";
import { HttpError, dispatch, get, invalid, notFound, post, respond, type Ctx } from "../router";
import { isRecord, nowIso, stripHtml, uuid } from "../util";
import { canSendFrom } from "../tickets";

const CHUNK = 5;
const PAUSE = 700;
const PER_DAY = 10;

const store = new WeakMap<WsData, ContactMessage[]>();
const messagesOf = (ws: WsData) => {
  let m = store.get(ws);
  if (!m) store.set(ws, (m = []));
  return m;
};

/** Who a target names: the ids, or the People list's filters (at most 1000). */
function named(ws: WsData, body: Record<string, unknown>): Contact[] {
  const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const query = isRecord(body.query) ? body.query : null;
  if ((ids.length === 0) === !query) throw invalid("send either ids or query");
  if (ids.length > 100) throw invalid("ids: at most 100");
  if (!query) {
    const found = ids.map((id) => ws.contacts.find((c) => c.id === id));
    if (found.some((c) => !c)) throw notFound("Contact");
    return [...new Set(found as Contact[])];
  }
  const needle = String(query.q ?? "").toLowerCase().trim();
  const hit = ws.contacts.filter(
    (c) =>
      (!needle || [c.name, c.email ?? "", c.company?.name ?? "", c.phone].join(" ").toLowerCase().includes(needle)) &&
      (!query.company_id || (query.company_id === "none" ? !c.company : c.company?.id === query.company_id)) &&
      (!query.tag || c.tags.some((x) => x.name.toLowerCase() === String(query.tag).toLowerCase())) &&
      (!query.blocked || c.blocked === (query.blocked === "true")),
  );
  if (hit.length > 1000) throw new HttpError(422, "too_many_records", "That filter matches more than 1000 records. Narrow it and try again.");
  return hit;
}

function classify(contacts: Contact[]): { reach: Contact[]; skipped: NoticePreview["skipped"] } {
  const skipped: NoticePreview["skipped"] = {};
  const reach: Contact[] = [];
  for (const c of contacts) {
    if (c.blocked) skipped.blocked = (skipped.blocked ?? 0) + 1;
    else if (!c.email) skipped.no_email = (skipped.no_email ?? 0) + 1;
    else reach.push(c);
  }
  return { reach, skipped };
}

function tell(ws: WsData, m: ContactMessage) {
  publish(ws, "contact_message.updated", { contact_message: m }, { topics: [`user:${db.meId}`] });
}

/** Makes the next few tickets, then waits and goes on, until everyone was reached or it was stopped. */
async function run(ws: WsData, m: ContactMessage, contacts: Contact[], body: { subject: string; body_html: string; mailbox_id: string }) {
  for (let i = 0; i < contacts.length && m.state === "sending"; i += CHUNK) {
    for (const c of contacts.slice(i, i + CHUNK)) {
      if (m.state !== "sending") break;
      const r = await dispatch("http://mock/v1/tickets", {
        method: "POST",
        headers: { "OD-Workspace": ws.workspace.id },
        body: JSON.stringify({ subject: body.subject, body_html: body.body_html, contact_id: c.id, mailbox_id: body.mailbox_id, channel: "email", status: m.status, tags: [m.label], notice: true }),
      });
      if (r.ok) m.sent++;
      else {
        m.failed++;
        m.last_error = ((await r.json().catch(() => null)) as { detail?: string } | null)?.detail ?? "A ticket could not be created.";
      }
    }
    tell(ws, m);
    if (i + CHUNK < contacts.length && m.state === "sending") await new Promise((res) => setTimeout(res, import.meta.env.MODE === "test" ? 0 : PAUSE));
  }
  if (m.state === "sending") {
    m.state = "done";
    m.finished_at = nowIso();
    tell(ws, m);
  }
}

export function registerContactMessageRoutes() {
  post("/v1/contacts/message/preview", (ctx) => {
    const { reach, skipped } = classify(named(ctx.ws, ctx.body));
    const out: NoticePreview = { reaches: reach.length, skipped };
    return out;
  });

  post("/v1/contacts/message", (ctx) => {
    const ws = ctx.ws;
    const b = ctx.body;
    const subject = typeof b.subject === "string" ? b.subject.trim() : "";
    const html = typeof b.body_html === "string" ? b.body_html : "";
    const label = typeof b.label === "string" ? b.label.trim() : "";
    const status = b.status === "open" || b.status === "pending" ? b.status : "solved";
    if (!subject) throw invalid("subject is required");
    if (!stripHtml(html).trim() && !html.includes("<img")) throw invalid("body_html is required");
    if (!label || label.length > 50 || !/^[\p{L}\p{N} _\-./:&+#]+$/u.test(label)) throw invalid("label must be 1 to 50 characters of letters, numbers and - _ . / : & + #");
    const box = ws.mailboxes.find((m) => m.id === b.mailbox_id);
    if (!box) throw invalid("mailbox_id must be an address of the workspace");
    if (!canSendFrom(ws, box, db.meId)) throw new HttpError(403, "forbidden", "Only members of its team can send from this address.");
    const { reach, skipped } = classify(named(ws, b));
    if (reach.length === 0) throw new HttpError(422, "no_recipients", "Nobody in this selection can be reached: they have no email address or are blocked.");
    const all = messagesOf(ws);
    if (all.some((m) => m.state === "sending")) throw new HttpError(409, "message_in_progress", "Another message to many customers is still being sent. Wait for it to finish or stop it.");
    if (all.filter((m) => Date.now() - Date.parse(m.created_at) < 864e5).length >= PER_DAY) throw new HttpError(429, "rate_limited", "This workspace sent 10 messages to many customers in the last day. Try again later.");
    const m: ContactMessage = {
      id: uuid(),
      subject,
      label,
      status,
      state: "sending",
      mailbox_id: box.id,
      created_by: db.meId,
      total: reach.length,
      sent: 0,
      failed: 0,
      last_error: "",
      skipped,
      created_at: nowIso(),
      finished_at: null,
    };
    all.unshift(m);
    tell(ws, m);
    void run(ws, m, reach, { subject, body_html: html, mailbox_id: box.id });
    return respond(202, m);
  });

  get("/v1/contact-messages", (ctx) => ({ data: messagesOf(ctx.ws).slice(0, 20) }));

  post("/v1/contact-messages/:id/cancel", (ctx: Ctx) => {
    const m = messagesOf(ctx.ws).find((x) => x.id === ctx.params.id);
    if (!m) throw notFound("Message");
    if (m.state === "sending") {
      m.state = "cancelled";
      m.finished_at = nowIso();
      tell(ctx.ws, m);
    }
    return m;
  });
}
