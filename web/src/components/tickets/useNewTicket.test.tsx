import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useShell } from "@/app/shellStore";
import type { Contact } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { draftKey, newTicketDrafts } from "./newTicket";
import { useNewTicketFor, useStartChat } from "./useNewTicket";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ada = { id: "ct-ada", name: "Ada Lovelace", email: "ada@example.com", chat_reachable: true } as Contact;
const key = draftKey("u-me", "w-1");

let host: HTMLDivElement;
let root: Root;
let open: { newTicket: (c?: Contact) => void; chat: (c?: Contact) => void };

beforeEach(async () => {
  useSession.setState({ user: { id: "u-me" }, workspaceId: "w-1" } as never);
  useShell.setState({ newTicketOpen: false });
  newTicketDrafts.clear(key);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Harness() {
    open = { newTicket: useNewTicketFor(), chat: useStartChat() };
    return null;
  }
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("opens the new ticket dialog as an email to the contact", () => {
  act(() => open.newTicket(ada));
  expect(useShell.getState().newTicketOpen).toBe(true);
  expect(newTicketDrafts.get(key)).toMatchObject({ to: { contact: ada }, kind: "reply", channel: "email" });
});

it("turns a draft left on chat or on a note back to an email, keeping what was written", () => {
  act(() => open.chat(ada));
  newTicketDrafts.patch(key, { subject: "Your order", body: "<p>Hello</p>" });
  act(() => open.newTicket(ada));
  expect(newTicketDrafts.get(key)).toMatchObject({ kind: "reply", channel: "email", subject: "Your order", body: "<p>Hello</p>" });
  newTicketDrafts.patch(key, { kind: "note" });
  act(() => open.newTicket(ada));
  expect(newTicketDrafts.get(key)).toMatchObject({ kind: "reply", channel: "email" });
});

it("still opens a chat with the contact", () => {
  act(() => open.chat(ada));
  expect(useShell.getState().newTicketOpen).toBe(true);
  expect(newTicketDrafts.get(key)).toMatchObject({ to: { contact: ada }, kind: "reply", channel: "chat" });
});
