import { describe, expect, it } from "vitest";
import type { WikiPage } from "@/lib/api/types";
import { spaceOf } from "@/lib/wiki/tree";
import { nodeOf } from "./hooks";

const page = (over: Partial<WikiPage>) =>
  ({ id: "p1", parent_id: null, title: "Notes", icon: "", position: 0, version: 1, updated_at: "2026-11-07T10:00:00Z", created_by: null, tags: [], body_html: "", kind: "page", ...over }) as unknown as WikiPage;

describe("a new page's row in the tree", () => {
  it("lands in its own group: private, a teamspace or the workspace", () => {
    expect(spaceOf(nodeOf(page({ private: true })))).toBe("private");
    expect(spaceOf(nodeOf(page({ team_id: "t1" })))).toBe("team:t1");
    expect(spaceOf(nodeOf(page({})))).toBe("workspace");
  });
  it("keeps what it is and where it lives", () => {
    expect(nodeOf(page({ kind: "database", area: "pages", verified: true }))).toMatchObject({ kind: "database", area: "pages", verified: true });
    expect(nodeOf(page({ kind: "page" })).kind).toBeUndefined();
  });
});
