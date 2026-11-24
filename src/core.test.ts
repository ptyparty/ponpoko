import { describe, expect, test } from "bun:test";
import { Ponpoko, readTourRef } from "./core.ts";
import { dormant } from "./model.ts";
import { Store } from "./store.ts";
import { harness, strandNamed } from "./test-harness.ts";

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
  test("nest as deep as the work, made from paths, and are nobody's move until something is asked", () => {
    const { core, shown } = setup();
    core.add(undefined, "ptyparty › ponpoko");
    core.add(strandNamed(core, "ptyparty").id, "quoll");
    expect(shown()).toBe(["ptyparty -", "  ponpoko -", "  quoll -"].join("\n"));
    expect(core.snapshot().moves).toEqual([]);
  });

  test("an agent's moves make the strand its move, rolled up to the strands above", () => {
    const { core, shown, tick } = setup();
    core.present({ adapter: "tool", scope: "main", players: ["a1"], spaces: [] });
    expect(core.status({ self: "tool:1", strand: "ptyparty › review findings › 4", text: "reading tabStrand" })).toBe("ptyparty › review findings › 4");
    expect(shown()).toBe(["ptyparty agent", "  review findings agent", "    4 agent reading tabStrand"].join("\n"));
    tick(60_000);
    core.status({ self: "tool:1", text: "making a pointed directory beat a label", page: "ponpoko/review-findings.md" });
    const strand = strandNamed(core, "ptyparty › review findings › 4");
    expect(strand.open.map((move) => move.what)).toEqual(["making a pointed directory beat a label"]);
    expect(strand.links.filter((link) => link.adapter === "quoll").map((link) => link.ref)).toEqual(["ponpoko/review-findings.md"]);
  });

  test("a new name is made under the strand an agent is on, or at the top when it starts with ›", () => {
    const { core, shown } = setup();
    core.status({ self: "tool:1", strand: "ptyparty", text: "looking around" });
    core.status({ self: "tool:1", strand: "ponpoko", text: "building" });
    core.split({ self: "tool:1", strand: "› sc-9" }, ["a"]);
    expect(shown()).toBe(["ptyparty agent", "  ponpoko agent building", "sc-9 -", "  a -"].join("\n"));
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
    expect(shown()).toBe("sc-1 -");
    expect([...core.model.requests.values()].map((request) => request.closed?.as)).toEqual(["done", "done"]);
  });

  test("done closes a strand and everything under it, and split shares work out", () => {
    const { core, shown } = setup();
    expect(core.split({ strand: "review findings" }, ["1", "2"])).toEqual(["review findings › 1", "review findings › 2"]);
    core.status({ self: "tool:1", strand: "review findings › 1", text: "fixing" });
    core.done(strandNamed(core, "review findings › 1").id);
    expect(shown()).toBe(["review findings -", "  2 -"].join("\n"));
    core.done(strandNamed(core, "review findings").id);
    expect(shown()).toBe("");
    expect(core.snapshot().counts.agents).toBe(0);
  });

  test("a strand split with a tour links to it and asks you to review it, once however often it is split", () => {
    const { core } = setup();
    core.status({ self: "tool:1", strand: "› sc-1", text: "preparing tours" });
    const tour = { repo: "/w/sc-1/gadgets", name: "caching toggle" };
    core.split({ self: "tool:1" }, [{ name: "review gadgets", tour }]);
    core.split({ self: "tool:1" }, [{ name: "review gadgets", tour }]);
    const review = strandNamed(core, "sc-1 › review gadgets");
    expect(review.links.filter((link) => link.adapter === "remax").map((link) => [readTourRef(link.ref), link.label])).toEqual([[tour, "caching toggle"]]);
    expect(review.open.filter((move) => move.player === "you").map((move) => move.what)).toEqual(["review the caching toggle tour in remax"]);
    expect(review.own.whose).toBe("you");
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
    expect(strandNamed(core, "ptyparty › ponpoko").recent.map((move) => move.what)).toEqual(["working", "building strands"]);
  });

  test("moving a strand under another, or merging a loose one with m", () => {
    const { core, shown } = setup();
    core.add(undefined, "sc-2");
    core.add(undefined, "epic 9");
    core.record("tool", [{ type: "strand.made", strand: "loose1", name: "claude in side", kind: "loose" }]);
    core.reparent(strandNamed(core, "sc-2").id, "epic 9");
    core.reparent("loose1", "epic 9 › sc-2");
    expect(shown()).toBe(["epic 9 -", "  sc-2 -"].join("\n"));
    expect(() => core.reparent(strandNamed(core, "epic 9").id, "epic 9 › sc-2")).toThrow("under itself");
    core.reparent(strandNamed(core, "epic 9 › sc-2").id, "");
    expect(shown()).toBe(["epic 9 -", "sc-2 -"].join("\n"));
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
    core.wait({ strand: "› sc-1 › a", who: "you", kind: "you", what: "look" }, "you");
    const a = strandNamed(core, "sc-1 › a");
    expect(a.unseen).toBe(true);
    core.snooze(a.id, 1_000_000 + 30 * 60_000);
    expect(core.snapshot().moves).toEqual([]);
    tick(31 * 60_000);
    expect(core.snapshot().moves.map((strand) => strand.name)).toEqual(["a"]);
    core.seen(strandNamed(core, "sc-1").id);
    expect(strandNamed(core, "sc-1 › a").unseen).toBe(false);
  });

  test("doesn't ask you to close a parent while someone is at work on it", () => {
    const { core } = setup();
    core.add(undefined, "sc-1 › a");
    core.status({ self: "tool:1", strand: "sc-1", text: "planning what's next" });
    core.done(strandNamed(core, "sc-1 › a").id);
    expect([...core.model.requests.values()].filter((request) => request.kind === "close")).toEqual([]);
  });

  test("keeping a parent open declines its close ask and leaves it open", () => {
    const { core } = setup();
    core.add(undefined, "sc-1 › a");
    core.done(strandNamed(core, "sc-1 › a").id);
    expect(strandNamed(core, "sc-1").own.why).toBe("parts done: close it?");
    core.keepOpen(strandNamed(core, "sc-1").id);
    expect(strandNamed(core, "sc-1").own.whose).toBeUndefined();
    expect(strandNamed(core, "sc-1").done).toBeUndefined();
    expect(core.snapshot().moves).toEqual([]);
  });

  test("replying answers what's asked of you on a strand and leaves others' requests open", () => {
    const { core } = setup();
    core.add(undefined, "sc-1");
    core.wait({ self: "tool:1", strand: "sc-1", who: "the team", kind: "person", what: "review" });
    core.wait({ self: "tool:1", strand: "sc-1", who: "you", kind: "you", what: "try it live" });
    expect(strandNamed(core, "sc-1").own.whose).toBe("you");
    core.reply(strandNamed(core, "sc-1").id, "looks good");
    expect(strandNamed(core, "sc-1").own.whose).toBe("person");
    const answered = [...core.model.requests.values()].find((request) => request.what === "try it live");
    expect(answered?.closed).toMatchObject({ as: "done", what: "looks good" });
    expect(() => core.reply(strandNamed(core, "sc-1").id)).toThrow("nothing on sc-1 asks you for a reply");
  });

  test("a reply leaves the question whether to close a parent to keep-open and done", () => {
    const { core } = setup();
    core.add(undefined, "sc-1 › a");
    core.done(strandNamed(core, "sc-1 › a").id);
    expect(strandNamed(core, "sc-1").own.why).toBe("parts done: close it?");
    expect(strandNamed(core, "sc-1").answerable).toBe(false);
    expect(() => core.reply(strandNamed(core, "sc-1").id)).toThrow("nothing on sc-1 asks you for a reply");
  });

  test("a parent sums up what's asked under it, and asks you to close it once every part is done", () => {
    const { core, tick } = setup();
    core.add(undefined, "sc-1 › a › pr");
    core.add(undefined, "sc-1 › b");
    core.wait({ self: "tool:1", strand: "sc-1 › a › pr", who: "the team", kind: "person", what: "review" });
    const own = (path: string) => {
      const { whose, why } = strandNamed(core, path).own;
      return `${whose ?? "-"} ${why}`;
    };
    expect(own("sc-1")).toBe("- 1 for the team");
    expect(own("sc-1 › a")).toBe("- 1 for the team");
    tick(60_000);
    core.done(strandNamed(core, "sc-1 › b").id);
    expect(own("sc-1")).toBe("- 1 for the team");
    expect(core.snapshot().moves).toEqual([]);
    tick(60_000);
    core.done(strandNamed(core, "sc-1 › a").id);
    expect(own("sc-1")).toBe("you parts done: close it?");
    tick(60_000);
    core.status({ self: "tool:1", strand: "sc-1", text: "planning what's next" });
    expect(own("sc-1")).toBe("you parts done: close it?");
    core.done(strandNamed(core, "sc-1").id);
    expect(core.snapshot().counts).toMatchObject({ yours: 0, agents: 0 });
  });

  test("a strand another source finishes still asks after what waited on it", () => {
    const { core } = setup();
    const a = core.add(undefined, "sc-1");
    const b = core.add(undefined, "sc-2");
    core.block(b, a);
    core.record("shortcut", [{ type: "strand.done", strand: a, why: "done in Shortcut" }]);
    expect(strandNamed(core, "sc-2").own).toMatchObject({ whose: "you", why: "sc-1 is done" });
  });

  test("a child finishing doesn't make its parent your move", () => {
    const { core } = setup();
    core.add(undefined, "sc-1 › a");
    core.add(undefined, "sc-1 › b");
    core.done(strandNamed(core, "sc-1 › a").id);
    expect(strandNamed(core, "sc-1").own.whose).toBeUndefined();
    expect(core.snapshot().moves).toEqual([]);
  });

  test("a strand can wait on strands outside its own tree, and is your move when the last of them is done", () => {
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
    expect(() => core.block(strandNamed(core, "sc-3").id, "sc-1")).toThrow("those strands would wait on each other");
    expect(() => core.block(strandNamed(core, "sc-1").id, strandNamed(core, "sc-1").id)).toThrow("a strand can't wait on itself");
    expect(new Ponpoko(store).snapshot().strands.find((strand) => strand.name === "sc-1")?.own.why).toBe("waiting on sc-2");
    tick(60_000);
    core.done(strandNamed(core, "sc-2").id);
    expect(own("sc-1")).toBe("- waiting on sc-3");
    tick(60_000);
    core.done(strandNamed(core, "sc-3").id);
    expect(own("sc-1")).toBe("you sc-3 is done");
    core.unblock(strandNamed(core, "sc-1").id);
    expect(own("sc-1")).toBe("you sc-3 is done");
  });

  test("a strand's own requests outrank what it waits on, and marking the wait answers yours on it", () => {
    const { core, tick } = setup();
    core.add(undefined, "sc-2");
    core.status({ self: "tool:1", strand: "› sc-1", text: "building" });
    core.blockBy({ self: "tool:1", on: "sc-2" });
    expect(strandNamed(core, "sc-1").own.why).toBe("building");
    const sc1 = strandNamed(core, "sc-1").id;
    core.record("komux", [
      { type: "said", requests: [{ request: "r-turn", strand: sc1, to: { role: "owner", strand: sc1 }, what: "read reply", kind: "reply", from: "a1" }], replies: [] },
      { type: "player.activity", player: "a1", activity: "idle" },
    ]);
    expect(strandNamed(core, "sc-1").own.why).toBe("read reply");
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

describe("requests and roles", () => {
  test("rule 6: an agent's status stays on its own strand or under it", () => {
    const { core } = setup();
    core.add(undefined, "other");
    core.status({ self: "tool:1", strand: "› sc-1", text: "starting" });
    core.status({ self: "tool:1", strand: "pr", text: "opening the PR" });
    expect(strandNamed(core, "sc-1 › pr").own.why).toBe("opening the PR");
    expect(() => core.status({ self: "tool:1", strand: "other", text: "wandering off" })).toThrow("another Claude's work");
    expect(() => core.status({ self: "tool:1", strand: "› elsewhere", text: "wandering off" })).toThrow("another Claude's work");
    expect(core.snapshot().strands.map((strand) => strand.name)).not.toContain("elsewhere");
    core.done(strandNamed(core, "sc-1").id);
    expect(core.status({ self: "tool:1", strand: "other", text: "on to the next" })).toBe("other");
    expect([...core.model.roles.values()].filter((roles) => roles.agent === "a1")).toHaveLength(1);
  });

  test("an agent working under its own strand finishes only that one when it names none", () => {
    const { core } = setup();
    core.status({ self: "tool:1", strand: "› sc-1", text: "starting" });
    core.status({ self: "tool:1", strand: "review findings › 4", text: "fixing it" });
    core.status({ self: "tool:1", text: "still fixing it" });
    expect(strandNamed(core, "sc-1 › review findings › 4").own.why).toBe("still fixing it");
    core.doneBy({ self: "tool:1" }, "fixed");
    expect(core.snapshot().strands.map((strand) => strand.name)).toEqual(["sc-1", "review findings"]);
    expect(core.snapshot().counts.agents).toBe(0);
  });

  test("a role with nobody in it comes from the strand above, and one set lower down wins", () => {
    const { core } = setup();
    const story = core.add(undefined, "sc-1");
    const pr = core.add(story, "widgets#9");
    core.record("komux", [
      { type: "strand.role", strand: story, role: "agent", by: "a1" },
      { type: "said", requests: [{ request: "r1", strand: pr, to: { role: "agent", strand: pr }, what: "fix the comment" }], replies: [] },
    ]);
    const addressee = () => strandNamed(core, "sc-1 › widgets#9").open[0]!.by.id;
    expect(addressee()).toBe("a1");
    expect(strandNamed(core, "sc-1 › widgets#9").own.whose).toBe("agent");
    core.record("komux", [{ type: "strand.role", strand: pr, role: "agent", by: "a2" }]);
    expect(addressee()).toBe("a2");
    core.record("komux", [{ type: "said", requests: [{ request: "r2", strand: pr, to: { role: "owner", strand: pr }, what: "merge it" }], replies: [] }]);
    expect(strandNamed(core, "sc-1 › widgets#9").own).toMatchObject({ whose: "you", why: "merge it" });
    core.record("you", [{ type: "party.known", party: "person:sam", kind: "person", name: "Sam" }, { type: "strand.role", strand: story, role: "owner", by: "person:sam" }]);
    expect(strandNamed(core, "sc-1 › widgets#9").own.whose).toBe("agent");
  });

  test("a request to a group is yours while you're in it, until someone claims it", () => {
    const { core } = setup();
    const id = core.add(undefined, "widgets#9");
    core.record("github", [
      { type: "party.known", party: "group:team", kind: "group", name: "the team", members: ["you", "person:sam"] },
      { type: "said", requests: [{ request: "r1", strand: id, to: { group: "group:team" }, what: "review" }], replies: [] },
    ]);
    expect(strandNamed(core, "widgets#9").own.whose).toBe("you");
    core.record("github", [{ type: "said", requests: [], replies: [{ request: "r1", as: "progress", by: "person:sam" }] }]);
    expect(strandNamed(core, "widgets#9").own).toMatchObject({ whose: "person" });
    expect(strandNamed(core, "widgets#9").open[0]!.by.who).toBe("person:sam");
    core.record("github", [{ type: "said", requests: [], replies: [{ request: "r1", as: "passed" }] }]);
    expect(strandNamed(core, "widgets#9").own.whose).toBe("person");
    core.record("github", [{ type: "said", requests: [], replies: [{ request: "r1", as: "passed", to: { person: "you" } }] }]);
    expect(strandNamed(core, "widgets#9").own.whose).toBe("you");
    core.record("github", [{ type: "said", requests: [], replies: [{ request: "r1", as: "done" }] }]);
    expect(strandNamed(core, "widgets#9").own.whose).toBeUndefined();
  });

  test("a strand rolls up what's asked under it, grouped by who it's for", () => {
    const { core, tick } = setup();
    const story = core.add(undefined, "sc-52737");
    const pr = core.add(story, "widgets#9");
    core.record("komux", [
      { type: "party.known", party: "group:team", kind: "group", name: "the team" },
      { type: "said", requests: [{ request: "r1", strand: pr, to: { group: "group:team" }, what: "review" }], replies: [] },
    ]);
    expect(strandNamed(core, "sc-52737").rolled.tally).toBe("1 for the team");
    tick(60_000);
    core.record("komux", [{ type: "said", requests: [{ request: "r2", strand: story, to: { role: "owner", strand: story }, what: "read reply", kind: "reply", from: "a1" }], replies: [] }]);
    expect(strandNamed(core, "sc-52737").rolled.tally).toBe("1 for the team · 1 for you (read reply)");
  });
});

describe("ending a wait", () => {
  test("ends only the waits the caller opened, unless it names who, and works for an agent outside komux", async () => {
    const { core, hear } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/sc-1", labels: { strand: "sc-1" } }], agents: [{ paneId: 2, tabId: 1, state: "working" }, { paneId: 3, tabId: 1, state: "working" }], jobs: [] });
    core.present({ adapter: "komux", scope: "main/s1", players: ["pane:s1:2", "pane:s1:3"], spaces: [] });
    core.wait({ self: "komux:s1:2", strand: "sc-1", who: "you", kind: "you", what: "try it in the browser" });
    core.wait({ self: "komux:s1:2", strand: "sc-1", who: "CI", kind: "machine", what: "the build" });
    expect(() => core.wait({ self: "komux:s1:3", strand: "sc-1", over: true })).toThrow("no such wait");
    core.wait({ self: "komux:s1:3", strand: "sc-1", who: "CI", over: true });
    expect(() => core.wait({ self: "komux:s1:3", strand: "sc-1", who: "you", over: true })).toThrow("no such wait");
    core.wait({ self: "komux:s1:2", strand: "sc-1", over: true });
    expect(strandNamed(core, "sc-1").open.filter((move) => move.source === "agent")).toEqual([]);
    core.add(undefined, "side");
    core.wait({ strand: "side", who: "you", kind: "you", what: "look at it" });
    core.wait({ strand: "side", kind: "you", over: true });
    expect(strandNamed(core, "side").open).toEqual([]);
  });
});
