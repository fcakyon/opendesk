// WhatsApp numbers on Meta's Cloud API, their templates and a WhatsApp ticket's window
// (contracts/whatsapp.md). The demo Meta app takes the access token "demo" with any numeric
// ids; anything else is refused as Meta would.

import type { Message, Ticket, WhatsAppTicketState } from "@/lib/api/types";
import type { WsData } from "../db";
import { db, userRef } from "../db";
import { lastInbound, WHATSAPP_WINDOW, whatsappConnection, whatsappTemplates } from "../whatsapp";
import { addMessage } from "../tickets";
import { del, get, HttpError, invalid, notFound, patch, post, respond } from "../router";
import { publish } from "../gateway";
import { nowIso } from "../util";

const placeholders = (body: string) => [...new Set([...body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!))];
const fill = (body: string, params: Record<string, string>) => body.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, k: string) => params[k] ?? match);

type Creds = { phone_number_id?: string; waba_id?: string; access_token?: string; app_secret?: string; api_version?: string };

/** Checks pasted credentials as the server does, then "asks Meta". */
function checkCreds(c: Creds | undefined) {
  if (!c?.phone_number_id?.trim() || !c.waba_id?.trim() || !c.access_token?.trim() || !c.app_secret?.trim())
    throw invalid("Provide the phone number ID, WhatsApp Business account ID, access token and app secret.");
  if (!/^[0-9]+$/.test(c.phone_number_id.trim()) || !/^[0-9]+$/.test(c.waba_id.trim()))
    throw invalid("The phone number ID and WhatsApp Business account ID are numbers. Copy them from WhatsApp > API Setup in your Meta app.");
  if (c.api_version?.trim() && !/^v[0-9]{1,3}\.[0-9]{1,3}$/.test(c.api_version.trim())) throw invalid("The API version looks like v23.0. Leave it empty to use the default.");
  if (c.access_token.trim() !== "demo") throw new HttpError(422, "whatsapp_credentials_refused", "Meta rejected these credentials: Invalid OAuth access token.");
}

/** A WhatsApp ticket's connection and window, as the server will send. */
export function whatsappState(ws: WsData, t: Ticket): WhatsAppTicketState {
  const number = ws.whatsappThreads[t.id];
  const c = number ? ws.whatsapp.find((x) => x.phone_number_id === number) : undefined;
  const last = number ? lastInbound(ws, t.id) : null;
  const closes = last === null ? null : last + WHATSAPP_WINDOW;
  return {
    connection_id: c?.id ?? null,
    connection_name: c?.name ?? "",
    display_phone_number: c?.display_phone_number ?? "",
    window_open: !!c && closes !== null && Date.now() < closes,
    window_closes_at: closes === null ? null : new Date(closes).toISOString(),
  };
}

/** Refuses a free-form WhatsApp reply the server would refuse. */
export function checkWhatsAppReply(ws: WsData, t: Ticket, attachments: number) {
  if (!ws.whatsappThreads[t.id]) throw new HttpError(409, "whatsapp_no_conversation", "This ticket has no WhatsApp conversation to reply on.");
  const st = whatsappState(ws, t);
  if (!st.connection_id) throw new HttpError(409, "whatsapp_disconnected", "This ticket's WhatsApp number is not connected. Connect it again in Settings > WhatsApp to reply.");
  if (!st.window_open) throw new HttpError(422, "whatsapp_window_closed", "The 24-hour WhatsApp reply window has closed. Send a template, or wait for the customer to message again.");
  if (attachments > 1) throw invalid("WhatsApp takes one file per message. Send the files one at a time.");
}

/** Sent, then delivered to the phone, then read: Meta's receipts, which only move forward. */
export function simulateWhatsAppDelivery(ws: WsData, t: Ticket, msg: Message) {
  msg.delivery_status = "pending";
  const step = (status: "sent" | "delivered" | "read", after: number) =>
    setTimeout(() => {
      const m = ws.messages.find((x) => x.id === msg.id);
      if (!m || m.delivery_status === "failed") return;
      m.delivery_status = "sent";
      m.delivery_error = "";
      m.delivery_meta = { ...(m.delivery_meta ?? {}), provider_status: status };
      publish(ws, "message.updated", { ticket_id: t.id, message: m });
    }, after);
  step("sent", 1200);
  step("delivered", 3200);
  step("read", 6500);
}

