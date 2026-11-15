// Settings → Views on the mock API: a view moves to another section, or out of its own, from
// its menu ("Move to section"), with one PATCH per view that moved; Alt+arrows still reorder;
// a view the person may not write offers neither.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { ConfirmProvider } from "@/components/ui/confirm";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { Role, View } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { groupViews } from "@/lib/viewSections";
import { installMock } from "@/mock";
import { db } from "@/mock/db";
import Views from "./Views";

vi.mock("@tanstack/react-router", async (load) => {
  const actual = await load<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useSearch: () => ({}),
    useNavigate: () => () => Promise.resolve(),
    Link: ({ to, children, ...props }: React.ComponentProps<"a"> & { to: string }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

/** The views as the page lists them: loose views by name, a section as [Name] and its views. */
const read = (vs: View[]) => groupViews(vs).map((e) => (e.kind === "view" ? e.view.name : `[${e.name}] ${e.views.map((v) => v.name).join(", ")}`));

describe("moving views between sections in Settings → Views", () => {
  installMock();
  const ws = db.workspaces[0];
  let saved: View[] = [];
  let savedIcons: typeof ws.viewSectionIcons;
  let root: Root;
  let el: HTMLDivElement;
  const patches: { id: string; body: unknown }[] = [];

  beforeEach(() => {
    saved = structuredClone(ws.views);
    savedIcons = structuredClone(ws.viewSectionIcons);
    patches.length = 0;
    // Count the PATCHes the page sends, on their way to the mock API.
    const update = api.views.update;
    vi.spyOn(api.views, "update").mockImplementation((id, body) => {
      patches.push({ id, body });
      return update(id, body);
    });
    el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
  });
  afterEach(() => {
    ws.views = saved;
    ws.viewSectionIcons = savedIcons;
    vi.restoreAllMocks();
    act(() => root.unmount());
    el.remove();
  });

  const mount = async (role: Role = "admin") => {
    const user = db.users.find((u) => u.id === db.meId);
    useSession.setState({ status: "authed", workspaceId: ws.workspace.id, user, memberships: [{ workspace: ws.workspace, role }] } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <ConfirmProvider>
              <Views />
            </ConfirmProvider>
          </TooltipProvider>
        </QueryClientProvider>,
      ),
    );
    for (let i = 0; i < 100 && !el.textContent?.includes("Legal requests due"); i++) await settle();
  };

  const named = (name: string) => ws.views.find((v) => v.name === name)!;

  /** Opens a view's "…" menu and its "Move to section" submenu; the submenu's items. */
  const openMove = async (name: string) => {
    const trigger = el.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`)!;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    await settle();
    const sub = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((x) => x.textContent === "Move to section");
    if (!sub) return null;
    await act(async () => {
      sub.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    return [...document.querySelectorAll<HTMLElement>("[role='menu']")].at(-1)!;
  };
  const pick = async (menu: HTMLElement, label: string) => {
    const item = [...menu.querySelectorAll<HTMLElement>("[role='menuitem']")].find((x) => x.textContent === label);
    expect(item).toBeDefined();
    await act(async () => item!.click());
    for (let i = 0; i < 10; i++) await settle();
  };

  it("moves a loose view to the end of a section from its menu, numbering the views in order", async () => {
    await mount();
    expect(read(ws.views)).toEqual(["Urgent", "Billing queue", "[Escalations] Waiting on engineering, Legal requests due"]);
    const menu = await openMove("Urgent");
    expect([...menu!.querySelectorAll("[role='menuitem']")].map((x) => x.textContent)).toEqual(["Escalations"]);
    await pick(menu!, "Escalations");
    expect(read(ws.views)).toEqual(["Billing queue", "[Escalations] Waiting on engineering, Legal requests due, Urgent"]);
    expect(named("Urgent")).toMatchObject({ section: "Escalations", position: 3 });
    // One PATCH per view that moved: the moved view's section and position, the others' position.
    expect(patches).toEqual(
      expect.arrayContaining([
        { id: named("Urgent").id, body: { position: 3, section: "Escalations" } },
        { id: named("Billing queue").id, body: { position: 0 } },
        { id: named("Waiting on engineering").id, body: { position: 1 } },
        { id: named("Legal requests due").id, body: { position: 2 } },
      ]),
    );
    expect(patches).toHaveLength(4);
    // The page reads it at once, and says so to screen readers.
    const group = el.querySelector("[role='group'][aria-label='In section Escalations']")!;
    expect(group.textContent).toContain("Urgent");
    expect(el.querySelector("[aria-live='polite']")?.textContent).toBe("Urgent moved to the Escalations section");
  });

  it("takes a view out of its section, to right after it", async () => {
    await mount();
    const menu = await openMove("Waiting on engineering");
    await pick(menu!, "No section");
    expect(read(ws.views)).toEqual(["Urgent", "Billing queue", "[Escalations] Legal requests due", "Waiting on engineering"]);
    expect(named("Waiting on engineering").section).toBeNull();
    expect(patches).toContainEqual({ id: named("Waiting on engineering").id, body: { position: 3, section: null } });
    expect(el.querySelector("[aria-live='polite']")?.textContent).toBe("Waiting on engineering moved out of its section");
  });

  it("heads a section with its grip, its icon and, for admins, its edit button, and a view moved in takes the icon", async () => {
    // As PATCH /v1/view-sections leaves them: the icon kept for the name and on its views.
    const icon = { kind: "text", value: "ES", color: "red" } as const;
    ws.viewSectionIcons = { escalations: icon };
    for (const v of ws.views) if (v.section === "Escalations") v.section_icon = icon;
    await mount();
    const header = () => el.querySelector("[role='group'][aria-label='In section Escalations']")!.firstElementChild!;
    expect(header().querySelector("button[aria-label^='Reorder the Escalations section']")).not.toBeNull();
    expect(header().querySelector("[data-view-icon='text']")?.textContent).toBe("ES");
    const edit = header().querySelector<HTMLButtonElement>("button[aria-label='Edit the Escalations section']")!;
    expect(edit).not.toBeNull();
    await act(async () => edit.click());
    await settle();
    expect(document.querySelector<HTMLInputElement>("[role='dialog'] input")?.value).toBe("Escalations");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();

    // The move menu shows the section as its heading does, and the moved view carries the icon.
    const menu = await openMove("Urgent");
    const item = [...menu!.querySelectorAll<HTMLElement>("[role='menuitem']")].find((x) => x.textContent?.endsWith("Escalations"))!;
    expect(item.querySelector("[data-view-icon='text']")?.textContent).toBe("ES");
    await act(async () => item.click());
    for (let i = 0; i < 10; i++) await settle();
    expect(named("Urgent")).toMatchObject({ section: "Escalations", section_icon: { kind: "text", value: "ES" } });
    expect(header().querySelector("[data-view-icon='text']")?.textContent).toBe("ES");
  });

  it("offers an agent no edit button on a section heading", async () => {
    await mount("agent");
    expect(el.querySelector("[role='group'][aria-label='In section Escalations']")).not.toBeNull();
    expect(el.querySelector("button[aria-label='Edit the Escalations section']")).toBeNull();
  });

  it("still reorders within a list with Alt and the arrow keys", async () => {
    await mount();
    const grip = el.querySelector<HTMLButtonElement>("button[aria-label^='Reorder Legal requests due']")!;
    await act(async () => {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
    });
    for (let i = 0; i < 10; i++) await settle();
    expect(read(ws.views)).toEqual(["Urgent", "Billing queue", "[Escalations] Legal requests due, Waiting on engineering"]);
    expect(patches.every((p) => !("section" in (p.body as object)))).toBe(true);
  });

  it("offers an agent neither a move nor a grip on a view only admins write", async () => {
    await mount("agent");
    // Urgent is shared: admins write it.
    expect(el.querySelector("button[aria-label^='Reorder Urgent']")).toBeNull();
    expect(await openMove("Urgent")).toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // Their own view moves.
    expect(el.querySelector("button[aria-label^='Reorder Waiting on engineering']")).not.toBeNull();
  });
});
