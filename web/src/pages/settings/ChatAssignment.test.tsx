// Settings > Assignment's "Live chats" section, and the mock's chat_mode and chat_skill_id.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Assignment, Skill } from "@/lib/api/types";
import { installMock } from "@/mock";
import { db } from "@/mock/db";
import { dispatch } from "@/mock/router";
import { ChatAssignmentSection } from "./ChatAssignment";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: Assignment = { mode: "none", rules: [], auto_away_minutes: 0, new_ticket_notify: "auto", followup_keeps_assignee: false, chat_mode: "none", chat_skill_id: null };
const skills: Skill[] = [
  { id: "s-chat", name: "Chat", archived: false, member_ids: [] },
  { id: "s-old", name: "Old", archived: true, member_ids: [] },
];

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0].workspace.id;
  const response = await dispatch(`http://mock${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "OD-Workspace": ws } });
  return { status: response.status, body: await response.json() };
}

describe("chat assignment settings", () => {
  installMock();
  let root: Root;
  let el: HTMLDivElement;
  beforeEach(() => {
    el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
  });
  afterEach(() => {
    act(() => root.unmount());
    el.remove();
  });
  const render = (a: Assignment, canEdit = true) =>
    act(() => root.render(<TooltipProvider><ChatAssignmentSection a={a} skills={skills} canEdit={canEdit} onChange={vi.fn()} /></TooltipProvider>));

  it("asks who takes chats only once chats are assigned", () => {
    render(base);
    expect(el.textContent).toContain("Live chats");
    expect(el.textContent).toContain("Chats follow the rules above, like emails");
    expect(el.textContent).not.toContain("Who takes chats");
    render({ ...base, chat_mode: "load_balanced", chat_skill_id: "s-chat" });
    expect(el.textContent).toContain("Who takes chats");
    expect(el.textContent).toContain("Only teammates with the Chat skill, online and not away");
    // Idle teammates stay online unless auto-away is on: the section says so.
    expect(el.textContent).toContain("Mark idle teammates away");
    render({ ...base, chat_mode: "load_balanced", chat_skill_id: "s-chat", auto_away_minutes: 15 });
    expect(el.textContent).not.toContain("Mark idle teammates away");
  });

  it("shows the skill by name to someone who can't change it", () => {
    render({ ...base, chat_mode: "round_robin", chat_skill_id: "s-chat" }, false);
    expect(el.querySelector('[aria-label="Who takes chats"]')).toBeNull();
    expect(el.textContent).toContain("Chat");
  });

  it("checks and stores the rule through the mock API", async () => {
    const ws = db.workspaces[0];
    const saved = structuredClone(ws.workspace.settings);
    try {
      expect((await call("GET", "/v1/assignment")).body).toMatchObject({ chat_mode: "none", chat_skill_id: null });
      expect((await call("PATCH", "/v1/assignment", { chat_mode: "always" })).status).toBe(422);
      expect((await call("PATCH", "/v1/assignment", { chat_skill_id: "nope" })).status).toBe(422);
      const skill = ws.skills.find((s) => !s.archived)!;
      const on = await call("PATCH", "/v1/assignment", { chat_mode: "load_balanced", chat_skill_id: skill.id });
      expect(on.body).toMatchObject({ chat_mode: "load_balanced", chat_skill_id: skill.id });
      expect((await call("PATCH", "/v1/assignment", { chat_skill_id: "" })).body.chat_skill_id).toBeNull();
    } finally {
      ws.workspace.settings = saved;
    }
  });
});
