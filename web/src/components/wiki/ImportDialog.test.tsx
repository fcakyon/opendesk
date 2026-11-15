import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { Team, WikiImportResult, WikiNode } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { openImport } from "@/app/quickAdd";
import { ImportDialogHost } from "./ImportDialog";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) => select({ location: { pathname: "/wiki" } }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const node = (over: Partial<WikiNode>): WikiNode => ({ id: "p1", parent_id: null, title: "Runbooks", icon: "", position: 0, version: 1, updated_at: "2026-11-01T00:00:00Z", created_by_id: null, tags: [], ...over });

let host: HTMLDivElement;
let root: Root;
let qc: QueryClient;

async function render() {
  useSession.setState({ workspaceId: "w1", user: { id: "me" } as never, memberships: [{ workspace: { id: "w1" } as never, role: "agent" }] });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.wikiTree, [node({}), node({ id: "db1", title: "Issues", kind: "database", position: 1 })]);
  qc.setQueryData(qk.teams, [{ id: "t1", name: "Billing", private: false, member_ids: [], color: "blue" } as unknown as Team, { id: "t2", name: "Secret", private: true, member_ids: [], color: "red" } as unknown as Team]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ImportDialogHost />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
}

const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
const button = (name: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === name);
async function pick(files: File[]) {
  const input = dialog()!.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

describe("wiki import dialog", () => {
  beforeEach(() => navigate.mockReset());
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("imports under the page it was opened from, then shows what came in and what was left out", async () => {
    const result: WikiImportResult = {
      pages: 3,
      root_ids: ["n1", "n2"],
      skipped: [
        { path: "img/unused.png", reason: "unused" },
        { path: "deep/page.md", reason: "moved_up" },
        { path: "img/other.png", reason: "unused" },
      ],
    };
    const spy = vi.spyOn(api.wiki, "importPages").mockImplementation(async (_files, _to, onProgress) => {
      onProgress?.(0.5);
      return result;
    });
    await render();
    await act(async () => openImport("p1"));
    expect(dialog()?.textContent).toContain("Import pages");
    expect(button("Import")?.disabled).toBe(true);
    await pick([new File(["# A"], "a.md"), new File(["x"], "photo.png")]);
    expect(dialog()?.querySelector("[role=alert]")?.textContent).toContain("photo.png can't be imported");
    expect(dialog()?.textContent).toContain("Under Runbooks");
    await act(async () => button("Import")!.click());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].map((f) => f.name)).toEqual(["a.md"]);
    expect(spy.mock.calls[0][1]).toEqual({ parent_id: "p1" });
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Imported 3 pages");
    expect(text).toContain("3 files were left out or changed");
    expect(text.indexOf("Moved up a level")).toBeLessThan(text.indexOf("Not used by any page"));
    expect(qc.getQueryState(qk.wikiTree)?.isInvalidated).toBe(true);
    await act(async () => button("Open")!.click());
    expect(navigate).toHaveBeenCalledWith({ to: "/wiki/$pageId", params: { pageId: "n1" } });
  });

  it("shows the API's message inline and keeps the files to try again", async () => {
    vi.spyOn(api.wiki, "importPages").mockRejectedValue(new ApiError({ status: 422, code: "wiki_full", detail: "This import makes 40 pages and the wiki has room for 12 more." }));
    await render();
    await act(async () => openImport());
    // Opened from no page, or from a database: the top of the workspace.
    expect(dialog()?.textContent).not.toContain("Under ");
    await pick([new File(["# A"], "a.md")]);
    await act(async () => button("Import")!.click());
    expect(dialog()?.querySelector("[role=alert]")?.textContent).toBe("This import makes 40 pages and the wiki has room for 12 more.");
    expect(dialog()?.textContent).toContain("a.md");
    expect(button("Import")?.disabled).toBe(false);
  });

  it("starts with the files dropped elsewhere, at the top of the space they were dropped for", async () => {
    const spy = vi.spyOn(api.wiki, "importPages").mockResolvedValue({ pages: 1, root_ids: ["n1"], skipped: [] });
    await render();
    await act(async () => openImport(null, { files: [new File(["# A"], "a.md"), new File(["x"], "run.exe")], space: "team:t1" }));
    expect(dialog()?.textContent).toContain("a.md");
    expect(dialog()?.querySelector("[role=alert]")?.textContent).toContain("run.exe can't be imported");
    await act(async () => button("Import")!.click());
    expect(spy.mock.calls[0][0].map((f) => f.name)).toEqual(["a.md"]);
    // Dropped from no page: Pages', while the workspace has it on (contracts/pages.md).
    expect(spy.mock.calls[0][1]).toEqual({ space: "team", team_id: "t1", area: "pages" });
  });

  it("refuses more than 100 MB before uploading", async () => {
    await render();
    await act(async () => openImport("db1"));
    expect(dialog()?.textContent).not.toContain("Under Issues");
    const big = new File(["x"], "vault.zip");
    Object.defineProperty(big, "size", { value: 101 << 20 });
    await pick([big]);
    expect(dialog()?.querySelector("[role=alert]")?.textContent).toContain("over 100 MB");
    expect(button("Import")?.disabled).toBe(true);
  });
});
