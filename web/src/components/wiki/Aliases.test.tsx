import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { WikiNode, WikiPage } from "@/lib/api/types";
import { q, qk } from "@/lib/queries";
import { AliasChips, cleanAliases } from "./Aliases";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const page = (aliases: string[]): WikiPage => ({ id: "p1", title: "Refund policy", aliases }) as WikiPage;

let host: HTMLDivElement | undefined;
let root: Root;
let qc: QueryClient;

/** The chips with the cache's page, as the page view reads it through its query. */
function Harness({ canEdit, variant }: { canEdit: boolean; variant: "title" | "panel" }) {
  const [adding, setAdding] = useState(false);
  const { data } = useQuery(q.wikiPage("p1"));
  return data ? <AliasChips page={data} canEdit={canEdit} adding={adding} onAdding={setAdding} variant={variant} /> : null;
}

async function open(aliases: string[], canEdit = true, variant: "title" | "panel" = "panel") {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.wikiPage("p1"), page(aliases));
  qc.setQueryData<WikiNode[]>(qk.wikiTree, [{ id: "p1", title: "Refund policy", aliases } as WikiNode]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <Harness canEdit={canEdit} variant={variant} />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
}

/** Lets the query cache tell its readers (it does so on a timer). */
const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
const chips = () => [...host!.querySelectorAll("[role=group] > span.group\\/alias")].map((c) => c.textContent);
const press = (el: Element, key: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
function type(input: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("alias chips", () => {
  beforeEach(() => {
    vi.spyOn(api.wiki, "update").mockImplementation(async (_id, b) => page(b.aliases ?? []));
  });
  afterEach(async () => {
    if (!host) return void vi.restoreAllMocks();
    await act(async () => root.unmount());
    host!.remove();
    vi.restoreAllMocks();
  });

  it("cleans aliases as the API does", () => {
    expect(cleanAliases([" Money  back ", "money back", "", "Returns", "x".repeat(120)])).toEqual(["Money back", "Returns", "x".repeat(100)]);
    expect(cleanAliases(Array.from({ length: 12 }, (_, i) => `n${i}`))).toHaveLength(10);
  });

  it("shows nothing under the title without aliases, and 'Also called' with them", async () => {
    await open([], true, "title");
    expect(host!.textContent).toBe("");
    await act(async () => root.unmount());
    host!.remove();
    await open(["Money back"], false, "title");
    expect(host!.textContent).toContain("Also called");
    expect(chips()).toEqual(["Money back"]);
    expect(host!.querySelector("button")).toBeNull();
  });

  it("adds with Enter, keeps the field for the next, removes with a chip's button, and saves each", async () => {
    await open(["Money back"]);
    await act(async () => (host!.querySelector("button[aria-label='Add alias']") as HTMLButtonElement).click());
    const input = host!.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      type(input, "  Returns ");
      press(input, "Enter");
    });
    expect(api.wiki.update).toHaveBeenLastCalledWith("p1", { aliases: ["Money back", "Returns"] });
    expect(chips()).toEqual(["Money back", "Returns"]);
    expect(qc.getQueryData<WikiNode[]>(qk.wikiTree)?.[0].aliases).toEqual(["Money back", "Returns"]);
    expect(host!.querySelector("input")).toBeTruthy();
    // The same name again, in another case, changes nothing.
    await act(async () => {
      type(host!.querySelector("input")!, "returns");
      press(host!.querySelector("input")!, "Enter");
    });
    expect(api.wiki.update).toHaveBeenCalledTimes(1);
    await act(async () => press(host!.querySelector("input")!, "Escape"));
    expect(host!.querySelector("input")).toBeNull();
    await act(async () => (host!.querySelector("button[aria-label='Remove the alias Money back']") as HTMLButtonElement).click());
    expect(api.wiki.update).toHaveBeenLastCalledWith("p1", { aliases: ["Returns"] });
    await settle();
    expect(chips()).toEqual(["Returns"]);
  });

  it("puts the aliases back when the save fails", async () => {
    vi.mocked(api.wiki.update).mockRejectedValue(new Error("offline"));
    await open(["Money back"]);
    await act(async () => (host!.querySelector("button[aria-label='Remove the alias Money back']") as HTMLButtonElement).click());
    await settle();
    expect(api.wiki.update).toHaveBeenCalledWith("p1", { aliases: [] });
    expect(chips()).toEqual(["Money back"]);
  });

  it("offers no more than 10", async () => {
    await open(Array.from({ length: 10 }, (_, i) => `name ${i}`));
    expect(host!.querySelector("button[aria-label='Add alias']")).toBeNull();
    expect(host!.textContent).toContain("A page has up to 10 aliases.");
  });
});
