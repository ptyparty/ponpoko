import { describe, expect, test } from "bun:test";
import { Ponpoko } from "./core.ts";
import { dormant } from "./model.ts";
import { Store } from "./store.ts";
import { strandNamed } from "./test-harness.ts";

function setup() {
  let now = 1_000_000;
  let ids = 0;
  const store = new Store(":memory:");
  const core = new Ponpoko(store, () => now, (prefix) => `${prefix}${++ids}`);
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

  test("a new name is made under the strand an agent is on, or at the top when it starts with ›", () => {
    const { core, shown } = setup();
    core.status({ self: "tool:1", strand: "ptyparty", text: "looking around" });
    core.status({ self: "tool:1", strand: "ponpoko", text: "building" });
    core.split({ self: "tool:1", strand: "› sc-9" }, ["a"]);
    expect(shown()).toBe(["sc-9 you", "  a you no one on it", "ptyparty agent", "  ponpoko agent building"].join("\n"));
  });

  test("an agent can title the strands it makes and retitle them later, and you can clear a title", () => {
    const { core } = setup();
    core.status({ self: "tool:1", strand: "ptyparty › titles", text: "starting", title: "Let agents title strands" });
    core.status({ self: "tool:1", text: "still going" });
    expect(strandNamed(core, "ptyparty › titles").title).toBe("Let agents title strands");
    core.status({ self: "tool:1", text: "still going", title: "Let agents title strands any time" });
    core.split({ self: "tool:1" }, [{ name: "status", title: "Title from status" }, "split"]);
    expect(strandNamed(core, "ptyparty").title).toBeUndefined();
    expect(strandNamed(core, "ptyparty › titles").title).toBe("Let agents title strands any time");
    expect(strandNamed(core, "ptyparty › titles › status").title).toBe("Title from status");
    expect(strandNamed(core, "ptyparty › titles › split").title).toBeUndefined();
    core.title(strandNamed(core, "ptyparty › titles").id, " ");
    expect(strandNamed(core, "ptyparty › titles").title).toBeUndefined();
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

  test("a strand with nothing of its own waits on the strand under it, and a strand under it finishing is your move", () => {
    const { core, tick } = setup();
    core.add(undefined, "sc-1 › a › pr");
    core.add(undefined, "sc-1 › b");
    core.wait({ self: "tool:1", strand: "sc-1 › a › pr", who: "the team", kind: "person", what: "review" });
    const own = (path: string) => {
      const { whose, why } = strandNamed(core, path).own;
      return `${whose ?? "-"} ${why}`;
    };
    expect(own("sc-1")).toBe("- waiting on b");
    expect(own("sc-1 › a")).toBe("- waiting on pr");
    tick(60_000);
    core.done(strandNamed(core, "sc-1 › b").id);
    expect(own("sc-1")).toBe("you b is done");
    expect(core.snapshot().moves.map((strand) => strand.name)).toEqual(["sc-1"]);
    tick(60_000);
    core.seen(strandNamed(core, "sc-1").id);
    expect(own("sc-1")).toBe("- waiting on a");
    tick(60_000);
    core.done(strandNamed(core, "sc-1 › a").id);
    expect(own("sc-1")).toBe("you a is done");
    tick(60_000);
    core.status({ self: "tool:1", strand: "sc-1", text: "planning what's next" });
    expect(own("sc-1")).toBe("agent planning what's next");
  });

  test("a strand can wait on strands outside its own tree, and is your move when one of them is done", () => {
    const { core, store, tick } = setup();
    core.add(undefined, "sc-1");
    core.add(undefined, "sc-2");
    core.add(undefined, "sc-3");
    const own = (path: string) => {
      const { whose, why } = strandNamed(core, path).own;
      return `${whose ?? "-"} ${why}`;
    };
    tick(60_000);
    core.block(strandNamed(core, "sc-1").id, "sc-2");
    tick(60_000);
    core.block(strandNamed(core, "sc-1").id, "sc-3");
    expect(own("sc-1")).toBe("- waiting on sc-2");
    expect(core.snapshot().moves.map((strand) => strand.name)).toEqual(["sc-2", "sc-3"]);
    expect(() => core.block(strandNamed(core, "sc-3").id, "sc-1")).toThrow("those strands would wait on each other");
    expect(() => core.block(strandNamed(core, "sc-1").id, strandNamed(core, "sc-1").id)).toThrow("a strand can't wait on itself");
    expect(new Ponpoko(store).snapshot().strands.find((strand) => strand.name === "sc-1")?.own.why).toBe("waiting on sc-2");
    tick(60_000);
    core.done(strandNamed(core, "sc-2").id);
    expect(own("sc-1")).toBe("you sc-2 is done");
    tick(60_000);
    core.seen(strandNamed(core, "sc-1").id);
    expect(own("sc-1")).toBe("- waiting on sc-3");
    core.unblock(strandNamed(core, "sc-1").id);
    expect(own("sc-1")).toBe("you no one on it");
  });

  test("a strand's own moves outrank what it waits on, and marking the wait closes your moves on it", () => {
    const { core, tick } = setup();
    core.add(undefined, "sc-2");
    core.status({ self: "tool:1", strand: "› sc-1", text: "building" });
    core.blockBy({ self: "tool:1", on: "sc-2" });
    expect(strandNamed(core, "sc-1").own.why).toBe("building");
    core.record("komux", [{ type: "move.opened", move: "m-turn", strand: strandNamed(core, "sc-1").id, player: "you", with: "a1", what: "turn ended" }]);
    core.record("komux", [...core.model.moves.values()].filter((move) => move.player === "a1").map((move) => ({ type: "move.closed" as const, move: move.id })));
    expect(strandNamed(core, "sc-1").own.why).toBe("turn ended");
    tick(60_000);
    core.block(strandNamed(core, "sc-1").id, strandNamed(core, "sc-2").id);
    expect(strandNamed(core, "sc-1").own.why).toBe("waiting on sc-2");
    core.blockBy({ self: "tool:1", strand: "sc-1", on: "sc-2", over: true });
    expect(strandNamed(core, "sc-1").blockedOn).toEqual({});
  });

  test("a wait names a strand that exists, by the end of its path, and never makes one", () => {
    const { core, tick } = setup();
    core.add(undefined, "sc-1");
    core.add(undefined, "epic › sc-2");
    core.add(undefined, "a › pr");
    core.add(undefined, "b › pr");
    const sc1 = strandNamed(core, "sc-1").id;
    expect(() => core.block(sc1, "sc-3")).toThrow("ponpoko knows of no strand sc-3");
    expect(() => core.block(sc1, "pr")).toThrow("pr could be 2 strands; give more of its path");
    expect(() => core.blockBy({ self: "tool:1", strand: "sc-1", on: "sc-2", over: true })).toThrow("sc-1 doesn't wait on sc-2");
    expect(core.snapshot().strands.map((strand) => strand.name)).not.toContain("sc-3");
    tick(60_000);
    core.block(sc1, "sc-2");
    expect(strandNamed(core, "sc-1").own.why).toBe("waiting on sc-2");
    tick(60_000);
    core.done(strandNamed(core, "epic").id);
    expect(strandNamed(core, "sc-1").own.whose).toBe("you");
    expect(strandNamed(core, "sc-1").own.why).toBe("sc-2 is done");
  });

  test("merging a strand others wait on moves the wait to the strand it merged into", () => {
    const { core } = setup();
    core.add(undefined, "sc-1");
    core.add(undefined, "sc-2");
    core.add(undefined, "sc-3");
    core.block(strandNamed(core, "sc-1").id, "sc-2");
    core.record("you", [{ type: "strand.merged", strand: strandNamed(core, "sc-2").id, into: strandNamed(core, "sc-3").id }]);
    expect(strandNamed(core, "sc-1").own.why).toBe("waiting on sc-3");
    core.forget(strandNamed(core, "sc-3").id);
    expect(strandNamed(core, "sc-1").blockedOn).toEqual({});
  });

  test("a strand snoozed till woken sleeps until something happens on it", () => {
    const { core, tick } = setup();
    core.add(undefined, "ptyparty");
    const ptyparty = strandNamed(core, "ptyparty").id;
    const asleep = () => (strandNamed(core, "ptyparty").snoozedUntil ?? 0) > core.snapshot().now;
    core.snooze(ptyparty, dormant);
    tick(365 * 24 * 60 * 60_000);
    expect(core.snapshot().moves).toEqual([]);
    core.add(undefined, "ptyparty › komux › keys");
    expect(asleep()).toBe(false);
    core.snooze(ptyparty, dormant);
    core.done(strandNamed(core, "ptyparty › komux › keys").id);
    expect(asleep()).toBe(true);
    core.done(strandNamed(core, "ptyparty › komux").id);
    expect(asleep()).toBe(false);
    core.snooze(ptyparty, dormant);
    core.wait({ self: "tool:1", strand: "ptyparty", who: "the team", kind: "person", what: "review" });
    expect(asleep()).toBe(false);
    core.add(undefined, "kowari");
    core.block(ptyparty, "kowari");
    core.snooze(ptyparty, dormant);
    core.done(strandNamed(core, "kowari").id);
    expect(asleep()).toBe(false);
    core.snooze(ptyparty, 1_000_000);
    core.add(undefined, "ptyparty › quoll");
    expect(strandNamed(core, "ptyparty").snoozedUntil).toBe(1_000_000);
  });

  test("a snooze till needed from before is no snooze at all", () => {
    const { core } = setup();
    core.add(undefined, "sc-1");
    const strand = strandNamed(core, "sc-1").id;
    core.record("you", [{ type: "strand.snoozed", strand, until: Number.MAX_SAFE_INTEGER, untilNeeded: true }]);
    expect(strandNamed(core, "sc-1").snoozedUntil).toBeUndefined();
  });

  test("a strand moves under the very strand named by its id, even when another shares its name", () => {
    const { core } = setup();
    core.add(undefined, "sc-1 › pr");
    core.add(undefined, "sc-2 › pr");
    core.add(undefined, "fix");
    core.reparent(strandNamed(core, "fix").id, strandNamed(core, "sc-2 › pr").id);
    expect(strandNamed(core, "sc-2 › pr › fix").id).toBeDefined();
  });

  test("renaming a strand renames the paths under it, and takes a single name", () => {
    const { core } = setup();
    core.add(undefined, "sc-1 › pr › ask");
    core.rename(strandNamed(core, "sc-1 › pr").id, " pr-fix ");
    expect(core.snapshot().strands.map((strand) => strand.path.join(" › "))).toEqual(["sc-1", "sc-1 › pr-fix", "sc-1 › pr-fix › ask"]);
    expect(() => core.rename(strandNamed(core, "sc-1").id, "a › b")).toThrow("single name");
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
    expect(new Ponpoko(store).snapshot().strands.map((strand) => strand.name)).toEqual(["ptyparty", "ponpoko"]);
  });

  test("a rogue naming a strand it split off its own loose strand keeps the tree whole, and survives a restart", () => {
    const { core, store, shown } = setup();
    core.record("tool", [
      { type: "strand.made", strand: "loose1", name: "claude in side", kind: "loose" },
      { type: "move.opened", move: "m-a", strand: "loose1", player: "a1", what: "working" },
    ]);
    core.split({ self: "tool:1" }, ["c"]);
    core.status({ self: "tool:1", strand: "c", text: "on c" });
    expect(shown()).toBe("c agent on c");
    expect(new Ponpoko(store).snapshot().strands.map((strand) => strand.name)).toEqual(["c"]);
  });

  test("marking a parent done finishes everything under it, so nothing hidden still counts as yours", () => {
    const { core } = setup();
    core.add(undefined, "p › a");
    core.add(undefined, "p › b");
    core.status({ self: "tool:1", strand: "p › a", text: "working on a" });
    core.done(strandNamed(core, "p").id);
    expect(core.snapshot().counts).toMatchObject({ yours: 0, agents: 0 });
    expect(() => core.status({ self: "tool:1", text: "next step" })).toThrow("name the strand");
  });
});
