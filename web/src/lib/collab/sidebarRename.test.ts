import { afterEach, describe, expect, it } from "vitest";
import { registerRowKeys, sidebarEdit, useSidebarEdit, type RowAction } from "./sidebarEdit";

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

  it("acts on the focused row with what that row can do, and leaves other keys alone", () => {
    document.body.innerHTML = `<div data-sidebar-row="views|view:v1"><a href="/views/v1">Urgent</a></div><a id="away" href="/">Elsewhere</a>`;
    const done: RowAction[] = [];
    const off = registerRowKeys("views|view:v1", (a) => (a === "remove" ? false : (done.push(a), true)));
    document.querySelector<HTMLAnchorElement>('a[href="/views/v1"]')!.focus();
    expect(sidebarEdit.actOnFocused("hide")).toBe(true);
    expect(sidebarEdit.actOnFocused("remove")).toBe(false);
    document.querySelector<HTMLAnchorElement>("#away")!.focus();
    expect(sidebarEdit.actOnFocused("up")).toBe(false);
    off();
    document.querySelector<HTMLAnchorElement>('a[href="/views/v1"]')!.focus();
    expect(sidebarEdit.actOnFocused("hide")).toBe(false);
    expect(done).toEqual(["hide"]);
  });

  it("opens one thing at a time: the picker closes a rename, and done closes both", () => {
    sidebarEdit.rename("teams|team:a");
    sidebarEdit.pickIcon("teams|team:a");
    expect(useSidebarEdit.getState()).toMatchObject({ renaming: null, picking: "teams|team:a" });
    sidebarEdit.done();
    expect(useSidebarEdit.getState()).toMatchObject({ renaming: null, picking: null });
  });
});
