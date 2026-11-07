import { describe, expect, test } from "bun:test";
import { Ponpoko } from "./core.ts";
import { Store } from "./store.ts";
import { strandNamed } from "./test-harness.ts";

function setup() {
  let now = 1_000_000;
  let ids = 0;
  const store = new Store(":memory:");
  const core = new Ponpoko(store, async () => undefined, () => now, (prefix) => `${prefix}${++ids}`);
  core.record("tool", [
    { type: "player.joined", player: "a1", kind: "agent", who: "claude", adapter: "tool", place: { handle: "tool:1", dir: "/w/ptyparty" } },
    { type: "player.joined", player: "a2", kind: "agent", who: "claude", adapter: "tool", place: { handle: "tool:2", dir: "/w/ptyparty" } },
  ]);
  const shown = () =>
    core
      .snapshot()
      .strands.map((strand) => `${"  ".repeat(strand.depth)}${strand.name} ${strand.rolled.whose ?? "-"}${strand.own.whose ? ` ${strand.own.why}` : ""}`)
      .join("\n");
  return { core, store, shown, tick: (ms: number) => (now += ms) };
}

describe("strands", () => {
  test("nest as deep as the work, made from paths, and a strand with no one on it is yours", () => {
    const { core, shown } = setup();
    core.add(undefined, "ptyparty › ponpoko");
    core.add(strandNamed(core, "ptyparty").id, "quoll");
    expect(shown()).toBe(["ptyparty you", "  ponpoko you no one on it", "  quoll you no one on it"].join("\n"));
    expect(core.snapshot().moves.map((strand) => strand.path.join(" › "))).toEqual(["ptyparty › ponpoko", "ptyparty › quoll"]);
  });

  test("an agent's moves make the strand its move, rolled up to the strands above", () => {
    const { core, shown, tick } = setup();
    core.present({ adapter: "tool", scope: "main", players: ["a1"], spaces: [] });
    expect(core.status({ self: "tool:1", strand: "ptyparty › review findings › 4", text: "reading tabBraid" })).toBe("ptyparty › review findings › 4");
    expect(shown()).toBe(["ptyparty agent", "  review findings agent", "    4 agent reading tabBraid"].join("\n"));
    tick(60_000);
    core.status({ self: "tool:1", text: "making a pointed directory beat a label", page: "ponpoko/review-findings.md" });
    const strand = strandNamed(core, "ptyparty › review findings › 4");
    expect(strand.recent.map((move) => [move.what, move.until !== undefined, move.links.map((link) => link.ref)])).toEqual([
      ["reading tabBraid", true, []],
      ["making a pointed directory beat a label", false, ["ponpoko/review-findings.md"]],
    ]);
  });

  test("names resolve near the strand an agent is on before the top", () => {
    const { core } = setup();
    core.add(undefined, "ptyparty › review findings");
    core.add(undefined, "review findings");
    core.status({ self: "tool:1", strand: "ptyparty", text: "looking around" });
    core.status({ self: "tool:1", strand: "review findings › 2", text: "fixing it" });
    expect(strandNamed(core, "ptyparty › review findings › 2").open.map((move) => move.what)).toEqual(["fixing it"]);
  });

  test("an agent still working outranks a wait it started, and done clears both", () => {
    const { core, shown } = setup();
    core.status({ self: "tool:1", strand: "sc-1", text: "opening the PR" });
    core.wait({ self: "tool:1", who: "Copilot", kind: "machine", what: "reviewing PR #821" });
    expect(shown()).toBe("sc-1 agent opening the PR");
    core.doneBy({ self: "tool:1" }, "merged");
    expect(shown()).toBe("");
    expect(core.snapshot().counts).toMatchObject({ agents: 0, waiting: 0 });
  });

  test("waits on machines and on you", () => {
    const { core, shown } = setup();
    core.add(undefined, "sc-1");
    core.wait({ self: "tool:1", strand: "sc-1", who: "Copilot", kind: "machine", what: "reviewing PR #821" });
    expect(shown()).toBe("sc-1 machine reviewing PR #821");
    core.wait({ self: "tool:1", strand: "sc-1", who: "you", kind: "you", what: "try it in a browser" });
    expect(shown()).toBe("sc-1 you try it in a browser");
    expect(strandNamed(core, "sc-1").open.find((move) => move.player === "you")!.answers!.id).toBe("a1");
    core.wait({ self: "tool:1", strand: "sc-1", who: "you", kind: "you", what: "x", over: true });
    core.wait({ self: "tool:1", strand: "sc-1", who: "Copilot", kind: "machine", what: "x", over: true });
    expect(shown()).toBe("sc-1 you no one on it");
    expect(core.model.players.get("machine:copilot")!.gone).toBeDefined();
  });

  test("done closes a strand and everything under it, and split shares work out", () => {
    const { core, shown } = setup();
    expect(core.split({ strand: "review findings" }, ["1", "2"])).toEqual(["review findings › 1", "review findings › 2"]);
    core.status({ self: "tool:1", strand: "review findings › 1", text: "fixing" });
    core.done(strandNamed(core, "review findings › 1").id);
    expect(shown()).toBe(["review findings you", "  2 you no one on it"].join("\n"));
    core.done(strandNamed(core, "review findings").id);
    expect(shown()).toBe("");
    expect(core.snapshot().counts.agents).toBe(0);
  });

  test("a rogue's loose strand merges into the strand it names, moves and all", () => {
    const { core, shown } = setup();
    core.record("tool", [
      { type: "strand.made", strand: "loose1", name: "claude in ptyparty", kind: "loose" },
      { type: "move.opened", move: "m-a", strand: "loose1", player: "a1", what: "working" },
    ]);
    core.status({ self: "tool:1", strand: "ptyparty › ponpoko", text: "building strands" });
    expect(shown()).toBe(["ptyparty agent", "  ponpoko agent building strands"].join("\n"));
    expect(core.model.strands.has("loose1")).toBe(false);
    expect(strandNamed(core, "ptyparty › ponpoko").recent.map((move) => move.id)).toEqual(["m-a"]);
  });

  test("moving a strand under another, or merging a loose one with m", () => {
    const { core, shown } = setup();
    core.add(undefined, "sc-2");
    core.add(undefined, "epic 9");
    core.record("tool", [{ type: "strand.made", strand: "loose1", name: "claude in side", kind: "loose" }]);
    core.reparent(strandNamed(core, "sc-2").id, "epic 9");
    core.reparent("loose1", "epic 9 › sc-2");
    expect(shown()).toBe(["epic 9 you", "  sc-2 you no one on it"].join("\n"));
    expect(() => core.reparent(strandNamed(core, "epic 9").id, "epic 9 › sc-2")).toThrow("under itself");
    core.reparent(strandNamed(core, "epic 9 › sc-2").id, "");
    expect(shown()).toBe(["epic 9 you no one on it", "sc-2 you no one on it"].join("\n"));
  });

  test("pointing a directory links it and takes in the rogues working there", () => {
    const { core, shown } = setup();
    core.record("tool", [
      { type: "strand.made", strand: "loose1", name: "claude in ptyparty", kind: "loose" },
      { type: "move.opened", move: "m-a", strand: "loose1", player: "you", with: "a1", what: "turn ended" },
    ]);
    core.point("/w/ptyparty", "ptyparty");
    expect(shown()).toBe("ptyparty you turn ended");
    expect(strandNamed(core, "ptyparty").dir).toBe("/w/ptyparty");
  });

  test("snoozed strands leave your moves until they wake, and catching up a parent sees what's under it", () => {
    const { core, tick } = setup();
    core.add(undefined, "sc-1 › a");
    const a = strandNamed(core, "sc-1 › a");
    expect(a.unseen).toBe(true);
    core.snooze(a.id, 1_000_000 + 30 * 60_000);
    expect(core.snapshot().moves).toEqual([]);
    tick(31 * 60_000);
    expect(core.snapshot().moves.map((strand) => strand.name)).toEqual(["a"]);
    core.seen(strandNamed(core, "sc-1").id);
    expect(strandNamed(core, "sc-1 › a").unseen).toBe(false);
  });

  test("players are live only while something says they're present", () => {
    const { core, tick } = setup();
    core.wait({ self: "tool:1", strand: "sc-1", who: "you", kind: "you", what: "look" });
    const answers = () => strandNamed(core, "sc-1").open[0]!.answers!;
    expect(answers().live).toBe(false);
    core.present({ adapter: "tool", scope: "main", players: ["a1"], spaces: [{ dir: "/w", strand: strandNamed(core, "sc-1").id, label: "tab 1 widgets", short: "tab 1", players: ["a1"] }] });
    expect([answers().live, answers().space]).toEqual([true, "tab 1 widgets"]);
    expect(strandNamed(core, "sc-1").spaces).toEqual([{ label: "tab 1 widgets", short: "tab 1" }]);
    tick(91_000);
    expect(answers().live).toBe(false);
  });

  test("a restarted service keeps what it knew", () => {
    const { core, store } = setup();
    core.add(undefined, "ptyparty › ponpoko");
    expect(new Ponpoko(store, async () => undefined).snapshot().strands.map((strand) => strand.name)).toEqual(["ptyparty", "ponpoko"]);
  });
});
