import { describe, expect, test } from "bun:test";
import type { Actions } from "./actions.ts";
import { TabController } from "./tab.ts";
import { harness, recordingActions, strandNamed } from "./test-harness.ts";

async function setup() {
  const { core, hear } = harness();
  await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-1", labels: { braid: "sc-1" } }], agents: [{ paneId: 2, tabId: 1, state: "done" }], jobs: [] });
  core.add(strandNamed(core, "sc-1").id, "tests");
  const { actions, calls } = recordingActions();
  const tab = new TabController(actions, () => 1_000_000);
  tab.setSnapshot(core.snapshot());
  return { core, tab, calls };
}

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));
const type = async (tab: TabController, text: string) => {
  for (const char of text) await tab.key({ name: char, text: char });
  await tab.key({ name: "return" });
};

describe("the command tab", () => {
  test("shows the tree of strands, opens a strand's moves, and goes to the selected strand", async () => {
    const { core, tab, calls } = await setup();
    const screen = plain(tab.view(120, 20)).join("\n");
    expect(screen).toContain(" ●*sc-1");
    expect(screen).toContain("   ●*tests");
    expect(screen).toContain("heard");
    await tab.key({ name: " ", text: " " });
    expect(plain(tab.view(120, 20)).join("\n")).toMatch(/\d\d:\d\d–\s+you\s+turn ended/);
    await tab.key({ name: "j" });
    await tab.key({ name: "return" });
    expect(calls).toEqual([["go", strandNamed(core, "sc-1 › tests").id]]);
  });

  test("adds, moves, finishes, snoozes, forgets after asking, notes and points", async () => {
    const { core, tab, calls } = await setup();
    const sc1 = strandNamed(core, "sc-1").id;
    const tests = strandNamed(core, "sc-1 › tests").id;
    await tab.key({ name: "a" });
    await type(tab, "docs");
    await tab.key({ name: "j" });
    await tab.key({ name: "m" });
    await type(tab, "epic 9");
    await tab.key({ name: "d" });
    await tab.key({ name: "z" });
    expect(plain(tab.view(100, 20)).at(-1)).toContain("snooze for");
    await tab.key({ name: "2" });
    await tab.key({ name: "x" });
    await tab.key({ name: "n" });
    await tab.key({ name: "x" });
    await tab.key({ name: "y" });
    await tab.key({ name: "k" });
    await tab.key({ name: "n" });
    await type(tab, "hi");
    await tab.key({ name: "p" });
    await type(tab, "SC-9");
    expect(calls).toEqual([
      ["add", sc1, "docs"],
      ["reparent", tests, "epic 9"],
      ["done", tests],
      ["snooze", tests, 1_000_000 + 60 * 60_000],
      ["forget", tests],
      ["note", sc1, "hi"],
      ["point", "/w/stories/sc-1", "SC-9"],
    ]);
  });

  test("says when the service is down", () => {
    const tab = new TabController({} as Actions);
    tab.setSnapshot(undefined);
    expect(plain(tab.view(100, 20)).join("\n")).toContain("ponpoko ✗");
  });
});
