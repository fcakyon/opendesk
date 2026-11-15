import { expect, it } from "vitest";
import type { Member, SavedReply } from "@/lib/api/types";
import { mergeReplyActions, replyActionLabels } from "./ReplyActions";

const reply = (id: string, actions: SavedReply["actions"]): SavedReply =>
  ({ id, title: id, shortcut: "", body_html: "<p>x</p>", actions, created_at: "", updated_at: "" }) as SavedReply;

it("merges the actions of the replies used, a later team or assignee winning", () => {
  const replies = [
    reply("a", { add_tags: ["refund-follow-up", "damaged"], remove_tags: ["new"], team_id: "t1" }),
    reply("b", { add_tags: ["Damaged", "payment"], remove_tags: ["damaged"], team_id: "t2", assignee_id: "u1" }),
    reply("c", undefined),
  ];
  const m = mergeReplyActions(replies, ["a", "b", "c", "gone"]);
  expect(m).toEqual({ add_tags: ["refund-follow-up", "damaged", "payment"], remove_tags: ["new"], team_id: "t2", assignee_id: "u1" });
  const members = [{ user: { id: "u1", name: "Ada" } }] as unknown as Member[];
  expect(replyActionLabels(m, (id) => (id === "t2" ? "Billing" : undefined), members)).toEqual([
    "+ refund-follow-up",
    "+ damaged",
    "+ payment",
    "− new",
    "→ Billing",
    "→ Ada",
  ]);
  expect(replyActionLabels(mergeReplyActions(replies, ["c"]), () => undefined, [])).toEqual([]);
});
