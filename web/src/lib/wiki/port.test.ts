import { describe, expect, it } from "vitest";
import { exportBaseName, groupSkipped, importable, pageExportName, wikiExportName } from "./port";

describe("wiki import and export helpers", () => {
  it("takes the files the import reads, whatever their case", () => {
    for (const name of ["vault.zip", "Note.MD", "a.markdown", "b.txt", "c.html", "d.htm", "e.csv", "Board.canvas"]) expect(importable(name), name).toBe(true);
    for (const name of ["photo.png", "run.sh", "README", "notes.md.exe", "vault.base"]) expect(importable(name), name).toBe(false);
  });

  it("groups the skipped list by reason, changes before what was left out, unknown reasons last", () => {
    const groups = groupSkipped([
      { path: "a.png", reason: "unused" },
      { path: "x.bin", reason: "something_new" },
      { path: "Deep/Page.md", reason: "moved_up" },
      { path: "b.png", reason: "unused" },
      { path: "Board.canvas", reason: "canvas_simplified" },
    ]);
    expect(groups).toEqual([
      { reason: "moved_up", paths: ["Deep/Page.md"] },
      { reason: "canvas_simplified", paths: ["Board.canvas"] },
      { reason: "unused", paths: ["a.png", "b.png"] },
      { reason: "something_new", paths: ["x.bin"] },
    ]);
  });

  it("names files as the API does", () => {
    expect(exportBaseName('Refunds: how/why? <"now">')).toBe("Refunds howwhy now");
    expect(exportBaseName("  ..Notes.  ")).toBe("Notes");
    expect(exportBaseName("#^[]")).toBe("Untitled");
    expect([...exportBaseName("é".repeat(150))]).toHaveLength(100);
    expect(pageExportName({ title: "Runbook" }, "markdown", false)).toBe("Runbook.md");
    expect(pageExportName({ title: "Runbook" }, "html", false)).toBe("Runbook.html");
    expect(pageExportName({ title: "Board", kind: "canvas" }, "markdown", false)).toBe("Board.canvas");
    expect(pageExportName({ title: "Board", kind: "canvas" }, "html", false)).toBe("Board.html");
    expect(pageExportName({ title: "Runbook" }, "html", true)).toBe("Runbook.zip");
    expect(wikiExportName(new Date("2026-11-07T23:30:00Z"))).toBe("Wiki 2026-11-07.zip");
  });
});
