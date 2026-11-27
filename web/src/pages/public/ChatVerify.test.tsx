// The chat visitor's verification page: reading the link changes nothing, the click verifies.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicPath } from "@/i18n";
import type { ChatVerificationPage } from "@/lib/api/types";
import ChatVerify, { verifyToken } from "./ChatVerify";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ history: { replace: () => {} } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) => select({ location: { search: {} } }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const page = (status: ChatVerificationPage["status"]): ChatVerificationPage => ({
  status,
  email: "ada@example.com",
  brand_name: "Lumen",
  brand_color: "",
  locale: "en",
  locale_fixed: true,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let host: HTMLDivElement;
let root: Root;
let calls: { path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

async function open(hash: string, answer: (path: string) => Response) {
  calls = [];
  history.replaceState(null, "", `/chat/verify${hash}`);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url, location.href).pathname;
    calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    return answer(path);
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <ChatVerify />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(host.querySelector("[aria-busy=true]")).toBeNull());
}

describe("chat verification page", () => {
  it("is a public page whose token stays in the fragment", () => {
    expect(isPublicPath("/chat/verify")).toBe(true);
    expect(verifyToken("#token=abc%2B1")).toBe("abc+1");
    expect(verifyToken("")).toBe("");
  });

  it("verifies only when the visitor clicks, never on load", async () => {
    let verified = false;
    await open("#token=tok", (path) => {
      if (path === "/v1/public/chat-verification/confirm") {
        verified = true;
        return json(page("verified"));
      }
      return json(page(verified ? "verified" : "pending"));
    });
    expect(calls.map((c) => c.path)).toEqual(["/v1/public/chat-verification"]);
    expect(calls[0].body).toEqual({ token: "tok" });
    expect(host.textContent).toContain("ada@example.com");
    expect(host.textContent).toContain("so Lumen knows the chat is really from you");
    expect(verified).toBe(false);

    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Confirm email address")!;
    await act(async () => button.click());
    await vi.waitFor(() => expect(host.querySelector("[data-testid=chat-verified]")).not.toBeNull());
    expect(verified).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(["/v1/public/chat-verification", "/v1/public/chat-verification/confirm"]);
    expect(host.textContent).toContain("Your email address is confirmed");
  });

  it("says an address is already verified, and a dead link is not valid", async () => {
    await open("#token=used", () => json(page("verified")));
    expect(host.textContent).toContain("Your email address is already confirmed");
    act(() => root.unmount());
    root = createRoot(host);
    await open("#token=gone", () => json({ status: 404, code: "invalid_link", detail: "This link has expired or was already used." }, 404));
    expect(host.textContent).toContain("This link isn't valid");
    act(() => root.unmount());
    root = createRoot(host);
    await open("", () => json(page("pending")));
    expect(calls).toHaveLength(0);
    expect(host.textContent).toContain("This link isn't valid");
  });
});
