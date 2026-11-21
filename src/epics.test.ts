import { describe, expect, test } from "bun:test";
import { refreshEpic } from "./actions.ts";
import { handle } from "./server.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEpicStories, readWorkflowStates, readyStates, stageOf, type EpicStory } from "./shortcut.ts";
import { epicGraph, findEpic } from "./epic.ts";
import { harness, strandNamed } from "./test-harness.ts";

const story = (id: number, over: Partial<EpicStory> = {}): EpicStory => ({ id, name: `Story ${id}`, url: `https://app.shortcut.com/acme/story/${id}/x`, completed: false, started: false, blocks: [], ...over });

describe("importing an epic from Shortcut", () => {
  test("reads stories and the stories each one blocks from Shortcut's answer", () => {
    const body = [
      { id: 2, name: "Two", app_url: "https://app.shortcut.com/acme/story/2/two", completed: false, started: true, archived: false, story_links: [{ verb: "blocks", subject_id: 2, object_id: 3 }, { verb: "blocks", subject_id: 1, object_id: 2 }, { verb: "relates to", subject_id: 2, object_id: 4 }] },
      { id: 5, name: "Gone", archived: true, story_links: [] },
    ];
    expect(readEpicStories(body)).toEqual([{ id: 2, name: "Two", url: "https://app.shortcut.com/acme/story/2/two", completed: false, started: true, blocks: [3], blockedBy: [{ id: 1, done: false }], stage: "started" }]);
    expect(readEpicStories({ message: "nope" })).toEqual([]);
  });

  test("brings an epic's stories in under it once, with their blocks as waits, planned unless done, and keeps stories it already knows", async () => {
    const asked: number[] = [];
    const stories = [story(10, { blocks: [11, 12] }), story(11, { started: true }), story(12), story(13, { completed: true }), story(14)];
    const { core, bridge } = harness(1_000_000, undefined, undefined, async () => undefined, true, async (epic) => (asked.push(epic), stories));
    core.add(undefined, "sc-9");
    core.add(undefined, "sc-11");
    core.add(undefined, "elsewhere › sc-14");
    core.record("you", [{ type: "strand.titled", strand: strandNamed(core, "sc-9").id, kind: "epic", title: "Gadgets" }]);
    await bridge.publish();
    await Bun.sleep(5);
    await bridge.publish();
    await Bun.sleep(5);
    expect(asked).toEqual([9]);
    const epic = strandNamed(core, "sc-9");
    expect(core.snapshot().strands.filter((strand) => strand.parent === epic.id).map((strand) => `${strand.name} ${strand.title} ${strand.planned ? "planned" : strand.own.why}`)).toEqual(["sc-11 Story 11 waiting on sc-10", "sc-10 Story 10 planned", "sc-12 Story 12 planned"]);
    expect(strandNamed(core, "elsewhere › sc-14").title).toBe("Story 14");
    expect(core.snapshot().ended?.map((strand) => [strand.name, strand.parent === epic.id])).toEqual([["sc-13", true]]);
    const sc12 = strandNamed(core, "sc-9 › sc-12");
    expect(Object.keys(sc12.blockedOn)).toEqual([strandNamed(core, "sc-9 › sc-10").id]);
    expect(sc12.own.why).toBe("waiting on sc-10");
    expect(strandNamed(core, "sc-9 › sc-10").links.find((link) => link.adapter === "shortcut")?.ref).toBe("https://app.shortcut.com/acme/story/10/x");
    expect(epic.links.find((link) => link.adapter === "shortcut")?.ref).toBe("https://app.shortcut.com/acme/epic/9");
    expect(core.snapshot().moves.map((strand) => strand.name)).not.toContain("sc-10");
    expect(epic.rolled.whose).toBeUndefined();
  });

  test("a planned strand is nobody's move, and starting it lets requests make it yours", () => {
    const { core } = harness();
    const id = core.add(undefined, "sc-1");
    core.record("shortcut", [{ type: "strand.planned", strand: id, planned: true }]);
    expect(strandNamed(core, "sc-1").own.whose).toBeUndefined();
    expect(core.snapshot().counts.yours).toBe(0);
    core.start(id);
    expect(strandNamed(core, "sc-1").own).toMatchObject({ why: "not started", unstarted: true });
    expect(strandNamed(core, "sc-1").own.whose).toBeUndefined();
    core.wait({ strand: "sc-1", who: "you", kind: "you", what: "write the plan" }, "you");
    expect(strandNamed(core, "sc-1").own).toMatchObject({ whose: "you", why: "write the plan" });
    core.record("shortcut", [{ type: "strand.planned", strand: id, planned: true }]);
    core.wait({ strand: "sc-1", who: "Sam", kind: "person", what: "a question" }, "you");
    expect(strandNamed(core, "sc-1").planned).toBeUndefined();
  });
  test("a refresh adds stories and dependencies ponpoko lacks, keeps its own, and leaves done strands but for links", async () => {
    const { core } = harness();
    const epic = core.add(undefined, "sc-9");
    core.record("you", [{ type: "strand.titled", strand: epic, kind: "epic", title: "Gadgets" }]);
    const ten = core.add(epic, "sc-10");
    const eleven = core.add(epic, "sc-11");
    const twelve = core.add(undefined, "sc-12");
    const thirteen = core.add(epic, "sc-13");
    core.block(eleven, thirteen);
    core.done(thirteen);
    const send = async (request: Parameters<typeof handle>[1]) => {
      const response = handle(core, request);
      if (!response.ok) throw new Error(response.error);
      return response.result;
    };
    const stories = [story(10, { blocks: [11, 13] }), story(11), story(12, { started: true }), story(13, { completed: true }), story(14, { started: true, blocks: [12] })];
    expect(await refreshEpic(epic, 9, async () => stories, send)).toBe("From Shortcut: 1 new story, 3 new dependencies, 1 story moved under the epic");
    const fourteen = strandNamed(core, "sc-9 › sc-14");
    expect(fourteen.planned).toBe(true);
    expect(strandNamed(core, "sc-9 › sc-12").blockedOn).toHaveProperty(fourteen.id);
    expect(Object.keys(strandNamed(core, "sc-9 › sc-11").blockedOn).sort()).toEqual([ten, thirteen].sort());
    const done = core.model.strands.get(thirteen)!;
    expect([done.title, Object.keys(done.blockedOn)]).toEqual([undefined, [ten]]);
    expect(strandNamed(core, "sc-9 › sc-10").title).toBe("Story 10");
    expect(await refreshEpic(epic, 9, async () => stories, send)).toBe("From Shortcut: 0 new stories, 0 new dependencies");
    expect(await refreshEpic(epic, 9, async () => [], send)).toBe("From Shortcut: 0 new stories, 0 new dependencies");
    expect(Object.keys(strandNamed(core, "sc-9 › sc-11").blockedOn)).toHaveLength(2);
    expect(twelve).toBe(strandNamed(core, "sc-9 › sc-12").id);
  });
  test("imports land in the service one at a time, and never bring back a wait or story you removed", () => {
    const { core } = harness();
    const epic = core.add(undefined, "sc-9");
    const stories = [story(10, { blocks: [11] }), story(11), story(12)];
    expect(core.importEpic(epic, 9, stories)).toBe("3 new stories, 1 new dependency");
    expect(core.importEpic(epic, 9, stories)).toBe("0 new stories, 0 new dependencies");
    expect(core.snapshot().strands.filter((strand) => strand.name === "sc-10")).toHaveLength(1);
    const eleven = strandNamed(core, "sc-9 › sc-11").id;
    core.unblock(eleven);
    core.forget(strandNamed(core, "sc-9 › sc-12").id);
    expect(core.importEpic(epic, 9, stories)).toBe("0 new stories, 0 new dependencies");
    expect(strandNamed(core, "sc-9 › sc-11").blockedOn).toEqual({});
    expect(core.snapshot().strands.some((strand) => strand.name === "sc-12")).toBe(false);
  });

  test("a move on a strand under a planned story starts the story", () => {
    const { core } = harness();
    const epic = core.add(undefined, "sc-9");
    core.importEpic(epic, 9, [story(10)]);
    core.add(strandNamed(core, "sc-9 › sc-10").id, "implement");
    core.wait({ strand: "sc-9 › sc-10 › implement", who: "CI", kind: "machine", what: "build" }, "you");
    expect(strandNamed(core, "sc-9 › sc-10").planned).toBeUndefined();
  });
  test("reads each story's workflow state: ready states by name from the config, anything started or done by its type", () => {
    const states = readWorkflowStates([{ states: [{ id: 1, name: "Backlog", type: "backlog" }, { id: 2, name: "In Review", type: "backlog" }, { id: 3, name: "Ready", type: "unstarted" }, { id: 4, name: "In Development", type: "started" }, { id: 5, name: "Done", type: "done" }, { id: 6, name: "On Deck", type: "unstarted" }] }]);
    const body = [1, 2, 3, 4, 5, 6].map((state) => ({ id: state * 10, name: `S${state}`, workflow_state_id: state, story_links: [] }));
    expect(readEpicStories(body, states).map((story) => story.stage)).toEqual(["later", "later", "ready", "started", "done", "later"]);
    expect(readEpicStories(body, states, ["ready", "On Deck"]).map((story) => story.stage)).toEqual(["later", "later", "ready", "started", "done", "ready"]);
    expect(stageOf({ name: "Not Ready", type: "unstarted" }, { completed: false, started: false })).toBe("later");
    expect(stageOf({ name: "ready for development", type: "unstarted" }, { completed: false, started: false })).toBe("ready");
    const dir = mkdtempSync(join(tmpdir(), "ponpoko-config-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ shortcut: { readyStates: ["Ready", "On Deck"] } }));
    expect(readyStates(join(dir, "config.json"))).toEqual(["Ready", "On Deck"]);
    expect(readyStates(join(dir, "missing.json"))).toEqual(["Ready", "Ready for Development"]);
  });

  test("brings in only stories ready to work on, keeps strands that exist for other reasons, and drops untouched ones that aren't ready", () => {
    const { core } = harness();
    const epic = core.add(undefined, "sc-9");
    const stage = (id: number, value: EpicStory["stage"], over: Partial<EpicStory> = {}) => story(id, { stage: value, ...over });
    expect(core.importEpic(epic, 9, [stage(10, "ready", { blocks: [11, 12] }), stage(11, "started"), stage(12, "ready"), stage(13, "ready"), stage(14, "done")])).toBe("5 new stories, 2 new dependencies");
    core.add(undefined, "sc-15");
    core.note(strandNamed(core, "sc-9 › sc-13").id, "keep this one");
    const stories = [stage(10, "later", { blocks: [11, 12, 16] }), stage(11, "later"), stage(12, "later"), stage(13, "later"), stage(14, "done"), stage(15, "later"), stage(16, "later")];
    core.wait({ strand: "sc-9 › sc-11", who: "Sam", kind: "person", what: "a question" }, "you");
    expect(core.importEpic(epic, 9, stories)).toBe("0 new stories, 0 new dependencies, 1 story moved under the epic, 2 stories not ready yet dropped");
    expect(core.snapshot().strands.filter((strand) => strand.parent === epic).map((strand) => strand.name).sort()).toEqual(["sc-11", "sc-13", "sc-15"]);
    expect(Object.keys(strandNamed(core, "sc-9 › sc-11").blockedOn)).toEqual([]);
    expect(core.importEpic(epic, 9, [stage(10, "ready"), stage(12, "later")])).toBe("1 new story, 0 new dependencies");
    expect(strandNamed(core, "sc-9 › sc-10").planned).toBe(true);
  });
  test("a story blocked by one that isn't in ponpoko waits on it by name until it comes in or is done", () => {
    const { core } = harness();
    const epic = core.add(undefined, "sc-9");
    const stories = (blockerStage: EpicStory["stage"], done = false) => [story(10, { stage: "ready", blockedBy: [{ id: 11, done }, { id: 20, done: false }] }), story(11, { stage: blockerStage, blocks: [10] })];
    core.add(undefined, "sc-20");
    core.importEpic(epic, 9, stories("later"));
    const ten = strandNamed(core, "sc-9 › sc-10");
    expect(Object.keys(ten.heldBy ?? {})).toEqual(["sc-11"]);
    expect(ten.own.why).toBe("waiting on sc-20");
    expect(Object.keys(ten.blockedOn)).toEqual([strandNamed(core, "sc-20").id]);
    core.done(strandNamed(core, "sc-20").id);
    expect(strandNamed(core, "sc-9 › sc-10").own.why).toBe("waiting on sc-11 (not ready yet)");
    const snapshot = core.snapshot();
    expect(epicGraph(snapshot, findEpic(snapshot, "sc-9")!).nodes.find((node) => node.name === "sc-10")?.state).toBe("later");
    expect(core.importEpic(epic, 9, stories("ready"))).toBe("1 new story, 1 new dependency");
    expect(strandNamed(core, "sc-9 › sc-10").heldBy).toBeUndefined();
    expect(strandNamed(core, "sc-9 › sc-10").own.why).toBe("waiting on sc-11");
    const other = core.add(undefined, "sc-8");
    core.importEpic(other, 8, [story(30, { stage: "ready", blockedBy: [{ id: 31, done: false }] })]);
    expect(strandNamed(core, "sc-8 › sc-30").own.why).toBe("waiting on sc-31 (not ready yet)");
    core.importEpic(other, 8, [story(30, { stage: "ready", blockedBy: [{ id: 31, done: true }] })]);
    expect(strandNamed(core, "sc-8 › sc-30").own.why).toBe("ready to start");
  });
});