export function registerWhatsApp() {
  const connection = (ws: WsData, id: string) => {
    const row = ws.whatsapp.find((c) => c.id === id);
    if (!row) throw notFound("WhatsApp connection");
    return row;
  };
  get("/v1/whatsapp/connections", (ctx) => ({ data: ctx.ws.whatsapp }));
  post("/v1/whatsapp/connections", (ctx) => {
    const b = ctx.body as { name?: string; brand_id?: string; credentials?: Creds };
    checkCreds(b.credentials);
    const number = b.credentials!.phone_number_id!.trim();
    if (ctx.ws.whatsapp.some((c) => c.phone_number_id === number)) throw new HttpError(409, "conflict", "This workspace already has a WhatsApp connection for that phone number.");
    const row = whatsappConnection({
      name: b.name?.trim() || "Margin Sales",
      phone_number_id: number,
      waba_id: b.credentials!.waba_id!.trim(),
      api_version: b.credentials!.api_version?.trim() || "v26.0",
      display_phone_number: "+44 7700 900123",
      verified_name: "Margin Sales",
      last_event_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    ctx.ws.whatsapp.push(row);
    ctx.ws.whatsappTemplates.push(...whatsappTemplates(row.id));
    return respond(201, row);
  });
  patch("/v1/whatsapp/connections/:id", (ctx) => {
    const row = connection(ctx.ws, ctx.params.id!);
    const b = ctx.body as { name?: string; credentials?: Creds };
    if (b.credentials) {
      checkCreds(b.credentials);
      if (b.credentials.phone_number_id!.trim() !== row.phone_number_id)
        throw invalid("These credentials belong to a different phone number. Disconnect this connection and connect the other number instead.");
      Object.assign(row, { status: "connected", last_error: "" });
    }
    if (b.name?.trim()) row.name = b.name.trim();
    row.updated_at = nowIso();
    return row;
  });
  post("/v1/whatsapp/connections/:id/test", (ctx) => Object.assign(connection(ctx.ws, ctx.params.id!), { status: "connected", last_error: "", updated_at: nowIso() }));
  post("/v1/whatsapp/connections/:id/subscribe", (ctx) => Object.assign(connection(ctx.ws, ctx.params.id!), { updated_at: nowIso() }));
  del("/v1/whatsapp/connections/:id", (ctx) => {
    connection(ctx.ws, ctx.params.id!);
    ctx.ws.whatsapp = ctx.ws.whatsapp.filter((c) => c.id !== ctx.params.id);
    ctx.ws.whatsappTemplates = ctx.ws.whatsappTemplates.filter((x) => x.connection_id !== ctx.params.id);
    return respond(204, null);
  });
  get("/v1/whatsapp/templates", (ctx) => {
    const cid = ctx.query.get("connection_id");
    return { data: ctx.ws.whatsappTemplates.filter((x) => !cid || x.connection_id === cid) };
  });
  post("/v1/whatsapp/templates/sync", (ctx) => {
    const cid = (ctx.body as { connection_id?: string } | undefined)?.connection_id;
    const data = ctx.ws.whatsappTemplates.filter((x) => !cid || x.connection_id === cid);
    return { data, synced: data.length };
  });
  get("/v1/tickets/:id/whatsapp", (ctx) => {
    const t = ctx.ws.tickets.find((x) => x.id === ctx.params.id);
    if (!t) throw notFound("Ticket");
    if (t.channel !== "whatsapp") throw new HttpError(422, "not_whatsapp_ticket", "This ticket is not a WhatsApp conversation.");
    return whatsappState(ctx.ws, t);
  });
  post("/v1/tickets/:id/whatsapp-template", (ctx) => {
    const t = ctx.ws.tickets.find((x) => x.id === ctx.params.id);
    if (!t) throw notFound("Ticket");
    if (t.channel !== "whatsapp") throw new HttpError(422, "not_whatsapp_ticket", "This ticket is not a WhatsApp conversation.");
    const st = whatsappState(ctx.ws, t);
    if (!st.connection_id) throw new HttpError(409, "whatsapp_disconnected", "This ticket's WhatsApp number is not connected. Connect it again in Settings > WhatsApp to reply.");
    const b = ctx.body as { template_id?: string; params?: Record<string, string>; header_text?: string; header_media_id?: string; button_urls?: Record<string, string> };
    const tpl = ctx.ws.whatsappTemplates.find((x) => x.id === b.template_id);
    if (!tpl) throw notFound("WhatsApp template");
    if (tpl.connection_id !== st.connection_id) throw invalid("That template belongs to another WhatsApp connection.");
    if (tpl.status.toUpperCase() !== "APPROVED") throw new HttpError(422, "whatsapp_template_not_approved", "This template is still waiting for Meta's review.");
    const missing = placeholders(tpl.body_content).filter((k) => !b.params?.[k]?.trim());
    if (missing.length) throw new HttpError(422, "whatsapp_template_params_missing", `Fill in the template's variables: ${missing.map((k) => `{{${k}}}`).join(", ")}.`);
    const media = (tpl.header_type ?? "").toUpperCase();
    const file = b.header_media_id ? db.attachments.find((a) => a.id === b.header_media_id) : undefined;
    if ((media === "IMAGE" || media === "VIDEO" || media === "DOCUMENT") && !file)
      throw new HttpError(422, "whatsapp_template_file_missing", "Upload the file for this template's header, or pick one from this ticket.");
    const m = addMessage(ctx.ws, t, {
      kind: "reply",
      direction: "outbound",
      html: `<p>${fill(tpl.body_content, b.params ?? {})}</p>`,
      user: userRef(db.meId),
      attachments: file ? [file] : [],
      delivery: "pending",
    });
    m.delivery_meta = { whatsapp_template: { id: tpl.id, name: tpl.name, language: tpl.language, body: tpl.body_content, params: b.params ?? {}, header_type: media || undefined } };
    simulateWhatsAppDelivery(ctx.ws, t, m);
    return respond(201, m);
  });
}
