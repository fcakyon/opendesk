import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n, loadAgentCatalogs } from "@/i18n";
import type { ViewIcon } from "@/lib/api/types";
import { ViewIconField } from "./ViewIconField";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // Radix popovers measure their trigger.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(async () => {
  await i18n.changeLanguage("en");
  document.body.innerHTML = "";
});

const seen: (ViewIcon | null)[] = [];

function Harness({ initial, name, section }: { initial: ViewIcon | null; name: string; section?: boolean }) {
  const [icon, setIcon] = useState(initial);
  return (
    <TooltipProvider>
      <ViewIconField
        value={icon}
        name={name}
        section={section}
        onChange={(i) => {
          seen.push(i);
          setIcon(i);
        }}
      />
    </TooltipProvider>
  );
}

async function render(initial: ViewIcon | null, name = "Billing queue", section = false) {
  seen.length = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness initial={initial} name={name} section={section} />));
  const q = <T extends Element = HTMLButtonElement>(sel: string) => document.querySelector<T>(sel);
  const button = (label: string) => q(`button[aria-label="${label}"]`);
  // By hand: jsdom's selectors miss attribute values outside the BMP, such as most emoji.
  const cellFor = (e: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="listbox"] button')].find((b) => b.getAttribute("aria-label") === e)!;
  const byText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  const open = () => act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  const previews = () => [...document.querySelectorAll<HTMLElement>('[data-testid="view-icon-preview"]')];
  const type = async (input: HTMLInputElement, text: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  return { host, q, button, cellFor, byText, open, previews, type, unmount: () => act(async () => root.unmount()) };
}

it("shows the view as its sidebar row, and opens on the emoji tab for a view without one", async () => {
  const { host, open, previews, byText, unmount } = await render(null);
  expect(host.textContent).toContain("Icon");
  expect(previews()[0].textContent).toBe("Billing queue");
  expect(previews()[0].querySelector('[data-view-icon="none"]')).not.toBeNull();
  await open();
  expect(document.body.textContent).toContain("In the sidebar");
  expect(byText("Emoji").getAttribute("aria-checked")).toBe("true");
  expect(byText("None").disabled).toBe(true);
  expect(document.querySelectorAll('[role="radiogroup"][aria-label="Colour"] [role="radio"]')).toHaveLength(15);
  await unmount();
});

it("picks an emoji from the grid, or one typed that the grid lacks", async () => {
  const { q, cellFor, open, previews, byText, type, unmount } = await render(null, "💸 Refunds");
  await open();
  await act(async () => cellFor("🔥").click());
  expect(seen.at(-1)).toEqual({ kind: "emoji", value: "🔥", color: null });
  expect(previews().at(-1)!.textContent).toBe("🔥💸 Refunds");
  // The colours are off for an emoji.
  expect(q<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
  await type(q<HTMLInputElement>('input[placeholder="Search or paste an emoji"]')!, "🦩");
  await act(async () => cellFor("🦩").click());
  expect(seen.at(-1)).toEqual({ kind: "emoji", value: "🦩", color: null });
  await act(async () => byText("None").click());
  expect(seen.at(-1)).toBeNull();
  await unmount();
});

it("picks an icon of the list in the chosen colour, and keeps the colour across tabs", async () => {
  const { q, button, open, byText, previews, type, unmount } = await render(null);
  await open();
  await act(async () => button("Teal")!.click());
  // A colour alone tints the default icon.
  expect(seen.at(-1)).toEqual({ kind: "icon", value: "layers", color: "teal" });
  await act(async () => byText("Icon").click());
  await type(q<HTMLInputElement>('input[placeholder="Search icons"]')!, "truck");
  expect(document.querySelectorAll('[role="listbox"] [data-icon]')).toHaveLength(1);
  await act(async () => q('[data-icon="truck"]')!.click());
  expect(seen.at(-1)).toEqual({ kind: "icon", value: "truck", color: "teal" });
  expect(previews().at(-1)!.querySelector<SVGElement>("svg")!.style.color).toBe("var(--tone-teal)");
  // A second click on the colour clears it; the icon stays.
  await act(async () => button("Teal")!.click());
  expect(seen.at(-1)).toEqual({ kind: "icon", value: "truck", color: null });
  await act(async () => button("Rose")!.click());
  await act(async () => byText("Text").click());
  await type(q<HTMLInputElement>('input[aria-label="Letters or digits"]')!, "p-o x");
  expect(seen.at(-1)).toEqual({ kind: "text", value: "po", color: "rose" });
  expect(previews().at(-1)!.querySelector('[data-view-icon="text"]')!.textContent).toBe("po");
  await type(q<HTMLInputElement>('input[aria-label="Letters or digits"]')!, "");
  expect(seen.at(-1)).toBeNull();
  await unmount();
});

it("clears a colour on the default icon back to none", async () => {
  const { button, open, unmount } = await render({ kind: "icon", value: "layers", color: "amber" });
  await open();
  await act(async () => button("Amber")!.click());
  expect(seen).toEqual([null]);
  await unmount();
});

it("opens on the tab of the view's icon and speaks French", async () => {
  await loadAgentCatalogs("fr");
  await i18n.changeLanguage("fr");
  const { host, open, byText, unmount } = await render({ kind: "text", value: "B2", color: null });
  expect(host.textContent).toContain("Icône");
  await open();
  expect(byText("Texte").getAttribute("aria-checked")).toBe("true");
  expect(byText("Aucune").disabled).toBe(false);
  await unmount();
});

it("shows a section as its heading, with no icon until one is picked, and keeps the plain layers icon", async () => {
  const { host, button, open, previews, unmount } = await render(null, "After sales", true);
  expect(host.textContent).toContain("for everyone with a view in it");
  expect(previews()[0].textContent).toBe("After sales");
  expect(previews()[0].className).toContain("font-semibold");
  expect(previews()[0].querySelector("[data-view-icon]")).toBeNull();
  await open();
  // A colour alone picks the layers icon: a section has no default one to fall back to.
  await act(async () => button("Teal")!.click());
  await act(async () => button("Teal")!.click());
  expect(seen).toEqual([
    { kind: "icon", value: "layers", color: "teal" },
    { kind: "icon", value: "layers", color: null },
  ]);
  expect(previews().at(-1)!.querySelector('[data-view-icon="icon"]')).not.toBeNull();
  await unmount();
});
