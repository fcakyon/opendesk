import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@/i18n";
import { api } from "@/lib/api/endpoints";
import type { CompanyRef } from "@/lib/api/types";
import { useRole } from "@/lib/session";
import { CompanyPicker } from "./CompanyPicker";

vi.mock("@/lib/api/endpoints", () => ({ api: { companies: { search: vi.fn(), create: vi.fn() } } }));
vi.mock("@/lib/session", async (orig) => {
  const mod = await orig<typeof import("@/lib/session")>();
  return { ...mod, useRole: vi.fn(() => "agent") };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const acme = { id: "co-acme", name: "Acme", domain: "acme.com", avatar_url: null };
const search = vi.mocked(api.companies.search);
const create = vi.mocked(api.companies.create);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // jsdom lays nothing out: cmdk measures its list and scrolls to the selected item.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  vi.mocked(useRole).mockReturnValue("agent");
  search.mockImplementation(async ({ q } = {}) => ({ data: !q || "acme".includes(q.toLowerCase()) ? [acme] : [], next_cursor: null }) as never);
  create.mockImplementation(async (b) => ({ ...acme, id: "co-new", name: b.name, domain: b.domain }) as never);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 260)));

async function mount() {
  const seen: (CompanyRef | null)[] = [];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [value, setValue] = useState<CompanyRef | null>(null);
    return (
      <CompanyPicker
        value={value}
        onChange={(c) => {
          seen.push(c);
          setValue(c);
        }}
      />
    );
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
    ),
  );
  const trigger = host.querySelector("button")!;
  await act(async () => trigger.click());
  await settle();
  return { seen, trigger };
}

async function type(value: string) {
  const input = document.querySelector<HTMLInputElement>("[cmdk-input]")!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The picker searches 200 ms after the last keystroke; its answer renders on the next tick.
  await settle();
  await settle();
}

const items = () => [...document.querySelectorAll("[cmdk-item]")].map((i) => i.textContent?.trim());

it("offers to create a company the search does not find, and picks it once created", async () => {
  const { seen, trigger } = await mount();
  await type("Northwind");
  const entry = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((i) => i.textContent?.includes("Create company"));
  expect(entry?.textContent).toContain("“Northwind”");
  await act(async () => entry!.click());
  await settle();
  expect(create).toHaveBeenCalledWith({ name: "Northwind", domain: "", notes: "" });
  expect(seen.at(-1)).toMatchObject({ id: "co-new", name: "Northwind" });
  expect(trigger.textContent).toContain("Northwind");
  // Like picking an existing company, the list closes.
  expect(document.querySelector("[cmdk-input]")).toBeNull();
});

it("offers no create entry while the search runs, nor once it finds the company", async () => {
  await mount();
  let answer: () => void = () => {};
  search.mockImplementationOnce(() => new Promise((resolve) => (answer = () => resolve({ data: [acme], next_cursor: null } as never))));
  await type("acme");
  expect(search).toHaveBeenLastCalledWith({ q: "acme", limit: 12 });
  expect(items().some((t) => t?.includes("Create company"))).toBe(false);
  await act(async () => answer());
  await settle();
  expect(items().some((t) => t?.includes("Acme"))).toBe(true);
  expect(items().some((t) => t?.includes("Create company"))).toBe(false);
});

it("offers no create entry to a viewer", async () => {
  vi.mocked(useRole).mockReturnValue("viewer");
  await mount();
  await type("Northwind");
  expect(items().some((t) => t?.includes("Create company"))).toBe(false);
});
