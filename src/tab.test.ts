import { describe, expect, test } from "bun:test";
import type { Actions } from "./actions.ts";
import { inboxFacts } from "./inbox.ts";
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
  test("Work lists epics with their stories, then other work, folding a story's own strands, and goes to the picked strand", async () => {
    const { core, tab, calls } = await setup();
    const epic = core.add(undefined, "sc-100 › sc-101");
    core.record("you", [{ type: "strand.titled", strand: strandNamed(core, "sc-100").id, kind: "epic", title: "Smarter widget pricing" }]);
    core.record("you", [{ type: "strand.titled", strand: epic, title: "Gadget prices" }]);
    tab.setSnapshot(core.snapshot());
    const lines = plain(tab.view(120, 24));
    expect(lines).toHaveLength(24);
    expect(lines[0]).toMatch(/◆ ponpoko +1 Work 2 +2 Reviews 0 +3 Mentions 0 +\/ search all/);
    expect(lines[2]).toMatch(/^▎ Smarter widget pricing  sc-100 · epic · 1 story · 1 yours/);
    expect(lines[3]).toMatch(/^ {4}● Gadget prices +sc-101 +no one on it +now/);
    expect(lines[5]).toMatch(/^ {2}Other work/);
    expect(lines[6]).toMatch(/^ {4}● Widget CSV import +sc-1 +claude replied +now +tab 1 +▸1/);
    expect(lines.join("\n")).not.toContain("tests");
    expect(lines.at(-1)).toContain("⏎  nothing here; its work is in the strands under it");
    await tab.key({ name: "j" });
    await tab.key({ name: "j" });
    expect(tab.current()?.strand?.name).toBe("sc-1");
    expect(plain(tab.view(120, 24)).at(-1)).toMatch(/⏎  go to claude in tab 1 widgets +␣  its strands/);
    await tab.key({ name: " ", text: " " });
    expect(plain(tab.view(120, 24))[7]).toMatch(/^ {8}● tests +no one on it/);
    await tab.key({ name: "l", text: "l" });
    const log = plain(tab.view(120, 20));
    expect(log[0]).toMatch(/◆ log +newest first · \d+/);
    await tab.key({ name: "escape" });
    await tab.key({ name: "j" });
    await tab.key({ name: "return" });
    expect(calls).toEqual([["go", strandNamed(core, "sc-1 › tests").id]]);
  });

  test("a chain of stories queued behind one another folds into one line, and snoozed strands sit at the end", async () => {
    const { core, now } = harness();
    core.add(undefined, "sc-1 › sc-2");
    for (const [name, title] of [["sc-3", "Gadgets: fees by charge"], ["sc-4", "Gadgets: door fees"], ["sc-5", "Gadgets: accessorials"]]) core.add(strandNamed(core, "sc-1").id, name!), core.title(strandNamed(core, `sc-1 › ${name}`).id, title!);
    core.title(strandNamed(core, "sc-1 › sc-2").id, "Gadgets: import and export");
    core.record("you", [{ type: "strand.titled", strand: strandNamed(core, "sc-1").id, kind: "epic", title: "Gadgets" }]);
    core.block(strandNamed(core, "sc-1 › sc-3").id, strandNamed(core, "sc-1 › sc-2").id);
    core.block(strandNamed(core, "sc-1 › sc-4").id, strandNamed(core, "sc-1 › sc-3").id);
    core.block(strandNamed(core, "sc-1 › sc-5").id, strandNamed(core, "sc-1 › sc-4").id);
    core.add(undefined, "side");
    core.add(undefined, "dotfiles");
    core.snooze(strandNamed(core, "dotfiles").id, now() + 3_600_000);
    core.add(undefined, "zebra");
    const tab = new TabController(recordingActions().actions, now);
    tab.setSnapshot(core.snapshot());
    const screen = plain(tab.view(140, 30)).join("\n");
    expect(screen).toMatch(/● Gadgets: import and export +sc-2 [^\n]*\n {8}▸ then: fees by charge sc-3 → door fees sc-4 → accessorials sc-5 *\n/);
    expect(screen).toMatch(/Other work *\n {4}● side[^\n]*\n {4}● zebra[^\n]*\n {4}◷ dotfiles +snoozed till/);
    await tab.key({ name: "j" });
    await tab.key({ name: "j" });
    expect(tab.current()?.fold).toBe(true);
    await tab.key({ name: "return" });
    expect(plain(tab.view(140, 30)).join("\n")).toMatch(/▾ then: [^\n]*\n {6}⊘ Gadgets: fees by charge +sc-3 +waiting on sc-2/);
  });

  test("1 2 3 and tab switch areas, and / searches names and titles across all of them", async () => {
    const { core, tab, calls } = await setup();
    const pr = { repo: "acme/widgets", number: 1860, title: "Add a widget cache", url: "https://github.com/acme/widgets/pull/1860", author: "alice", assignees: [], requested: [], reviews: [], head: "c1" };
    let ids = 0;
    core.record("github", inboxFacts(core.knowledge(), { me: "octo", reviews: [pr], mentioned: [{ repo: "acme/widgets", number: 7, title: "Widget docs", url: "https://github.com/acme/widgets/pull/7", entries: [{ url: "https://github.com/acme/widgets/pull/7#c1", author: "sam", at: "2026-11-13T10:00:00Z", body: "@octo look", reacted: false }] }] }, (prefix) => `${prefix}gh${++ids}`));
    tab.setSnapshot(core.snapshot());
    expect(plain(tab.view(120, 20))[0]).toMatch(/1 Work 1 +2 Reviews 1 +3 Mentions 1/);
    await tab.key({ name: "3", text: "3" });
    expect(plain(tab.view(120, 20))[2]).toMatch(/▎ ● Widget docs +widgets#7 +sam mentioned you/);
    await tab.key({ name: "tab" });
    expect(tab.area).toBe("work");
    await tab.key({ name: "2", text: "2" });
    expect(tab.current()?.strand?.name).toBe("widgets#1860");
    await tab.key({ name: "/", text: "/" });
    for (const char of "widget") await tab.key({ name: char, text: char });
    const found = plain(tab.view(120, 20)).join("\n");
    expect(found).toContain("/ widget▏");
    expect(found).toMatch(/Widget CSV import +sc-1 .* Work/);
    expect(found).toMatch(/Add a widget cache +widgets#1860 +in reviews .* Reviews/);
    expect(found).toMatch(/Widget docs +widgets#7 +in mentions .* Mentions/);
    for (const char of " csv") await tab.key({ name: char, text: char });
    await tab.key({ name: "return" });
    expect(tab.area).toBe("work");
    expect(tab.current()?.strand?.name).toBe("sc-1");
    await tab.key({ name: "/", text: "/" });
    for (const char of "tests") await tab.key({ name: char, text: char });
    await tab.key({ name: "return" });
    expect(tab.current()?.strand?.name).toBe("tests");
    expect(plain(tab.view(120, 20)).join("\n")).toMatch(/▎ {7}● tests/);
    expect(calls).toEqual([]);
  });

  test("the card sits beside the list on a wide screen, and below it otherwise", async () => {
    const { tab } = await setup();
    const wide = plain(tab.view(180, 30));
    expect(wide[2]).toMatch(/Other work +│  ▎ sc-1/);
    expect(wide[3]).toMatch(/● Widget CSV import .* │  ▎ Widget CSV import/);
    const narrow = plain(tab.view(100, 30));
    expect(narrow[2]).not.toContain("│");
    expect(narrow.join("\n")).toMatch(/\n ▎ sc-1 *\n ▎ Widget CSV import/);
  });

  test("adds, moves, finishes, snoozes, forgets after asking, notes and points", async () => {
    const { core, tab, calls } = await setup();
    const sc1 = strandNamed(core, "sc-1").id;
    const tests = strandNamed(core, "sc-1 › tests").id;
    await tab.key({ name: "a" });
    await type(tab, "docs");
    await tab.key({ name: "A" });
    await type(tab, "sc-2");
    await tab.key({ name: " ", text: " " });
    await tab.key({ name: "j" });
    await tab.key({ name: "m" });
    await tab.key({ name: "/", text: "/" });
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

  test("m moves a strand under the parent picked from the list, starting on its current parent", async () => {
    const { core, tab, calls } = await setup();
    core.add(undefined, "sc-2");
    tab.setSnapshot(core.snapshot());
    const tests = strandNamed(core, "sc-1 › tests").id;
    await tab.key({ name: " ", text: " " });
    await tab.key({ name: "j" });
    await tab.key({ name: "m" });
    expect(plain(tab.view(100, 20)).join("\n")).toContain("move tests stays under sc-1");
    await tab.key({ name: "j" });
    expect(plain(tab.view(100, 20)).join("\n")).toContain("move tests can't go under itself");
    await tab.key({ name: "return" });
    expect(calls).toEqual([]);
    await tab.key({ name: "j" });
    expect(plain(tab.view(100, 20)).join("\n")).toContain("move tests under sc-2");
    await tab.key({ name: "return" });
    expect(calls).toEqual([["reparent", tests, strandNamed(core, "sc-2").id]]);
    expect(tab.current()?.strand?.id).toBe(tests);
    await tab.key({ name: "m" });
    await tab.key({ name: "escape" });
    await tab.key({ name: "m" });
    await tab.key({ name: "t", text: "t" });
    expect(calls).toEqual([
      ["reparent", tests, strandNamed(core, "sc-2").id],
      ["reparent", tests, ""],
    ]);
  });

  test("w makes a strand wait on the strand picked from the list, and Enter on it again stops the wait", async () => {
    const { core, tab, calls } = await setup();
    core.add(undefined, "sc-2");
    tab.setSnapshot(core.snapshot());
    const sc1 = strandNamed(core, "sc-1").id;
    const sc2 = strandNamed(core, "sc-2").id;
    await tab.key({ name: "w" });
    expect(plain(tab.view(100, 20)).join("\n")).toContain("sc-1 can't wait on itself");
    await tab.key({ name: "j" });
    await tab.key({ name: "j" });
    expect(plain(tab.view(100, 20)).join("\n")).toContain("sc-1 waits on sc-2");
    await tab.key({ name: "return" });
    expect(calls).toEqual([["block", sc1, sc2]]);
    expect(tab.current()?.strand?.id).toBe(sc1);
    core.block(sc1, sc2);
    tab.setSnapshot(core.snapshot());
    expect(plain(tab.view(100, 20)).join("\n")).toMatch(/● sc-2 +no one on it[^\n]*\n {8}▸ then: Widget CSV import sc-1/);
    await tab.key({ name: "j" });
    await tab.key({ name: "return" });
    await tab.key({ name: "j" });
    expect(tab.current()?.strand?.id).toBe(sc1);
    await tab.key({ name: "w" });
    await tab.key({ name: "j" });
    await tab.key({ name: "j" });
    expect(plain(tab.view(100, 20)).join("\n")).toContain("sc-1 stops waiting on sc-2");
    await tab.key({ name: "return" });
    await tab.key({ name: "w" });
    await tab.key({ name: "c", text: "c" });
    await tab.key({ name: "w" });
    await tab.key({ name: "/", text: "/" });
    await type(tab, "sc-9");
    expect(calls.slice(1)).toEqual([["unblock", sc1, sc2], ["unblock", sc1], ["block", sc1, "sc-9"]]);
  });

  test("the footer says what Enter will do on the picked strand, with only the keys that apply", async () => {
    const { core, tab } = await setup();
    core.add(undefined, "epic 9 › sc-2");
    tab.setSnapshot(core.snapshot());
    const footer = () => plain(tab.view(160, 30)).at(-1)!.trim();
    expect(tab.current()?.strand?.name).toBe("epic 9");
    expect(footer()).toMatch(/^⏎  nothing here; its work is in the strands under it +d  done/);
    await tab.key({ name: "j" });
    await tab.key({ name: "j" });
    expect(footer()).toBe("⏎  go to claude in tab 1 widgets    ␣  its strands    d  done    z  snooze    a  add    m  move    w  wait on    /  search    ?  more");
    await tab.key({ name: " ", text: " " });
    await tab.key({ name: "j" });
    expect(footer()).toMatch(/^⏎  open a tab at \/w\/stories\/sc-1 +d  done/);
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

describe("reviews from GitHub in the command tab", () => {
  async function pooled() {
    const { core } = harness();
    const pr = { repo: "acme/widgets", number: 1860, title: "Add a widget cache", url: "https://github.com/acme/widgets/pull/1860", author: "alice", assignees: [], requested: [], reviews: [], head: "c1" };
    let ids = 0;
    core.record("github", inboxFacts(core.knowledge(), { me: "octo", reviews: [pr], mentioned: [] }, (prefix) => `${prefix}gh${++ids}`));
    const { actions, calls } = recordingActions();
    const tab = new TabController(actions, () => 1_000_000, "reviews");
    tab.setSnapshot(core.snapshot());
    return { tab, calls };
  }

  test("asks before taking a review nobody has, and can open it without assigning", async () => {
    const { tab, calls } = await pooled();
    expect(plain(tab.view(160, 20)).join("\n")).toMatch(/take widgets#1860: assign yourself and open it in pr-review +y  take it/);
    await tab.key({ name: "return" });
    const asking = plain(tab.view(120, 20)).join("\n");
    expect(asking).toContain("widgets#1860 has no reviewer yet");
    expect(asking).toContain("assign yourself and open it");
    await tab.key({ name: "o", text: "o" });
    expect(calls).toEqual([["go", "github:review:acme/widgets#1860"]]);
    await tab.key({ name: "return" });
    await tab.key({ name: "y", text: "y" });
    expect(calls.slice(1)).toEqual([
      ["assign", "github:review:acme/widgets#1860"],
      ["go", "github:review:acme/widgets#1860"],
    ]);
    await tab.key({ name: "return" });
    await tab.key({ name: "escape" });
    await tab.key({ name: "y", text: "y" });
    expect(calls).toHaveLength(5);
  });
});
