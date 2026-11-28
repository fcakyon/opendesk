import { describe, expect, it } from "vitest";
import type { Mailbox } from "@/lib/api/types";
import { reportsQuery } from "@/router";
import { NO_MAILBOX, openWorkMailbox } from "./MailboxFilter";

const boxes = [{ id: "s", name: "Support" }, { id: "i", name: "Info" }] as Mailbox[];

describe("openWorkMailbox", () => {
  it("narrows the open tickets to the mailbox, or to none of them for no mailbox", () => {
    expect(openWorkMailbox(undefined, boxes)).toEqual({});
    expect(openWorkMailbox("s", boxes)).toEqual({ mailbox_id: "s" });
    expect(openWorkMailbox(NO_MAILBOX, boxes)).toEqual({ mailbox_not: "s,i" });
    expect(openWorkMailbox(NO_MAILBOX, [])).toEqual({});
  });
});

describe("reportsQuery", () => {
  it("sends the mailbox as mailbox_id", () => {
    expect(reportsQuery({ from: "2026-11-01", to: "2026-11-05", mailbox: "none" })).toMatchObject({ mailbox_id: "none" });
  });
});
