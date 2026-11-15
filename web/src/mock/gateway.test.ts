import { beforeAll, describe, expect, it } from "vitest";
import type { PresenceDiff, PresenceState } from "@/lib/realtime/presence";
import { viewers } from "@/lib/realtime/presence";
import { db } from "./db";
import { setTeammatePresence, socketFactory, wikiRoom } from "./gateway";
import { installMock } from "./index";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for the mock's timers to deliver what a check needs, however slow the machine. */
async function until(ok: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await wait(10);
}

async function connected() {
  const socket = socketFactory("mock://gateway", () => ({}));
  socket.connect();
  await wait(150);
  return socket;
}

/** Joins a topic and records what it is pushed. */
function joinTopic(socket: Awaited<ReturnType<typeof connected>>, topic: string, params: object) {
  const got: { state?: PresenceState; diffs: PresenceDiff[] } = { diffs: [] };
  const ch = socket.channel(topic, params);
  ch.on("presence_state", (p) => (got.state = p as PresenceState));
  ch.on("presence_diff", (p) => got.diffs.push(p as PresenceDiff));
  ch.join();
  return { ch, got };
}

// The mock gateway serves wiki_page:<wid>:<id> as the Elixir channel does (contracts/realtime.md).
describe("mock gateway wiki page presence", () => {
  beforeAll(() => {
    localStorage.clear();
    installMock();
  });

  it("tracks the joiner with its join state and tells the others", async () => {
    const wid = db.workspaces[0].workspace.id;
    const page = crypto.randomUUID();
    const a = await connected();
    const b = await connected();
    const first = joinTopic(a, `wiki_page:${wid}:${page}`, { state: "editing" });
    await until(() => !!first.got.state);
    expect(first.got.state?.[db.meId]?.metas[0].state).toBe("editing");

    const watcher = joinTopic(b, `wiki_page:${wid}:${page}`, { watch: true });
    await until(() => !!watcher.got.state);
    expect(watcher.got.state?.[db.meId]).toBeDefined();

    first.ch.push("presence", { state: "idle" });
    expect(watcher.got.diffs.at(-1)?.joins[db.meId]?.metas[0].state).toBe("idle");
    // A ticket's state is not a page's.
    first.ch.push("presence", { state: "replying" });
    expect(watcher.got.diffs.at(-1)?.joins[db.meId]?.metas[0].state).toBe("viewing");

    first.ch.leave();
    expect(Object.keys(watcher.got.diffs.at(-1)?.leaves ?? {})).toEqual([db.meId]);
  });

  it("has a teammate on some pages, the same ones every time, and passes their comings and goings", async () => {
    const wid = db.workspaces[0].workspace.id;
    const socket = await connected();
    // About two pages in three have a teammate: enough pages that some have none.
    const pages = Array.from({ length: 60 }, () => crypto.randomUUID());
    const joined = pages.map((p) => joinTopic(socket, `wiki_page:${wid}:${p}`, { state: "viewing" }));
    await until(() => joined.every((j) => !!j.got.state));
    const others = joined.map((j) => viewers(j.got.state ?? {}, db.meId));
    expect(others.some((v) => v.length === 1)).toBe(true);
    expect(others.some((v) => v.length === 0)).toBe(true);

    const again = joinTopic(await connected(), `wiki_page:${wid}:${pages[0]}`, { watch: true });
    await until(() => !!again.got.state);
    expect(viewers(again.got.state ?? {}, db.meId)).toEqual(others[0]);

    const mate = db.users.find((u) => u.id !== db.meId)!;
    setTeammatePresence(wikiRoom(pages[0]), { user_id: mate.id, name: mate.name, avatar: "", state: "editing" });
    expect(again.got.diffs.at(-1)?.joins[mate.id]?.metas[0].state).toBe("editing");
    // Another page is not told.
    expect(joined[1].got.diffs.some((d) => d.joins[mate.id])).toBe(false);
  });
});
