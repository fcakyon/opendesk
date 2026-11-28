import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { i18n } from "@/i18n";
import { ConfirmProvider } from "@/components/ui/confirm";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { PanelAction, PanelActionResult } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { ActionsBlock, PanelContext } from "./PanelActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const plain: PanelAction = { id: "sync", label: "Sync CRM" };
const confirmed: PanelAction = { id: "approve", label: "Approve credit note", confirm: "Approve credit note RINV/2026/0003?", tone: "danger" };
const form: PanelAction = {
  id: "remind",
  label: "Send reminder",
  inputs: [
    { name: "invoice", label: "Invoice", type: "select", required: true, options: [{ value: "INV-1", label: "INV-1" }, { value: "INV-2", label: "INV-2" }], default: "INV-1" },
    { name: "note", label: "Note", type: "textarea" },
  ],
};
const ok: PanelActionResult = { ok: true, message: "Done in the CRM", tone: "success", data: { panel_id: "p1", kind: "http", state: "ok", fetched_at: "2026-11-14T10:00:00Z", blocks: [{ type: "note", text: "Synced.", tone: "success" }] } };

async function show(actions: PanelAction[], context: { ticketId: string; panelId: string } | null = { ticketId: "t1", panelId: "p1" }) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <PanelContext.Provider value={context}>
              <ActionsBlock actions={actions} />
            </PanelContext.Provider>
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
}
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="panel-actions"] button')];
const dialogButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button, [role="alertdialog"] button')].find((b) => b.textContent === label);
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("panel actions", () => {
  it("sends an action that needs nothing else at once, and the panel follows what the URL answered", async () => {
    const spy = vi.spyOn(api.tickets, "panelAction").mockResolvedValue(ok);
    await show([plain]);
    expect(buttons().map((b) => b.textContent)).toEqual(["Sync CRM"]);
    await act(async () => buttons()[0].click());
    await flush();
    expect(spy).toHaveBeenCalledWith("t1", "p1", { action: "sync", inputs: undefined });
    expect(qc.getQueryData(qk.ticketPanel("t1", "p1"))).toEqual(ok.data);
  });

  it("asks to confirm first, and sends nothing until the agent does", async () => {
    const spy = vi.spyOn(api.tickets, "panelAction").mockResolvedValue(ok);
    await show([confirmed]);
    await act(async () => buttons()[0].click());
    expect(spy).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Approve credit note RINV/2026/0003?");
    await act(async () => dialogButton("Approve credit note")!.click());
    await flush();
    expect(spy).toHaveBeenCalledWith("t1", "p1", { action: "approve", inputs: undefined });
  });

  it("opens a form for an action with inputs and sends what was filled in", async () => {
    const spy = vi.spyOn(api.tickets, "panelAction").mockResolvedValue(ok);
    await show([form]);
    await act(async () => buttons()[0].click());
    expect(spy).not.toHaveBeenCalled();
    const note = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(note, "Please pay today");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => dialogButton("Send reminder")!.click());
    await flush();
    expect(spy).toHaveBeenCalledWith("t1", "p1", { action: "remind", inputs: { invoice: "INV-1", note: "Please pay today" } });
  });

  it("keeps the form and what was filled in when the URL refuses the action, and closes it once it goes through", async () => {
    const spy = vi.spyOn(api.tickets, "panelAction").mockResolvedValueOnce({ ok: false, message: "Invoice INV-1 is already paid", tone: "danger" }).mockResolvedValueOnce(ok);
    await show([form]);
    await act(async () => buttons()[0].click());
    const note = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(note, "Please pay today");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => dialogButton("Send reminder")!.click());
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value).toBe("Please pay today");
    await act(async () => dialogButton("Send reminder")!.click());
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="dialog"] textarea')).toBeNull();
  });

  it("does nothing without a ticket and panel to act on (settings' preview)", async () => {
    const spy = vi.spyOn(api.tickets, "panelAction").mockResolvedValue(ok);
    await show([plain], null);
    expect(buttons()[0].disabled).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
