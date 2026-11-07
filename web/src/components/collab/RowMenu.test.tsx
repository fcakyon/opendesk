import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { defaultSidebarPrefs } from "@/lib/collab/sidebarPrefs";
import { RowMenu } from "./RowMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  document.body.innerHTML = "";
});

async function row(enabled: boolean, onDuplicate?: () => void) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <RowMenu
          enabled={enabled}
          prefs={defaultSidebarPrefs()}
          pin={{ kind: "view", id: "v1" }}
          hideId="view:v1"
          label="Billing queue"
          items={onDuplicate ? [{ label: "Duplicate", icon: <Copy />, onSelect: onDuplicate }] : undefined}
        >
          <a href="/views/v1">Billing queue</a>
        </RowMenu>
      </QueryClientProvider>,
    ),
  );
  return el.querySelector<HTMLButtonElement>('button[aria-label="Options for Billing queue"]');
}

async function open(more: HTMLButtonElement) {
  await act(async () => more.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  return [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
}

describe("a sidebar view row's menu", () => {
  it("offers Duplicate without Collab, and runs it", async () => {
    const onDuplicate = vi.fn();
    const more = await row(false, onDuplicate);
    expect(more).not.toBeNull();
    const items = await open(more!);
    expect(items.map((x) => x.textContent)).toEqual(["Duplicate"]);
    await act(async () => items[0].click());
    expect(onDuplicate).toHaveBeenCalledOnce();
  });

  it("puts Duplicate first, before Collab's own entries", async () => {
    const items = await open((await row(true, () => {}))!);
    expect(items.map((x) => x.textContent)).toEqual(["Duplicate", "Rename in sidebar", "Pin to favorites", "Hide from sidebar", "Edit sidebar", "Customize sidebar"]);
  });

  it("leaves a row without actions as it is when Collab is off", async () => {
    expect(await row(false)).toBeNull();
    expect(el.querySelector("a")?.getAttribute("href")).toBe("/views/v1");
  });
});
