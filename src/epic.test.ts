import { describe, expect, test } from "bun:test";
import { bestLayout, drawGraph, EpicController, epicGraph, findEpic, layoutGraph, mermaid } from "./epic.ts";
import { TabController } from "./tab.ts";
import { harness, recordingActions, strandNamed } from "./test-harness.ts";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));

function epic() {
  const { core, now } = harness();
  const id = core.add(undefined, "sc-1");
  core.record("you", [{ type: "strand.titled", strand: id, kind: "epic", title: "Gadgets" }]);
  const story = (number: number, title: string) => {
    const made = core.add(id, `sc-${number}`);
    core.record("you", [{ type: "strand.titled", strand: made, kind: "story", title }]);
    return made;
  };
  const ids = { 2: story(2, "Gadget opt-in"), 3: story(3, "Gadget toggle"), 4: story(4, "Gadget fees"), 5: story(5, "Gadget cards"), 6: story(6, "Remove the toggle"), 7: story(7, "Gadget profile"), 8: story(8, "Gadget docs") };
  for (const [strand, on] of [[3, 2], [4, 3], [5, 3], [6, 4], [6, 5]] as const) core.block(ids[strand], ids[on]);
  core.record("shortcut", [
    { type: "strand.planned", strand: ids[4], planned: true },
    { type: "strand.planned", strand: ids[6], planned: true },
    { type: "strand.planned", strand: ids[7], planned: true },
    { type: "link.added", link: "l-sc4", strand: ids[4], adapter: "shortcut", ref: "https://app.shortcut.com/acme/story/4/fees" },
  ]);
  core.wait({ strand: "sc-1 › sc-3", who: "the team", kind: "person", what: "reviewing widgets#9" }, "you");
  core.done(ids[2]);
  core.wait({ strand: "sc-1 › sc-5", who: "you", kind: "you", what: "check it" }, "you");
  core.snooze(ids[8], now() + 60_000);
  return { core, now, ids };
}

