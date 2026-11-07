import { afterEach, describe, expect, it } from "vitest";
import { sidebarEdit, useSidebarEdit } from "./sidebarEdit";

describe("renaming the sidebar in place", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    sidebarEdit.done();
  });

  it("renames the row or section that has the focus (F2), and nothing that can't be renamed", () => {
    document.body.innerHTML = `<div data-sidebar-row="inbox|ticket_folder:mine" data-renamable="true"><a href="/inbox/mine">Mine</a></div>
      <div data-sidebar-row="inbox|row:waiting_chats"><button>Waiting</button></div><a id="away" href="/">Elsewhere</a>`;
    document.querySelector<HTMLAnchorElement>("#away")!.focus();
    expect(sidebarEdit.renameFocused()).toBe(false);
    document.querySelector<HTMLButtonElement>("button")!.focus();
    expect(sidebarEdit.renameFocused()).toBe(false);
    document.querySelector<HTMLAnchorElement>('a[href="/inbox/mine"]')!.focus();
    expect(sidebarEdit.renameFocused()).toBe(true);
    expect(useSidebarEdit.getState().renaming).toBe("inbox|ticket_folder:mine");
  });

  it("opens one thing at a time: the picker closes a rename, and done closes both", () => {
    sidebarEdit.rename("teams|team:a");
    sidebarEdit.pickIcon("teams|team:a");
    expect(useSidebarEdit.getState()).toMatchObject({ renaming: null, picking: "teams|team:a" });
    sidebarEdit.done();
    expect(useSidebarEdit.getState()).toMatchObject({ renaming: null, picking: null });
  });
});
