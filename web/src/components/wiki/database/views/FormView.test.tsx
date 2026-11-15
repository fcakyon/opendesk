import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { loadAgentCatalogs } from "@/i18n";
import type { Database, DbRow, DbView } from "@/lib/api/types";
import { ann, bob, NOW, row, tasksDb } from "@/lib/wiki/db/fixtures";
import type { ViewProps } from "../DatabaseView";
import FormView from "./FormView";
import { withComposer } from "./nesting";
import { arrowPath } from "./TimelineView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => loadAgentCatalogs("en"));
afterEach(() => {
  document.body.innerHTML = "";
});

const view: DbView = {
  id: "form",
  name: "Report",
  type: "form",
  settings: { form: { title: "Report a bug", description: "Tell us what broke", fields: [{ property: "title", help: "One line" }, { property: "notes", required: true }, { property: "points" }], submitted: "Thanks, we'll look." } },
};
const db: Database = { ...tasksDb, views: [view] };

async function render(canEdit: boolean) {
  const onCreate = vi.fn<ViewProps["onCreate"]>(async (_values, opts) => row("new", opts?.title ?? ""));
  const p = {
    databaseId: "db",
    db,
    view,
    rows: [],
    allRows: [],
    props: [],
    ctx: { db, rowsByDb: new Map<string, DbRow[]>([["db", []]]), members: new Map([ann, bob].map((u) => [u.id, u])), now: NOW },
    canEdit,
    sorted: false,
    onOpen: vi.fn(),
    onUpdate: vi.fn(),
    onRename: vi.fn(),
    onCreate,
    onTrash: vi.fn(),
    onMove: vi.fn(),
    onAddOption: vi.fn(),
    onSchema: vi.fn(),
    onSettings: vi.fn(),
  } satisfies ViewProps;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <FormView {...p} />
      </TooltipProvider>,
    ),
  );
  return { host, p, onCreate };
}

const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = (host: HTMLElement) => act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());

it("asks its questions under its title, the title first and required, and the builder beside it", async () => {
  const { host } = await render(true);
  const form = host.querySelector("form")!;
  expect(form.querySelector("h3")!.textContent).toBe("Report a bug");
  expect(form.textContent).toContain("Tell us what broke");
  expect([...form.querySelectorAll("[data-question]")].map((q) => q.getAttribute("data-question"))).toEqual(["title", "notes", "points"]);
  expect(form.querySelector('[data-question="title"]')!.textContent).toContain("One line");
  expect(host.querySelector('aside[aria-label="Form builder"]')).not.toBeNull();
  expect(host.querySelector('button[role="switch"][aria-label="Required: Name"]')!.hasAttribute("disabled")).toBe(true);
});

it("won't send without its required answers, then makes the row and says thanks", async () => {
  const { host, onCreate } = await render(true);
  await submit(host);
  expect(onCreate).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("2 questions need an answer.");
  await type(host.querySelector<HTMLInputElement>("#q-title")!, "Login loops");
  await type(host.querySelector<HTMLTextAreaElement>("#q-notes")!, "After a reset");
  await type(host.querySelector<HTMLInputElement>("#q-points")!, "three");
  await submit(host);
  expect(onCreate).not.toHaveBeenCalled();
  await type(host.querySelector<HTMLInputElement>("#q-points")!, "3");
  await submit(host);
  expect(onCreate).toHaveBeenCalledWith({ notes: "After a reset", points: 3 }, { title: "Login loops" });
  expect(host.querySelector('[role="status"]')!.textContent).toContain("Thanks, we'll look.");
});

it("lets a viewer read it but not send it", async () => {
  const { host, onCreate } = await render(false);
  expect(host.textContent).toContain("sending it needs agent access");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>("#q-title")!.disabled).toBe(true);
  expect(host.querySelector("aside")).toBeNull();
  await submit(host);
  expect(onCreate).not.toHaveBeenCalled();
});

it("puts the composer of a new sub-item under its parent's last open sub-item", () => {
  const line = (id: string, depth: number) => ({ row: row(id, id), depth, hasChildren: false, open: false });
  const lines = [line("a", 0), line("b", 1), line("c", 2), line("d", 1), line("e", 0)];
  const shown = (adding: string | null) => withComposer(lines, adding).map((l) => (l.kind === "row" ? l.line.row.id : `+${l.parentId}${l.depth}`));
  expect(shown("a")).toEqual(["a", "b", "c", "d", "+a1", "e"]);
  expect(shown("e")).toEqual(["a", "b", "c", "d", "e", "+e1"]);
  expect(shown(null)).toEqual(["a", "b", "c", "d", "e"]);
});

it("draws a dependency as a curve ahead, or around when the blocked row starts first", () => {
  expect(arrowPath(100, 18, 200, 54)).toMatch(/^M100 18 C/);
  expect(arrowPath(200, 18, 100, 54)).toBe("M200 18 H210 V36 H90 V54 H99");
});
