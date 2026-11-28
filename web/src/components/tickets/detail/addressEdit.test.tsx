import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, loadAgentCatalogs } from "@/i18n";
import { NewTicketTo } from "@/components/tickets/NewTicketFields";
import type { NewTicketState } from "@/components/tickets/useNewTicket";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EmailChips } from "./composerParts";
import { editChip } from "./addressEdit";

const isEmail = (s: string) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);

beforeAll(() => loadAgentCatalogs("fr"));

describe("editChip", () => {
  const cc = ["ada@acme.test", "sam@gmail.co", "lea@acme.test"];
  it("puts the edited address in the chip's place", () => {
    expect(editChip(cc, "sam@gmail.co", "sam@gmail.com", isEmail)).toEqual(["ada@acme.test", "sam@gmail.com", "lea@acme.test"]);
    expect(editChip(cc, "sam@gmail.co", " sam@gmail.co ", isEmail)).toEqual(cc);
  });
  it("splits several addresses, drops those already there, and removes an emptied chip", () => {
    expect(editChip(cc, "sam@gmail.co", "sam@gmail.com, bo@acme.test; lea@acme.test", isEmail)).toEqual(["ada@acme.test", "sam@gmail.com", "bo@acme.test", "lea@acme.test"]);
    expect(editChip(cc, "sam@gmail.co", "  ", isEmail)).toEqual(["ada@acme.test", "lea@acme.test"]);
  });
  it("takes nothing while a part is not an address", () => {
    expect(editChip(cc, "sam@gmail.co", "sam@gmail", isEmail)).toBeNull();
    expect(editChip(cc, "sam@gmail.co", "sam@gmail.com, nope", isEmail)).toBeNull();
  });
});

describe("editing addresses in place", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await i18n.changeLanguage("en");
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const editor = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  async function type(el: HTMLInputElement, value: string) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const key = (el: HTMLElement, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));

  async function chips(initial: string[]) {
    const onChange = vi.fn<(v: string[]) => void>();
    function Host() {
      const [values, setValues] = useState(initial);
      return (
        <EmailChips
          label="Cc"
          values={values}
          onChange={(v) => {
            onChange(v);
            setValues(v);
          }}
        />
      );
    }
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Host />
        </TooltipProvider>,
      ),
    );
    return onChange;
  }

  it("opens a Cc chip as text with the caret at the end, and Enter puts the fixed address back in its place", async () => {
    const onChange = await chips(["ada@acme.test", "sam@gmail.co"]);
    await act(async () => button("Edit sam@gmail.co")!.click());
    const input = editor("Edit sam@gmail.co")!;
    expect(input.value).toBe("sam@gmail.co");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([12, 12]);
    await type(input, "sam@gmail.com");
    await key(input, "Enter");
    expect(onChange).toHaveBeenLastCalledWith(["ada@acme.test", "sam@gmail.com"]);
    expect(editor("Edit sam@gmail.co")).toBeNull();
    expect(button("Edit sam@gmail.com")).not.toBeNull();
    // The × still removes a chip whole.
    await act(async () => button("Remove ada@acme.test")!.click());
    expect(onChange).toHaveBeenLastCalledWith(["sam@gmail.com"]);
  });

  it("keeps an edit that is not an address open, drops it on Escape, and removes an emptied chip on blur", async () => {
    const onChange = await chips(["sam@gmail.co", "lea@acme.test"]);
    await act(async () => button("Edit sam@gmail.co")!.click());
    let input = editor("Edit sam@gmail.co")!;
    await type(input, "sam@gmail");
    await key(input, "Enter");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await key(input, "Escape");
    expect(editor("Edit sam@gmail.co")).toBeNull();
    expect(button("Edit sam@gmail.co")).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => button("Edit sam@gmail.co")!.click());
    input = editor("Edit sam@gmail.co")!;
    await type(input, "");
    await act(async () => input.blur());
    expect(onChange).toHaveBeenLastCalledWith(["lea@acme.test"]);
  });

  it("reads in French", async () => {
    await i18n.changeLanguage("fr");
    await chips(["sam@gmail.co"]);
    expect(button("Modifier sam@gmail.co")).not.toBeNull();
  });

  async function newTicket(to: { email?: string; contact?: { id: string; name: string; email: string } }) {
    const set = vi.fn();
    const s = { draft: { kind: "reply", to, moreTo: [] }, chat: false, set } as unknown as NewTicketState;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <NewTicketTo s={s} />
          </TooltipProvider>
        </QueryClientProvider>,
      ),
    );
    return set;
  }

  it("edits the address a new ticket was typed to in place", async () => {
    const set = await newTicket({ email: "sam@gmail.co" });
    await act(async () => button("Edit sam@gmail.co")!.click());
    const input = editor("Edit sam@gmail.co")!;
    expect(input.value).toBe("sam@gmail.co");
    expect([input.selectionStart, input.selectionEnd]).toEqual([12, 12]);
    await type(input, "sam@gmail");
    await key(input, "Enter");
    expect(set).not.toHaveBeenCalled();
    await type(input, "sam@gmail.com");
    await key(input, "Enter");
    expect(set).toHaveBeenCalledWith({ to: { email: "sam@gmail.com" } });
  });

  it("leaves a contact's address to the contact", async () => {
    await newTicket({ contact: { id: "c1", name: "Sam", email: "sam@gmail.co" } });
    expect(button("Edit sam@gmail.co")).toBeNull();
    expect(host.textContent).toContain("sam@gmail.co");
  });
});
