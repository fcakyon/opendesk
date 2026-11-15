// The demo workspace's Aircall connection and a caller whose calls are on their ticket
// (contracts/phone.md): an answered call with its recording, summary and comment, then a
// missed call outside opening hours that the automation reopened.

import type { Activity, CallData, Contact, PhoneConnection, UserRef } from "@/lib/api/types";
import type { WsData } from "./db";
import { addActivity, addMessage, newTicket } from "./tickets";
import { uuid } from "./util";

const HOUR = 3600_000;

export function phoneConnection(over: Partial<PhoneConnection> = {}): PhoneConnection {
  const id = uuid();
  const at = new Date(Date.now() - 20 * 24 * HOUR).toISOString();
  return {
    id,
    provider: "aircall",
    name: "Margin support line",
    account_name: "Margin",
    status: "connected",
    last_error: "",
    health_status: "healthy",
    health_code: "receiving",
    health_detail: "Calls are sent to opendesk.",
    health_checked_at: new Date(Date.now() - 2 * HOUR).toISOString(),
    reuse_days: 7,
    assign_answered: true,
    insight_cards: true,
    last_event_at: new Date(Date.now() - 40 * 60_000).toISOString(),
    webhook_url: `https://api.opendesk.sh/v1/phone/hooks/aircall/${id}`,
    created_at: at,
    ...over,
  };
}

/** A call entry's data, filled from a few facts. */
export function callData(over: Partial<CallData>): CallData {
  return {
    call_id: uuid(),
    provider: "aircall",
    direction: "inbound",
    stage: "ended",
    outcome: "answered",
    missed_reason: "",
    number: "",
    line: "",
    line_id: "",
    caller_name: "",
    agent: null,
    agent_name: "",
    started_at: null,
    answered_at: null,
    ended_at: null,
    duration: 0,
    recording: false,
    voicemail: false,
    asset_url: "",
    recording_url: "",
    voicemail_url: "",
    links_expire_at: null,
    tags: [],
    comments: [],
    summary: "",
    transcript: "",
    outside_hours: false,
    ...over,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A business day's afternoon `days` ago, at hh:mm local time. */
function dayAt(days: number, h: number, m: number) {
  const d = new Date(Date.now() - days * 24 * HOUR);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

export function seedPhone(ws: WsData, agent: UserRef) {
  ws.phone = [phoneConnection()];
  const contact: Contact = {
    id: uuid(),
    email: null,
    emails: [],
    name: "Lena Hoffmann",
    phone: "+32 470 00 00 00",
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
    created_at: iso(dayAt(3, 14, 18)),
    updated_at: iso(dayAt(1, 19, 43)),
  };
  ws.contacts.push(contact);
  const answeredAt = dayAt(2, 14, 21);
  const t = newTicket(ws, {
    subject: "Call from Lena Hoffmann",
    contact: { id: contact.id, email: null, name: contact.name, avatar_url: null },
    channel: "phone",
    mailbox_id: null,
    assignee: agent,
    created_at: iso(answeredAt - 30_000),
  });
  const entry = (at: number, data: CallData): Activity => {
    const a = addActivity(ws, t, "call", data as unknown as Record<string, unknown>, null, iso(at), false);
    a.actor = { type: "system", user: null };
    return a;
  };
  entry(
    answeredAt - 30_000,
    callData({
      number: "+32470000000",
      caller_name: "Lena Hoffmann",
      line: "DE - Support",
      line_id: "501",
      agent,
      agent_name: agent.name,
      started_at: iso(answeredAt - 30_000),
      answered_at: iso(answeredAt),
      ended_at: iso(answeredAt + 252_000),
      duration: 282,
      recording: true,
      asset_url: "https://assets.aircall.io/calls/1290001/recording",
      tags: ["Export"],
      comments: [{ id: "77", text: "Export cache cleared, follow up on Friday.", author: agent.name }],
      summary: "Lena could not export her notebooks to PDF since the last update. The export cache was cleared and the export worked again; she calls back if it fails.",
      transcript:
        "Agent: Margin support, this is " + agent.name.split(" ")[0] + ".\nCustomer: Hi, my PDF exports stopped working after the update.\nAgent: Let's clear the export cache together.\nCustomer: That worked, thank you!",
    }),
  );
  addActivity(ws, t, "status_changed", { from: "open", to: "solved" }, agent, iso(answeredAt + 300_000), false);
  t.status = "solved";

  const missedAt = dayAt(1, 19, 42);
  entry(
    missedAt,
    callData({
      outcome: "missed",
      missed_reason: "out_of_opening_hours",
      number: "+32470000000",
      caller_name: "Lena Hoffmann",
      line: "DE - Support",
      line_id: "501",
      started_at: iso(missedAt),
      ended_at: iso(missedAt + 6_000),
      duration: 6,
      outside_hours: true,
    }),
  );
  const auto = { automation_name: "Missed call outside opening hours" };
  const automation = (type: string, data: Record<string, unknown>, at: number) => {
    const a = addActivity(ws, t, type, { ...data, ...auto }, null, iso(at), false);
    a.actor = { type: "automation", user: null };
  };
  automation("status_changed", { from: "solved", to: "open" }, missedAt + 31_000);
  automation("priority_changed", { from: "normal", to: "high" }, missedAt + 31_000);
  addMessage(ws, t, { kind: "note", direction: "outbound", html: "<p>Missed call outside opening hours: call back.</p>", at: iso(missedAt + 31_000) }, { publish: false });
  t.status = "open";
  t.priority = "high";
  t.solved_at = null;
  t.updated_at = iso(missedAt + 31_000);
  t.last_message_preview = "Missed call from Lena Hoffmann";
  t.sla = null;

  ws.automations.push({
    id: uuid(),
    name: "Missed call outside opening hours",
    trigger: "call_ended",
    conditions: [
      { field: "call_direction", op: "equals", value: "inbound" },
      { field: "call_outcome", op: "equals", value: "missed" },
      { field: "call_time", op: "equals", value: "outside_business_hours" },
    ],
    actions: [
      { type: "set_status", value: "open" },
      { type: "add_note", value: "<p>Missed call outside opening hours: call back.</p>" },
      { type: "set_priority", value: "high" },
    ],
    enabled: true,
    position: ws.automations.length,
    run_count: 18,
  });
  return t;
}
