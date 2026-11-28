import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/i18n";
import { HandoffWhy } from "./Timeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function open(data: Record<string, unknown>) {
  await act(async () => root.render(<HandoffWhy data={data} ollie="Ollie" />));
  const button = container.querySelector("button");
  if (button) await act(async () => button.click());
  return button;
}

describe("HandoffWhy", () => {
  it("says which rule handed over and what Ollie wrote", async () => {
    await open({ rule: "agent", reason: "Wants a refund decision" });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Ollie decided a person was needed.");
    expect(text).toContain("Wants a refund decision");
    expect(text).toContain("Only the team sees this.");
  });

  it("names the rule alone when there are no words, with the bot that handed over", async () => {
    await open({ rule: "reply_limit", bot: "Pip" });
    const text = document.body.textContent ?? "";
    expect(text).toContain("The conversation reached Pip's reply limit.");
    expect(text).not.toContain("Reason");
  });

  it("shows nothing for a handoff that kept no reason, or an unknown rule", async () => {
    expect(await open({ bot: "Pip" })).toBeNull();
    expect(await open({ rule: "something_new" })).toBeNull();
  });
});
