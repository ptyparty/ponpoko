import { describe, expect, test } from "bun:test";
import { refreshEpic } from "./actions.ts";
import { handle } from "./server.ts";
import { readEpicStories, type EpicStory } from "./shortcut.ts";
import { harness, strandNamed } from "./test-harness.ts";

const story = (id: number, over: Partial<EpicStory> = {}): EpicStory => ({ id, name: `Story ${id}`, url: `https://app.shortcut.com/acme/story/${id}/x`, completed: false, started: false, blocks: [], ...over });

describe("importing an epic from Shortcut", () => {
  test("reads stories and the stories each one blocks from Shortcut's answer", () => {
    const body = [
      { id: 2, name: "Two", app_url: "https://app.shortcut.com/acme/story/2/two", completed: false, started: true, archived: false, story_links: [{ verb: "blocks", subject_id: 2, object_id: 3 }, { verb: "blocks", subject_id: 1, object_id: 2 }, { verb: "relates to", subject_id: 2, object_id: 4 }] },
      { id: 5, name: "Gone", archived: true, story_links: [] },
    ];
    expect(readEpicStories(body)).toEqual([{ id: 2, name: "Two", url: "https://app.shortcut.com/acme/story/2/two", completed: false, started: true, blocks: [3] }]);
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

  test("a planned strand is nobody's move until someone takes a turn on it or you start it", () => {
    const { core } = harness();
    const id = core.add(undefined, "sc-1");
    core.record("shortcut", [{ type: "strand.planned", strand: id, planned: true }]);
    expect(strandNamed(core, "sc-1").own.whose).toBeUndefined();
    expect(core.snapshot().counts.yours).toBe(0);
    core.start(id);
    expect(strandNamed(core, "sc-1").own).toMatchObject({ whose: "you", why: "no one on it" });
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
});
