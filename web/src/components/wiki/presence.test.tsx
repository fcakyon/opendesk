import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RealtimeManager } from "@/lib/realtime/manager";
import { useRealtime, wikiPresenceKey } from "@/lib/realtime/store";
import { useSession } from "@/lib/session";

const manager = vi.hoisted(() => ({ setActiveWikiPage: vi.fn(), setWikiPresenceState: vi.fn() }));
vi.mock("@/lib/realtime/manager", () => ({ realtime: () => manager as unknown as RealtimeManager }));

import { useWikiPresence, WikiViewers } from "./presence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  await i18n.loadNamespaces(["shell", "inbox"]);
  manager.setActiveWikiPage.mockClear();
  manager.setWikiPresenceState.mockClear();
  useSession.setState({ user: { id: "me", name: "Me", email: "[EMAIL]" } as never });
  useRealtime.setState({ presence: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = (node: React.ReactNode) => act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
const meta = (user_id: string, name: string, state: "viewing" | "editing" | "idle", phx_ref: string) => ({ user_id, name, state, phx_ref });

describe("WikiViewers", () => {
  it("shows the others on the page, editing first, and says what each is doing", async () => {
    useRealtime.setState({
      presence: {
        [wikiPresenceKey("p1")]: {
          me: { metas: [meta("me", "Me", "editing", "m")] },
          ana: { metas: [meta("ana", "Ana Ruiz", "viewing", "a")] },
          ben: { metas: [meta("ben", "Ben Cole", "viewing", "b1"), meta("ben", "Ben Cole", "editing", "b2")] },
        },
        p1: { cy: { metas: [meta("cy", "Cy", "viewing", "c")] } },
      },
    });
    await render(<WikiViewers pageId="p1" />);
    const stack = container.querySelector("[data-wiki-presence]")!;
    expect(stack.querySelectorAll(".animate-live-ring")).toHaveLength(2);
    expect(stack.querySelector(".sr-only")?.textContent).toBe("Ben Cole is editing, Ana Ruiz is viewing");
  });

  it("renders nothing when no one else is there", async () => {
    useRealtime.setState({ presence: { [wikiPresenceKey("p1")]: { me: { metas: [meta("me", "Me", "viewing", "m")] } } } });
    await render(<WikiViewers pageId="p1" />);
    expect(container.innerHTML).toBe("");
  });
});

function Probe({ page, editing }: { page: Parameters<typeof useWikiPresence>[0]; editing: boolean }) {
  useWikiPresence(page, editing);
  return null;
}

describe("useWikiPresence", () => {
  it("joins a workspace or team page with its state, follows editing, and leaves on unmount", async () => {
    await render(<Probe page={{ id: "p1", team_id: "t1" }} editing={false} />);
    expect(manager.setActiveWikiPage).toHaveBeenLastCalledWith("p1", { teamId: "t1", state: "viewing" });
    await render(<Probe page={{ id: "p1", team_id: "t1" }} editing />);
    expect(manager.setWikiPresenceState).toHaveBeenLastCalledWith("editing");
    expect(manager.setActiveWikiPage).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    expect(manager.setActiveWikiPage).toHaveBeenLastCalledWith(null);
    root = createRoot(container);
  });

  it("never joins a private page", async () => {
    await render(<Probe page={{ id: "p2", private: true }} editing />);
    expect(manager.setActiveWikiPage).not.toHaveBeenCalled();
    expect(manager.setWikiPresenceState).not.toHaveBeenCalled();
  });
});
