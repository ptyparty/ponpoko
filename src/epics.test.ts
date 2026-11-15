import { describe, expect, test } from "bun:test";
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

  test("brings an epic's stories in under it once, with their blocks as waits, planned unless started, and keeps stories it already knows", async () => {
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
});
