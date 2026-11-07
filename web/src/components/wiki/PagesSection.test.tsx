import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { quickAdd, useQuickAdd } from "@/app/quickAdd";
import { api } from "@/lib/api/endpoints";
import type { Team, WikiNode, WikiPage } from "@/lib/api/types";
import { defaultSidebarPrefs } from "@/lib/collab/sidebarPrefs";
import { qk } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { NewPageDialog } from "./NewPageDialog";
import { PagesSection } from "./PagesSection";

const navigate = vi.fn();
// The open page, a subpage: its parent opens so it is in view.
const OPEN = "22222222-2222-4222-8222-222222222222";
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) => select({ location: { pathname: `/pages/${OPEN}`, search: {} } }),
  Link: ({ children, to, params, activeProps: _a, activeOptions: _o, ...rest }: { children: ReactNode | ((s: { isActive: boolean }) => ReactNode); to: string; params?: Record<string, string>; activeProps?: unknown; activeOptions?: unknown }) => (
    <a href={params?.pageId ? to.replace("$pageId", params.pageId) : to} {...rest}>
      {typeof children === "function" ? children({ isActive: false }) : children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout: the tree scrolls its open page into view.
Element.prototype.scrollIntoView ??= () => {};

const node = (over: Partial<WikiNode>): WikiNode => ({ id: "p1", parent_id: null, title: "Runbooks", icon: "", position: 0, version: 1, updated_at: "2026-11-01T00:00:00Z", created_by_id: null, tags: [], area: "pages", ...over });
// Pages' tree (contracts/pages.md), and a wiki page the section leaves out.
const tree = [
  node({ id: "w1", title: "Wiki runbook", area: "wiki" }),
  node({}),
  node({ id: OPEN, parent_id: "p1", title: "Refunds" }),
  node({ id: "p3", title: "Old notes", position: 1 }),
  node({ id: "db", title: "Issues", kind: "database", position: 2 }),
  node({ id: "row", parent_id: "db", title: "A row of Issues" }),
  node({ id: "t", title: "Billing runbook", team_id: "t1" }),
  node({ id: "mine", title: "My drafts", private: true }),
];
const billing = { id: "t1", name: "Billing", private: false, member_ids: ["me"], members: [], color: "blue" } as unknown as Team;

let host: HTMLDivElement;
let root: Root;

async function render(ui: ReactNode) {
  useSession.setState({ workspaceId: "w1", user: { id: "me" } as never, memberships: [{ workspace: { id: "w1" } as never, role: "agent" }] });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.wikiTree, tree);
  qc.setQueryData(qk.wikiFavorites, []);
  qc.setQueryData(qk.wikiTemplates, []);
  qc.setQueryData(qk.teams, [billing]);
  qc.setQueryData(qk.brands, []);
  qc.setQueryData(qk.mailboxes, []);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>{ui}</TooltipProvider>
      </QueryClientProvider>,
    ),
  );
}

const rows = () => [...host.querySelectorAll("[role=treeitem]")].map((r) => r.getAttribute("aria-label"));

describe("the Pages section", () => {
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    useQuickAdd.setState({ newPage: null, importing: null });
  });

  it("shows the workspace's pages, each teamspace and the private pages, without a database's rows or hidden pages", async () => {
    await render(<PagesSection prefs={{ ...defaultSidebarPrefs(), hidden: ["wiki_page:p3"] }} rail={false} first />);
    // The open page's ancestors open, so it is in view.
    expect(rows()).toEqual(["Runbooks", "Refunds", "Issues", "Billing runbook", "My drafts"]);
    expect(host.textContent).toContain("Billing");
    expect(host.textContent).toContain("Private");
    expect(host.textContent).toContain("Templates");
    expect(host.textContent).toContain("Trash");
  });

  it("leaves out the parts the member hid", async () => {
    await render(<PagesSection prefs={{ ...defaultSidebarPrefs(), hidden: ["pages:teamspaces", "pages:private", "pages:trash"] }} rail={false} first />);
    expect(rows()).toEqual(["Runbooks", "Refunds", "Old notes", "Issues"]);
    expect(host.textContent).not.toContain("Private");
    expect(host.textContent).not.toContain("Trash");
  });

  it("is one link to Pages in the rail", async () => {
    await render(<PagesSection prefs={defaultSidebarPrefs()} rail first />);
    expect(rows()).toEqual([]);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/pages");
  });

  it("opens the new page popup from its +, and the import with files dropped on it", async () => {
    await render(<PagesSection prefs={defaultSidebarPrefs()} rail={false} first />);
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-label='New page']")!.click());
    expect(useQuickAdd.getState().newPage).toEqual({ space: undefined, area: "pages" });
    const file = new File(["# A"], "a.md");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [file] } });
    await act(async () => host.querySelector("[data-wiki-sidebar]")!.dispatchEvent(drop));
    expect(useQuickAdd.getState().importing).toMatchObject({ parentId: null, files: [file], area: "pages" });
  });
});

describe("the new page popup", () => {
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    useQuickAdd.setState({ newPage: null });
  });

  it("makes a database in the space it was opened for, then closes", async () => {
    const create = vi.spyOn(api.wiki, "create").mockResolvedValue({ ...node({ id: "new", kind: "database" }), body_html: "" } as unknown as WikiPage);
    quickAdd.page("team:t1");
    await render(<NewPageDialog />);
    const dialog = document.body.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.textContent).toContain("Billing");
    const database = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Database"))!;
    await act(async () => database.click());
    // It adds to Pages (contracts/pages.md), and the new page opens there.
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: "database", space: "team", team_id: "t1", area: "pages" }));
    expect(useQuickAdd.getState().newPage).toBeNull();
    expect(navigate).toHaveBeenCalledWith({ to: "/pages/$pageId", params: { pageId: "new" } });
  });
});
