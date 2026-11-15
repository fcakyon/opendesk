import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import type { View, ViewIcon } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { readFolded } from "@/lib/viewSections";
import { useFoldedSections, ViewSectionGroup } from "./ViewSectionGroup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = (id: string, name: string): View => ({ id, name, shared: true, filters: {}, position: 0, section: "After sales" });
const views = [view("v1", "Damaged"), view("v2", "Refunds")];
const counts: Record<string, number> = { v1: 3, v2: 4 };

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  useSession.setState({ workspaceId: "w1", user: { id: "u1" } as never });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/** A section as Favorites draws it: its own fold, a menu around the header. */
function Pinned({ rail = false, openView, menu, icon, name = "After sales" }: { rail?: boolean; openView?: string; menu?: (h: ReactElement) => ReactElement; icon?: ViewIcon; name?: string }) {
  const [folded, toggle] = useFoldedSections("favorites");
  return (
    <ViewSectionGroup
      name={name}
      icon={icon}
      views={views}
      rail={rail}
      folded={folded.has("after sales")}
      onToggle={() => toggle("after sales")}
      divider
      openView={openView}
      row={(v) => <a href={`/views/${v.id}`}>{v.name}</a>}
      count={(v) => counts[v.id]}
      waiting={(v) => (v.id === "v2" ? 1 : 0)}
      menu={menu}
    />
  );
}

const render = (node: ReactElement) => act(async () => root.render(node));
const header = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const rows = () => [...host.querySelectorAll("a")].map((a) => a.textContent);

describe("a view section in the sidebar", () => {
  it("heads its views, named for screen readers, and folds them with a click", async () => {
    await render(<Pinned />);
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Views in After sales");
    expect(header().getAttribute("aria-expanded")).toBe("true");
    expect(header().getAttribute("aria-controls")).toBe(host.querySelector('[role="group"] > div')?.id);
    expect(rows()).toEqual(["Damaged", "Refunds"]);
    // Unfolded, the header shows no number: each view shows its own.
    expect(header().querySelector("[data-count]")).toBeNull();

    await act(async () => header().click());
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toEqual([]);
    // Folded, what its views would show: their sum and the chats waiting on them.
    expect(header().querySelector("[data-count]")).not.toBeNull();
    expect(header().querySelector('[aria-label="1 live chat waiting for a reply"]')).not.toBeNull();
  });

  it("keeps its fold in Favorites apart from the one under Views", async () => {
    await render(<Pinned />);
    await act(async () => header().click());
    expect([...readFolded("w1", "u1", "favorites")]).toEqual(["after sales"]);
    expect(readFolded("w1", "u1", "views").size).toBe(0);
  });

  it("reads as current when folded over the open view", async () => {
    await render(<Pinned openView="v2" />);
    expect(header().textContent).not.toContain("contains the open view");
    await act(async () => header().click());
    expect(header().textContent).toContain("contains the open view");
  });

  it("names the section in semibold, apart from its views", async () => {
    await render(<Pinned />);
    expect(header().className).toContain("font-semibold");
    expect(header().className).not.toContain("font-medium");
    for (const a of host.querySelectorAll("a")) expect(a.className).not.toContain("font-semibold");
  });

  it("puts its menu around the header", async () => {
    await render(<Pinned menu={(h) => <div data-menu="">{h}</div>} />);
    expect(host.querySelector("[data-menu] > button[aria-expanded]")).not.toBeNull();
  });

  it("shows the section's icon between the chevron and the name, and none without one", async () => {
    await render(<Pinned />);
    expect(header().querySelector("[data-view-icon]")).toBeNull();
    await render(<Pinned icon={{ kind: "emoji", value: "⭐", color: null }} name={"⭐ After sales"} />);
    const icon = header().querySelector('[data-view-icon="emoji"]')!;
    expect(icon.textContent).toBe("⭐");
    expect(icon.previousElementSibling?.tagName.toLowerCase()).toBe("svg");
    // A name that starts with the icon's emoji shows it once.
    expect(header().textContent).toBe("⭐After sales");
    await render(<Pinned icon={{ kind: "icon", value: "truck", color: "teal" }} />);
    expect(header().querySelector('[data-view-icon="icon"]')).not.toBeNull();
  });

  it("marks the section in the rail with its icon, in the hairline above it", async () => {
    await render(<Pinned rail />);
    expect(host.querySelector("[data-section-mark]")).toBeNull();
    await render(<Pinned rail icon={{ kind: "text", value: "AS", color: "violet" }} />);
    const mark = host.querySelector("[data-section-mark]")!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.getAttribute("title")).toBe("After sales");
    expect(mark.querySelector('[data-view-icon="text"]')?.textContent).toBe("AS");
    expect(rows()).toEqual(["Damaged", "Refunds"]);
  });

  it("shows every view in the rail, with no header to fold", async () => {
    await render(<Pinned rail menu={(h) => <div data-menu="">{h}</div>} />);
    expect(header()).toBeNull();
    expect(host.querySelector("[data-menu]")).toBeNull();
    expect(rows()).toEqual(["Damaged", "Refunds"]);
  });
});
