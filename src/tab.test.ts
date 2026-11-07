import { describe, expect, test } from "bun:test";
import type { Actions } from "./actions.ts";
import { TabController } from "./tab.ts";
import { harness, recordingActions, strandNamed } from "./test-harness.ts";

async function setup() {
  const { core, hear } = harness();
  await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-1", labels: { strand: "sc-1" } }], agents: [{ paneId: 2, tabId: 1, state: "done" }], jobs: [] });
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
    await tab.key({ name: "A" });
    await type(tab, "sc-2");
    await tab.key({ name: "j" });
    await tab.key({ name: "m" });
    await type(tab, "epic 9");
    await tab.key({ name: "d" });
    await tab.key({ name: "z" });
    expect(plain(tab.view(100, 20)).at(-1)).toContain("snooze  1 15m");
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
      ["add", undefined, "sc-2"],
      ["reparent", tests, "epic 9"],
      ["done", tests],
      ["snooze", tests, 1_000_000 + 60 * 60_000],
      ["forget", tests],
      ["note", sc1, "hi"],
      ["point", "/w/stories/sc-1", "SC-9"],
    ]);
  });

  test("the footer says what Enter will do on the picked strand", async () => {
    const { core, tab } = await setup();
    core.add(undefined, "epic 9 › sc-2");
    tab.setSnapshot(core.snapshot());
    const footer = () => plain(tab.view(140, 30)).at(-2)!.trim();
    expect(footer()).toBe("⏎ go to claude in tab 1 widgets");
    await tab.key({ name: "j" });
    expect(footer()).toBe("⏎ open a tab at /w/stories/sc-1");
    for (const _ of [1, 2, 3]) await tab.key({ name: "k" });
    expect(tab.current()?.strand?.name).toBe("epic 9");
    expect(footer()).toBe("⏎ nothing here; its work is in the strands under it");
  });

  test("f starts a fresh Claude on the picked strand", async () => {
    const { core, tab, calls } = await setup();
    await tab.key({ name: "f" });
    expect(calls).toEqual([["pickUp", strandNamed(core, "sc-1").id, "fresh"]]);
  });

  test("snoozes the picked strand until a typed time", async () => {
    const { core, tab, calls } = await setup();
    await tab.key({ name: "z" });
    await tab.key({ name: "t" });
    for (const char of "30m") await tab.key({ name: char, text: char });
    expect(plain(tab.view(120, 20)).at(-1)).toContain("snooze until: 30m▏  → ");
    await tab.key({ name: "return" });
    expect(calls).toEqual([["snooze", strandNamed(core, "sc-1").id, 1_000_000 + 30 * 60_000]]);
  });

  test("says when the service is down", () => {
    const tab = new TabController({} as Actions);
    tab.setSnapshot(undefined);
    expect(plain(tab.view(100, 20)).join("\n")).toContain("ponpoko ✗");
  });

  test("Enter on a strand no one is on offers to resume its last Claude or start a fresh one", async () => {
    const { core, hear } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-1", labels: { strand: "sc-1" } }], agents: [{ paneId: 2, tabId: 1, state: "done", sessionId: "c2" }], jobs: [] });
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    const { actions, calls } = recordingActions();
    const tab = new TabController(actions, () => 1_000_000);
    tab.setSnapshot(core.snapshot());
    await tab.key({ name: "return" });
    expect(plain(tab.view(120, 20)).at(-1)).toContain("no one is on it · ⏎ resume claude from just now   f start a fresh Claude");
    await tab.key({ name: "return" });
    await tab.key({ name: "return" });
    await tab.key({ name: "f" });
    core.add(strandNamed(core, "sc-1").id, "docs");
    tab.setSnapshot(core.snapshot());
    await tab.key({ name: "return" });
    expect(tab.mode.kind).toBe("list");
    const id = strandNamed(core, "sc-1").id;
    expect(calls).toEqual([
      ["pickUp", id, "resume"],
      ["pickUp", id, "fresh"],
      ["go", id],
    ]);
  });
});
