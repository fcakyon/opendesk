import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import "@/i18n";
import { sidebarEdit } from "@/lib/collab/sidebarEdit";
import { SidebarRow, type RowEdit } from "./SidebarRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const edit: RowEdit = { name: "Needs an owner", placeholder: "Unassigned", label: "Rename", onName: () => {}, onIcon: () => {} };

describe("renaming a row where it is", () => {
  let root: Root;
  afterEach(() => {
    act(() => root.unmount());
    sidebarEdit.done();
    document.body.innerHTML = "";
  });

  it("keeps the row's icon beside the name's field", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SidebarRow id="inbox|ticket_folder:unassigned" label="Needs an owner" edit={edit} rail={false}>
            <a href="/inbox/unassigned">
              <Inbox data-testid="icon" />
              <span>Needs an owner</span>
            </a>
          </SidebarRow>
        </QueryClientProvider>,
      ),
    );
    act(() => sidebarEdit.rename("inbox|ticket_folder:unassigned"));
    const field = host.querySelector<HTMLInputElement>("input");
    expect(field?.value).toBe("Needs an owner");
    expect(host.querySelector('[data-testid="icon"]')).not.toBeNull();
    // The row under the field is shown, not used: no second link to tab to.
    expect(host.querySelector("a")?.closest("[inert]")).not.toBeNull();
  });
});
