// The demo workspace's WhatsApp number on Meta's Cloud API, its synced templates and two
// customers who wrote to it (contracts/whatsapp.md): one whose 24 hour window is open, one
// whose window has closed.

import type { Contact, UserRef, WhatsAppConnection, WhatsAppTemplate } from "@/lib/api/types";
import type { WsData } from "./db";
import { addMessage, newTicket } from "./tickets";
import { uuid } from "./util";

const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Meta's customer service window: free-form replies for 24 hours after the customer's latest message. */
export const WHATSAPP_WINDOW = 24 * HOUR;

export function whatsappConnection(over: Partial<WhatsAppConnection> = {}): WhatsAppConnection {
  const id = uuid();
  return {
    id,
    name: "Margin Support",
    phone_number_id: "106540352242922",
    waba_id: "102290129340398",
    display_phone_number: "+1 415-555-0100",
    verified_name: "Margin Support",
    api_version: "v26.0",
    status: "connected",
    last_error: "",
    last_event_at: iso(Date.now() - 20 * 60_000),
    webhook_url: `https://api.opendesk.sh/v1/whatsapp/hooks/${id}`,
    created_at: iso(Date.now() - 12 * 24 * HOUR),
    updated_at: iso(Date.now() - HOUR),
    ...over,
  };
}

/** What Meta has approved, and not yet, for a connection's WhatsApp Business account. */
export function whatsappTemplates(connectionId: string): WhatsAppTemplate[] {
  const at = iso(Date.now() - 2 * 24 * HOUR);
  const tpl = (over: Partial<WhatsAppTemplate> & Pick<WhatsAppTemplate, "name" | "body_content">): WhatsAppTemplate => ({
    id: uuid(),
    connection_id: connectionId,
    language: "en_US",
    category: "UTILITY",
    status: "APPROVED",
    buttons: [],
    created_at: at,
    updated_at: at,
    ...over,
  });
  return [
    tpl({ name: "follow_up", body_content: "Hi {{1}}, did our answer about {{2}} help?" }),
    tpl({ name: "order_shipped", header_type: "TEXT", header_content: "Order {{1}}", body_content: "Hi {{1}}, your order has shipped.", footer_content: "Margin" }),
    tpl({
      name: "invoice_ready",
      header_type: "DOCUMENT",
      body_content: "Hi {{1}}, here is your corrected invoice.",
      buttons: [{ type: "URL", text: "View account", url: "https://margin.example/account/{{1}}" }],
    }),
    tpl({ name: "spring_sale", category: "MARKETING", status: "PENDING", body_content: "Spring sale: 20% off this week." }),
    tpl({ name: "promo_es", language: "es", category: "MARKETING", status: "REJECTED", body_content: "Oferta especial" }),
  ];
}

function customer(ws: WsData, name: string, phone: string): Contact {
  const c: Contact = {
    id: uuid(),
    email: null,
    emails: [],
    name,
    phone,
    avatar_url: null,
    avatar_source: null,
    company: null,
    external_id: null,
    notes: "",
    custom: {},
    tags: [],
    fields: {},
    blocked: false,
    ticket_count: 1,
    created_at: iso(Date.now() - 3 * 24 * HOUR),
    updated_at: iso(Date.now() - HOUR),
  };
  ws.contacts.push(c);
  return c;
}

/** A message of a conversation: from the customer or not, its words and, for ours, how far it got. */
type Line = [inbound: boolean, text: string] | [inbound: boolean, text: string, status: "read" | "delivered" | "sent"];

export function seedWhatsApp(ws: WsData, agent: UserRef) {
  const c = whatsappConnection();
  ws.whatsapp = [c];
  ws.whatsappTemplates = whatsappTemplates(c.id);
  const talk = (name: string, phone: string, subject: string, hoursAgo: number, lines: Line[]) => {
    const ct = customer(ws, name, phone);
    const start = Date.now() - hoursAgo * HOUR;
    const t = newTicket(ws, {
      subject,
      contact: { id: ct.id, email: null, name: ct.name, avatar_url: null },
      channel: "whatsapp",
      mailbox_id: null,
      assignee: agent,
      created_at: iso(start),
    });
    ws.whatsappThreads[t.id] = c.phone_number_id;
    lines.forEach(([inbound, text, status], i) => {
      const m = addMessage(
        ws,
        t,
        { kind: "reply", direction: inbound ? "inbound" : "outbound", html: `<p>${text}</p>`, user: inbound ? null : agent, at: iso(start + i * 4 * 60_000), delivery: inbound ? "none" : "sent" },
        { publish: false },
      );
      if (!inbound) m.delivery_meta = { provider_status: status ?? "read" };
    });
  };
  talk("Mateo Ibarra-Silva", "+34 612 345 678", "Do you ship to Austria?", 1.2, [
    [true, "Hi! Do you ship to Austria?"],
    [false, "Hello Mateo, yes we do. Delivery takes 3 to 5 working days.", "read"],
    [true, "Great, and is the VAT included?"],
  ]);
  talk("Ana Souza-Lindqvist", "+55 11 91234 5678", "My invoice is wrong", 30, [
    [true, "My invoice is wrong, the VAT number is missing."],
    [false, "Thanks Ana, I will send a corrected invoice today.", "delivered"],
  ]);
}

/** The customer's latest WhatsApp message on a ticket: the 24 hour window counts from it. */
export function lastInbound(ws: WsData, ticketId: string): number | null {
  const times = ws.messages.filter((m) => m.ticket_id === ticketId && m.direction === "inbound" && m.kind === "reply").map((m) => Date.parse(m.created_at));
  return times.length ? Math.max(...times) : null;
}
