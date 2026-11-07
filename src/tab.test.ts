import { describe, expect, test } from "bun:test";
import type { Actions } from "./actions.ts";
import { TabController } from "./tab.ts";
import { harness, recordingActions } from "./test-harness.ts";

async function setup() {
  const { core, hear } = harness();
  await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-1" }], agents: [{ paneId: 2, tabId: 1, state: "done" }], jobs: [] });
  const { actions, calls } = recordingActions();
  const tab = new TabController(actions, () => 1_000_000);
  tab.setSnapshot(core.snapshot());
  return { tab, calls };
}

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));

describe("the command tab", () => {
  test("lists braids and strands, and goes to the selected strand", async () => {
    const { tab, calls } = await setup();
    const screen = plain(tab.view(100, 20)).join("\n");
    expect(screen).toContain("▾ SC-1");
    expect(screen).toContain("●*agent pane 2");
    expect(screen).toContain("heard");
    await tab.key({ name: "j" });
    await tab.key({ name: "return" });
    expect(calls).toEqual([["go", "pane:s1:2", "/w/stories/sc-1"]]);
  });

  test("snoozes, forgets after asking, notes and points", async () => {
    const { tab, calls } = await setup();
    await tab.key({ name: "j" });
    await tab.key({ name: "z" });
    expect(plain(tab.view(100, 20)).at(-1)).toContain("snooze for");
    await tab.key({ name: "2" });
    await tab.key({ name: "x" });
    await tab.key({ name: "n" });
    await tab.key({ name: "x" });
    await tab.key({ name: "y" });
    await tab.key({ name: "k" });
    await tab.key({ name: "n" });
    for (const text of "hi") await tab.key({ name: text, text });
    await tab.key({ name: "return" });
    await tab.key({ name: "p" });
    for (const text of "SC-9") await tab.key({ name: text, text });
    await tab.key({ name: "return" });
    expect(calls).toEqual([
      ["snooze", "pane:s1:2", 1_000_000 + 60 * 60_000],
      ["forget", "pane:s1:2"],
      ["note", "sc-1", "hi"],
      ["point", "/w/stories/sc-1", "sc-9"],
    ]);
  });

  test("says when the service is down", () => {
    const tab = new TabController({} as Actions);
    tab.setSnapshot(undefined);
    expect(plain(tab.view(100, 20)).join("\n")).toContain("ponpoko ✗");
  });
});
