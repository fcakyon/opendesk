import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeAll, expect, it } from "vitest";
import { loadAgentCatalogs } from "@/i18n";
import type { Availability, Member, Role, Team } from "@/lib/api/types";
import { filterMembers, memberCounts, parseMemberSearch } from "@/lib/memberFilters";
import { MemberFilterBar, useMemberFilters } from "./MemberFilterBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

function member(id: string, name: string, role: Role, presence: Availability): Member {
  return {
    user: { id, name, email: `${name.toLowerCase()}@example.test`, avatar_url: null, avatar_source: null },
    role,
    availability: presence,
    presence,
    max_open_tickets: null,
    open_tickets: 0,
    last_seen_at: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}
const members = [member("u1", "Maya", "owner", "online"), member("u2", "Jonas", "admin", "away"), member("u3", "Priya", "agent", "online"), member("u4", "Omar", "agent", "offline")];
const teams = [{ id: "billing", name: "Billing", color: "blue", private: false, members: [{ user_id: "u2", role: "member" }, { user_id: "u3", role: "member" }] }] as Team[];

/** The bar over the list it filters, as the Members page wires them. */
function Page() {
  const state = useMemberFilters();
  const shown = filterMembers(members, state.filters, teams);
  return (
    <>
      <MemberFilterBar state={state} counts={memberCounts(members, teams)} teams={teams} shown={shown.length} total={members.length} />
      <ul>
        {shown.map((m) => (
          <li key={m.user.id}>{m.user.name}</li>
        ))}
      </ul>
    </>
  );
}

const cleanups: (() => Promise<void>)[] = [];
beforeAll(() => loadAgentCatalogs("en"));
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  document.body.innerHTML = "";
});

async function render(href: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({ getParentRoute: () => rootRoute, path: "/settings/members", validateSearch: parseMemberSearch, component: Page });
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: [href] }), defaultPendingMinMs: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => act(async () => root.unmount()));
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

const names = () => [...document.querySelectorAll("li")].map((li) => li.textContent);
const trigger = (prefix: string) => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.startsWith(prefix))!;
const settle = (ms = 20) => act(() => new Promise((r) => setTimeout(r, ms)));
const params = (router: Awaited<ReturnType<typeof render>>) => Object.fromEntries(new URLSearchParams(router.state.location.searchStr));

/** Opens a filter's picker unless it is open (a multi picker stays open), and chooses an option. */
async function pick(triggerPrefix: string, option: string) {
  if (trigger(triggerPrefix).getAttribute("aria-expanded") !== "true") await act(async () => trigger(triggerPrefix).click());
  const item = [...document.querySelectorAll("[cmdk-item]")].find((el) => el.textContent?.startsWith(option)) as HTMLElement;
  expect(item, option).toBeDefined();
  await act(async () => item.click());
  await settle();
}

async function closePicker() {
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
  expect(document.querySelector("[cmdk-item]")).toBeNull();
}

async function type(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[role="searchbox"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("reads the filters from the URL", async () => {
  await render("/settings/members?role=agent&team=billing");
  expect(names()).toEqual(["Priya"]);
  expect(trigger("Role:").getAttribute("aria-label")).toBe("Role: Agent");
  expect(trigger("Team:").getAttribute("aria-label")).toBe("Team: Billing");
  expect(trigger("Status:").getAttribute("aria-label")).toBe("Status: Any status");
  expect(document.body.textContent).toContain("1 of 4");
});

it("writes a picked role and status to the URL, and Back undoes it", async () => {
  const router = await render("/settings/members");
  expect(names()).toEqual(["Maya", "Jonas", "Priya", "Omar"]);
  await pick("Role:", "Agent");
  expect(params(router)).toEqual({ role: "agent" });
  expect(names()).toEqual(["Priya", "Omar"]);
  await pick("Role:", "Owner");
  expect(params(router)).toEqual({ role: "owner,agent" });
  await closePicker();
  await pick("Status:", "Online");
  expect(params(router)).toEqual({ role: "owner,agent", status: "online" });
  expect(names()).toEqual(["Maya", "Priya"]);
  await act(async () => router.history.back());
  await settle();
  expect(params(router)).toEqual({ role: "owner,agent" });
  expect(names()).toEqual(["Maya", "Priya", "Omar"]);
});

it("offers members on no team", async () => {
  const router = await render("/settings/members");
  await pick("Team:", "No team");
  expect(params(router)).toEqual({ team: "none" });
  expect(names()).toEqual(["Maya", "Omar"]);
});

it("filters as the search is typed and puts it in the URL once typing stops, in place", async () => {
  const router = await render("/settings/members?status=online");
  const before = router.history.length;
  await type("pri");
  expect(names()).toEqual(["Priya"]);
  await settle(300);
  expect(params(router)).toEqual({ status: "online", q: "pri" });
  expect(router.history.length).toBe(before);
});

it("clears every filter, the search included", async () => {
  const router = await render("/settings/members?q=zzz&role=viewer");
  expect(names()).toEqual([]);
  const clear = [...document.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!;
  await act(async () => clear.click());
  await settle();
  expect(params(router)).toEqual({});
  await settle(300);
  expect(params(router)).toEqual({});
  expect(document.querySelector<HTMLInputElement>('input[role="searchbox"]')!.value).toBe("");
  expect(names()).toEqual(["Maya", "Jonas", "Priya", "Omar"]);
  expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Clear filters")).toBe(false);
});
