import { describe, expect, it } from "vitest";
import { foldCrumbs, type Crumb } from "./useBreadcrumbs";

const c = (label: string): Crumb => ({ label, to: "/pages/$pageId", params: { pageId: label } });

describe("foldCrumbs", () => {
  it("keeps a short path as it is", () => {
    const path = [c("Pages"), c("Team home"), c("Q1"), c("Page")];
    expect(foldCrumbs(path)).toEqual(path);
  });

  it("folds the middle of a deep path, keeping the section and the last two", () => {
    const path = [c("Pages"), c("Team home"), c("Projects"), c("Launch"), c("Week one"), c("Page")];
    expect(foldCrumbs(path)).toEqual([c("Pages"), { fold: [c("Team home"), c("Projects"), c("Launch")] }, c("Week one"), c("Page")]);
  });
});