describe("an epic's dependencies", () => {
  test("a story someone has worked on with nothing asked now is quiet, apart from one nobody has started", () => {
    const { core } = epic();
    core.wait({ strand: "sc-1 › sc-7", who: "you", kind: "you", what: "look" }, "you");
    core.wait({ strand: "sc-1 › sc-7", over: true }, "you");
    const graph = epicGraph(core.snapshot(), findEpic(core.snapshot(), "1")!);
    expect(Object.fromEntries(graph.nodes.map((node) => [node.name, node.state]))).toMatchObject({ "sc-7": "quiet", "sc-8": "ready" });
  });

  test("lays stories out left to right by what blocks what, forks and joins, with unlinked stories in a row of their own", () => {
    const { core } = epic();
    const snapshot = core.snapshot();
    const graph = epicGraph(snapshot, findEpic(snapshot, "1")!);
    expect(Object.fromEntries(graph.nodes.map((node) => [node.name, node.state]))).toEqual({ "sc-2": "done", "sc-3": "review", "sc-4": "later", "sc-5": "mine", "sc-6": "later", "sc-7": "ready", "sc-8": "ready" });
    const layout = layoutGraph(graph);
    expect(layout.placed.map((at) => `${at.node.name} ${at.col},${at.row}`)).toEqual(["sc-2 0,0", "sc-3 1,0", "sc-4 2,0", "sc-5 2,1", "sc-6 3,0"]);
    expect(layout.loose.map((node) => node.name)).toEqual(["sc-7", "sc-8"]);
    expect(mermaid(graph)).toContain('flowchart LR\n  ssc_2["2 Gadget opt-in"]:::done');
    expect(mermaid(graph)).toContain("  ssc_3 --> ssc_4\n  ssc_3 --> ssc_5");
    expect(mermaid(graph)).toContain("  classDef later fill:#181b24,stroke:#565e72");
  });

  test("draws boxes and arrows under a key, and moves between boxes", async () => {
    const { core, ids } = epic();
    const { actions, calls } = recordingActions();
    const copied: string[] = [];
    const view = new EpicController(actions, "sc-1", async (text) => void copied.push(text));
    view.setSnapshot(core.snapshot());
    const screen = plain(view.view(150, 45));
    expect(screen[0]).toMatch(/^ Gadgets  sc-1 · 7 stories · 1 done · 1 in review · 1 in progress · 2 ready/);
    expect(screen[2]).toContain("✓ done   ⊘ in review or waiting on someone   ● yours   ◐ an agent's   ◌ nothing asked   ○ ready to start   · not started   ─▶ unblocks");
    expect(screen.join("\n")).toMatch(/│ ✓ 2 +│─────▶│ ⊘ 3/);
    expect(screen.join("\n")).toMatch(/│ ⊘ 3 +│──┬──▶│ · 4 +│──┬──▶│ · 6/);
    expect(screen.join("\n")).toMatch(/└──▶│ ● 5 +│──┘/);
    expect(screen.join("\n")).toMatch(/│ ○ 7 +│ +│ ○ 8 +│/);
    expect(screen.at(-1)).toContain("⏎  sc-2 is done");
    await view.key({ name: "right" });
    await view.key({ name: "right" });
    expect(view.picked()?.name).toBe("sc-4");
    expect(plain(view.view(150, 45)).join("\n")).toMatch(/▎ sc-4  Gadget fees *\n ▎ planned · waiting on sc-3 · waits on 3 · unblocks 6/);
    await view.key({ name: "down" });
    expect(view.picked()?.name).toBe("sc-5");
    await view.key({ name: "up" });
    await view.key({ name: "s", text: "s" });
    await view.key({ name: "o", text: "o" });
    await view.key({ name: "w", text: "w" });
    for (const char of "sc-7") await view.key({ name: char, text: char });
    await view.key({ name: "return" });
    await view.key({ name: "return" });
    await view.key({ name: "m", text: "m" });
    expect(calls).toEqual([["start", ids[4]], ["open", "https://app.shortcut.com/acme/story/4/fees"], ["block", ids[4], "sc-7"], ["go", ids[4]]]);
    expect(copied[0]).toStartWith("flowchart LR");
    for (const _ of [1, 2, 3, 4]) await view.key({ name: "down" });
    expect(view.picked()?.name).toBe("sc-8");
    await view.key({ name: "left" });
    expect(view.picked()?.name).toBe("sc-7");
    await view.key({ name: "r", text: "r" });
    expect(calls.at(-1)).toEqual(["refreshEpic", strandNamed(core, "sc-1").id, 1]);
    expect(plain(view.view(150, 45)).at(-1)).toBe(" From Shortcut: 0 new stories, 0 new dependencies");
    expect(await view.key({ name: "escape" })).toBe("close");
  });

  test("scrolls and narrows its boxes on a small screen", async () => {
    const { core } = epic();
    const view = new EpicController(recordingActions().actions, "sc-1");
    view.setSnapshot(core.snapshot());
    const small = plain(view.view(100, 30));
    expect(small).toHaveLength(30);
    expect(small.join("\n")).toContain("scrolls ▸");
    for (const _ of [1, 2, 3]) await view.key({ name: "right" });
    expect(view.picked()?.name).toBe("sc-6");
    expect(plain(view.view(100, 30)).join("\n")).toContain("· 6");
  });

  test("Enter on an epic in the command tab's Work opens it, and esc comes back", async () => {
    const { core } = epic();
    const tab = new TabController(recordingActions().actions, () => 1_000_000);
    tab.setSnapshot(core.snapshot());
    expect(tab.current()?.strand?.name).toBe("sc-1");
    expect(plain(tab.view(150, 45)).at(-1)).toContain("⏎  show its stories and what blocks what");
    await tab.key({ name: "return" });
    expect(plain(tab.view(150, 45))[0]).toMatch(/^ Gadgets  sc-1 · 7 stories/);
    await tab.key({ name: "escape" });
    expect(tab.mode.kind).toBe("list");
    expect(strandNamed(core, "sc-1").kind).toBe("epic");
  });
  test("arrows that cross keep going straight instead of looking like a join, and only stories are boxes", () => {
    const { core } = harness();
    const id = core.add(undefined, "sc-1");
    core.record("you", [{ type: "strand.titled", strand: id, kind: "epic", title: "Crossing" }]);
    const numbers = [32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44];
    const made = Object.fromEntries(numbers.map((number) => [number, core.add(id, `sc-${number}`)]));
    core.add(id, "notes for the epic");
    const edges = [[32, 34], [32, 44], [33, 39], [34, 35], [34, 36], [34, 37], [34, 38], [35, 41], [36, 41], [37, 40], [38, 41], [39, 41], [40, 41], [41, 42], [42, 43], [44, 42]];
    for (const [on, strand] of edges) core.block(made[strand!]!, made[on!]!);
    const snapshot = core.snapshot();
    const graph = epicGraph(snapshot, findEpic(snapshot, "sc-1")!);
    expect(graph.nodes.map((node) => node.name)).not.toContain("notes for the epic");
    const drawing = drawGraph(bestLayout(graph, 150), 150, undefined);
    const text = drawing.lines.map((line) => line.map((cell) => cell.ch).join("")).join("\n");
    expect(drawing.crossings).toBeGreaterThan(0);
    expect(text).not.toContain("┼");
  });
});
