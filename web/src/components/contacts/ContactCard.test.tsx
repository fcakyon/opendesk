import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { loadAgentCatalogs } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { Contact, CustomerPastTicket } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { ContactCard } from "./ContactCard";

vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  api: {
    contacts: { get: vi.fn(), tickets: vi.fn() },
    tickets: { customerTickets: vi.fn() },
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const contact: Contact = {
  id: "c1",
  email: "alex@example.test",
  emails: [],
  name: "Alex",
  phone: "",
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
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
} as unknown as Contact;

const row = (id: string, subject: string, owner: CustomerPastTicket["contact"]): CustomerPastTicket => ({
  id,
  number: 100,
  subject,
  status: "solved",
  channel: "email",
  message_count: 3,
  last_message_at: "2026-11-10T10:00:00Z",
  contact: owner,
});

const customerTickets = vi.mocked(api.tickets.customerTickets);
const contactTickets = vi.mocked(api.contacts.tickets);
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => loadAgentCatalogs("en"));
beforeEach(() => {
  vi.mocked(api.contacts.get).mockResolvedValue(contact);
  contactTickets.mockResolvedValue({
    data: [{ id: "t1", number: 1, subject: "Order question", status: "open", message_count: 4, last_message_at: "2026-11-19T10:00:00Z" }],
    next_cursor: null,
  } as never);
  customerTickets.mockResolvedValue({
    data: [
      row("t9", "Earlier, from work", { id: "c2", name: "Alex at work", email: "alex.work@example.test" }),
      row("t5", "Earlier, same address", { id: "c1", name: "Alex", email: "alex@example.test" }),
    ],
    total: 2,
  });
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
};

async function render(excludeTicketId?: string) {
  useSession.setState({ workspaceId: "w1", memberships: [{ workspace: { id: "w1" }, role: "agent" }] } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: Outlet });
  const ticket = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox/$folder/{-$ticketId}",
    component: () => <ContactCard contactId="c1" compact excludeTicketId={excludeTicketId} />,
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([ticket]), history: createMemoryHistory({ initialEntries: ["/inbox/open/t1"] }) });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => act(async () => root.unmount()));
  await router.load();
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const count = () => [...document.querySelectorAll("span.tabular-nums")].map((e) => e.textContent);

it("lists the customer's tickets from every address in a ticket, naming the other address, with the count of the others", async () => {
  await render("t1");
  expect(customerTickets).toHaveBeenCalledWith("t1");
  expect(contactTickets).not.toHaveBeenCalled();
  const text = document.body.textContent ?? "";
  expect(text).toContain("Earlier, from work");
  expect(text).toContain("Earlier, same address");
  expect(text).not.toContain("No other tickets");
  expect([...document.querySelectorAll("[title]")].map((e) => e.getAttribute("title"))).toContain("alex.work@example.test");
  expect(document.querySelector('[title="alex@example.test"]')).toBeNull();
  expect(count()).toContain("2");
});

it("says there are none, with 0, when the customer has no other ticket", async () => {
  customerTickets.mockResolvedValue({ data: [], total: 0 });
  await render("t1");
  expect(document.body.textContent).toContain("No other tickets");
  expect(count()).toContain("0");
});

it("falls back to the contact's own tickets when the answer fails", async () => {
  customerTickets.mockRejectedValue(new Error("boom"));
  await render("t2");
  expect(contactTickets).toHaveBeenCalledWith("c1", expect.anything());
  expect(document.body.textContent).toContain("Order question");
});

it("lists the contact's own tickets outside a ticket", async () => {
  await render(undefined);
  expect(customerTickets).not.toHaveBeenCalled();
  expect(contactTickets).toHaveBeenCalledWith("c1", expect.anything());
  expect(document.body.textContent).toContain("Order question");
  expect(count()).toContain("1");
});
