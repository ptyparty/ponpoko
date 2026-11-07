import { describe, expect, test } from "bun:test";
import { braidForDir } from "./braids.ts";
import { Ponpoko } from "./core.ts";
import { Store } from "./store.ts";

const dir = "/home/me/work/stories/sc-1234";

function setup() {
  let now = 1_000_000;
  const store = new Store(":memory:");
  const core = new Ponpoko(store, async () => undefined, () => now);
  core.record("tool", [
    { type: "braid.made", braid: "sc-1234", name: "SC-1234", dir },
    { type: "strand.move", braid: "sc-1234", strand: "a:1", label: "agent one", kind: "agent", whose: "you", why: "turn ended", place: { adapter: "tool", handle: "tool:1", dir } },
    { type: "strand.move", braid: "sc-1234", strand: "a:2", label: "agent two", kind: "agent", whose: "agent", why: "working", place: { adapter: "tool", handle: "tool:2", dir } },
  ]);
  return { core, store, tick: (ms: number) => (now += ms) };
}

describe("braidForDir", () => {
  test("maps story directories to their story, and anything else to side work", () => {
    expect(braidForDir(dir, new Map())).toEqual({ id: "sc-1234", name: "SC-1234" });
    expect(braidForDir("/w/ptyparty", new Map())).toEqual({ id: "side:/w/ptyparty", name: "ptyparty", kind: "side" });
    expect(braidForDir("/w/ptyparty/komux", new Map([["/w/ptyparty", "sc-1"]]))).toEqual({ id: "sc-1", name: "sc-1" });
  });
});

describe("the ponpoko service", () => {
  test("knows nothing is live until something says it's present, and forgets when it leaves", () => {
    const { core } = setup();
    expect(core.snapshot().moves.map((strand) => strand.live)).toEqual([false]);
    core.present({ adapter: "tool", scope: "main", strands: ["a:1"], spaces: [{ dir, label: "tab 1 widgets", short: "tab 1", strands: ["a:1"] }] });
    expect(core.snapshot().moves.map((strand) => [strand.live, strand.space])).toEqual([[true, "tab 1 widgets"]]);
    expect(core.snapshot().braids[0]!.spaces).toEqual([{ label: "tab 1 widgets", short: "tab 1" }]);
    core.absent("tool", "main");
    expect(core.snapshot().moves[0]!.live).toBe(false);
  });

  test("presence lapses if it isn't renewed, telling watchers both ways", () => {
    const { core, tick } = setup();
    let changes = 0;
    core.onChange(() => changes++);
    core.present({ adapter: "tool", scope: "main", strands: ["a:1"], spaces: [] });
    tick(91_000);
    expect(core.snapshot().moves[0]!.live).toBe(false);
    core.expire();
    expect(changes).toBe(2);
    core.present({ adapter: "tool", scope: "main", strands: ["a:1"], spaces: [] });
    expect(changes).toBe(3);
  });

  test("a strand's tab is the one its own pane is in, even when another session has a tab at the same directory", () => {
    const { core } = setup();
    core.present({ adapter: "tool", scope: "b", strands: [], spaces: [{ dir, label: "tab 1 other", short: "tab 1", strands: [] }] });
    core.present({ adapter: "tool", scope: "a", strands: ["a:1"], spaces: [{ dir, label: "tab 3 widgets", short: "tab 3", strands: ["a:1"] }] });
    expect(core.snapshot().moves[0]!.space).toBe("tab 3 widgets");
  });

  test("an agent's own reports never land on a job strand that shares its handle", () => {
    const { core } = setup();
    core.record("tool", [{ type: "strand.move", braid: "sc-1234", strand: "j:2", label: "job", kind: "job", whose: "you", why: "failed", place: { adapter: "tool", handle: "tool:2", dir } }]);
    core.present({ adapter: "tool", scope: "main", strands: ["j:2", "a:2"], spaces: [] });
    core.report({ self: "tool:2", whose: "person", who: "Sam", reason: "asked Sam" });
    expect(core.model.strands.get("a:2")!.who).toBe("Sam");
    expect(core.model.strands.get("j:2")!.whose).toBe("you");
  });

  test("a restarted service keeps what it knew", () => {
    const { store } = setup();
    expect([...new Ponpoko(store, async () => undefined).model.strands.keys()]).toEqual(["a:1", "a:2"]);
  });

  test("agents report on named strands, or their own when it's present", () => {
    const { core } = setup();
    const id = core.report({ dir, strand: "PR #821 review", whose: "machine", who: "Copilot", reason: "waiting on Copilot review of PR #821" });
    expect(core.model.strands.get(id)).toMatchObject({ braid: "sc-1234", kind: "report", whose: "machine", who: "Copilot" });
    expect(() => core.report({ self: "tool:2", whose: "person", reason: "x" })).toThrow(/name the strand/);
    core.present({ adapter: "tool", scope: "main", strands: ["a:2"], spaces: [] });
    core.report({ self: "tool:2", whose: "person", who: "Sam", reason: "asked Sam" });
    expect(core.model.strands.get("a:2")).toMatchObject({ whose: "person", who: "Sam", source: "agent" });
    core.status({ self: "tool:2", text: "step 3 of 10", page: "ponpoko/build-status.md" });
    expect(core.model.strands.get("a:2")!.doing).toMatchObject({ text: "step 3 of 10", page: "ponpoko/build-status.md" });
    core.report({ braid: "SC-1234", strand: "PR #821 review", whose: "done", reason: "review in" });
    expect(core.model.strands.has(id)).toBe(false);
  });

  test("snoozed moves leave your moves until they wake", () => {
    const { core, tick } = setup();
    core.snooze("a:1", 1_000_000 + 30 * 60_000);
    expect(core.snapshot().moves).toEqual([]);
    tick(31 * 60_000);
    expect(core.snapshot().moves.map((strand) => strand.id)).toEqual(["a:1"]);
  });

  test("ending and seeing strands", () => {
    const { core } = setup();
    core.seenStrand("a:1");
    expect(core.model.strands.get("a:1")!.seen).toBe(true);
    core.end("a:1", "you went to it");
    expect(core.model.strands.has("a:1")).toBe(false);
  });
});
