import { describe, expect, test } from "bun:test";
import type { Actions } from "./actions.ts";
import { Dealer } from "./deal.ts";
import { harness, recordingActions, strandNamed } from "./test-harness.ts";

async function setup(unseen = false) {
  const { core, hear, tick, now } = harness();
  await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-1", labels: { strand: "sc-1" } }, { id: 2, number: 2, name: "side", dir: "/w/side" }], agents: [], jobs: [] });
  await hear({ type: "agent.state", agent: { paneId: 3, tabId: 1, state: "done" } });
  tick(60_000);
  await hear({ type: "agent.state", agent: { paneId: 4, tabId: 2, state: "waiting" } });
  tick(60_000);
  const { actions, calls } = recordingActions();
  const dealer = new Dealer(actions, unseen, now);
  dealer.setSnapshot(core.snapshot());
  return { core, dealer, calls, now };
}

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).join("\n");

describe("the deck", () => {
  test("lists the hand with the picked card's details, and goes to the picked card", async () => {
    const { core, dealer, calls } = await setup();
    const hand = plain(dealer.view());
    expect(hand).toContain("your move 2");
    expect(hand).toContain("▎1 ● claude in side");
    expect(hand).toContain(" 2 ● sc-1  Widget CSV import");
    await dealer.key({ name: "j" });
    const card = plain(dealer.view());
    expect(card).toContain("● sc-1");
    expect(card).toContain("● claude · turn ended  ·  2m");
    expect(card).toContain("⏎  go to claude in tab 1 widgets");
    expect(await dealer.key({ name: "return" })).toBe("close");
    expect(calls).toEqual([["go", strandNamed(core, "sc-1").id]]);
    const tall = plain(dealer.view(90, 40)).split("\n");
    expect(tall).toHaveLength(40);
    expect(tall.at(-1)).toContain("esc  close");
    expect(tall.at(-2)).toContain("⏎  go to");
  });

  test("every live strand shows somewhere, a parent with nothing of its own as waiting on the strand under it", async () => {
    const { core, tick, now } = harness();
    core.add(undefined, "sc-1 › sc-2 › gadgets PR › ask Sam");
    core.add(undefined, "sc-1 › sc-3");
    core.add(undefined, "side");
    core.wait({ self: "tool:1", strand: "sc-1 › sc-2 › gadgets PR", who: "the team", kind: "person", what: "reviewing the PR" });
    core.snooze(strandNamed(core, "sc-1 › sc-2 › gadgets PR › ask Sam").id, now() + 60 * 60_000);
    core.wait({ self: "tool:1", strand: "side", who: "CI", kind: "machine", what: "build" });
    tick(60_000);
    const { actions, calls } = recordingActions();
    const dealer = new Dealer(actions, false, now);
    dealer.setSnapshot(core.snapshot());
    const view = plain(dealer.view(160, 80));
    for (const strand of core.snapshot().strands) expect(view).toContain(strand.name);
    expect(view).toContain("waiting on other strands 2");
    expect(view).toContain("sc-2");
    expect(view).toContain("waiting on gadgets PR");
    core.done(strandNamed(core, "sc-1 › sc-3").id);
    dealer.setSnapshot(core.snapshot());
    expect(plain(dealer.view(160, 80))).toContain("sc-3 is done");
    expect(dealer.card()?.name).toBe("sc-1");
    await dealer.key({ name: "return" });
    expect(calls).toEqual([
      ["go", strandNamed(core, "sc-1").id],
      ["seen", strandNamed(core, "sc-1").id],
    ]);
  });

  test("deals what's asking you first, then the newest, and an agent only ready for a prompt last", async () => {
    const { core, hear, tick, now } = harness();
    const tabs = ["a", "b", "c", "d"].map((name, index) => ({ id: index + 1, number: index + 1, name, dir: `/w/${name}` }));
    await hear({ type: "snapshot", tabs, agents: [], jobs: [] });
    await hear({ type: "agent.state", agent: { paneId: 1, tabId: 1, state: "done" } });
    await hear({ type: "agent.state", agent: { paneId: 4, tabId: 4, state: "done" } });
    tick(60_000);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 2, state: "done" } });
    await hear({ type: "agent.state", agent: { paneId: 4, tabId: 4, state: "idle" } });
    tick(60_000);
    await hear({ type: "agent.state", agent: { paneId: 3, tabId: 3, state: "waiting" } });
    tick(60_000);
    const dealer = new Dealer(recordingActions().actions, false, now);
    dealer.setSnapshot(core.snapshot());
    expect(plain(dealer.view()).match(/\d ● claude in \w/g)).toEqual(["1 ● claude in c", "2 ● claude in b", "3 ● claude in a", "4 ● claude in d"]);
  });

  test("lists agents at work, strands waiting on others and snoozed strands under yours, and goes to any of them", async () => {
    const { core, hear, tick, now } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/widgets" }, { id: 2, number: 2, name: "side", dir: "/w/side" }], agents: [], jobs: [] });
    await hear({ type: "agent.state", agent: { paneId: 1, tabId: 1, state: "done" } });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 2, state: "working" } });
    core.wait({ strand: "sc-7", who: "Copilot", kind: "machine", what: "PR review" }, "you");
    core.add(undefined, "sc-8");
    core.snooze(strandNamed(core, "sc-8").id, now() + 3_600_000);
    tick(60_000);
    const { actions, calls } = recordingActions();
    const dealer = new Dealer(actions, false, now);
    dealer.setSnapshot(core.snapshot());
    const deck = plain(dealer.view());
    expect(deck).toMatch(/your move 1 *\n.*1 ● claude in widgets[^\n]*\n\n agents 1 *\n.*2 ◐ claude in side +claude · working[^\n]*\n\n waiting on others 1 *\n.*3 ⊘ sc-7 +Copilot · PR review[^\n]*\n\n snoozed 1 *\n.*4 ◷ sc-8 +snoozed till /);
    await dealer.key({ name: "3" });
    await dealer.key({ name: "s" });
    expect(dealer.card()?.name).toBe("sc-7");
    expect(await dealer.key({ name: "return" })).toBe("close");
    expect(calls).toEqual([["go", strandNamed(core, "sc-7").id]]);
  });

  test("puts yours on the left and everyone else's on the right when the popup is wide, and moves between them", async () => {
    const { core, hear, tick, now } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/widgets" }, { id: 2, number: 2, name: "side", dir: "/w/side" }, { id: 3, number: 3, name: "docs", dir: "/w/docs" }], agents: [], jobs: [] });
    await hear({ type: "agent.state", agent: { paneId: 1, tabId: 1, state: "done" } });
    await hear({ type: "agent.state", agent: { paneId: 3, tabId: 3, state: "done" } });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 2, state: "working" } });
    core.wait({ strand: "sc-7", who: "Copilot", kind: "machine", what: "PR review" }, "you");
    tick(60_000);
    const dealer = new Dealer(recordingActions().actions, false, now);
    dealer.setSnapshot(core.snapshot());
    const lines = plain(dealer.view(140, 40)).split("\n");
    expect(lines[0]).toMatch(/^ your move 2 +│  agents 1 *$/);
    expect(lines[1]).toMatch(/^▎1 ● claude in \w+ .*│  3 ◐ claude in side/);
    expect(lines[2]).toMatch(/^ 2 ● claude in \w+ .*│ *$/);
    expect(lines[3]).toMatch(/^ +│  waiting on others 1/);
    expect(lines[4]).toMatch(/^ +│  4 ⊘ sc-7 /);
    await dealer.key({ name: "j" });
    await dealer.key({ name: "j" });
    expect(dealer.card()?.name).not.toBe("claude in side");
    await dealer.key({ name: "tab" });
    expect(dealer.card()?.name).toBe("claude in side");
    await dealer.key({ name: "j" });
    expect(dealer.card()?.name).toBe("sc-7");
    await dealer.key({ name: "h" });
    await dealer.key({ name: "l" });
    expect(dealer.card()?.name).toBe("sc-7");
    await dealer.key({ name: "k" });
    await dealer.key({ name: "k" });
    expect(dealer.card()?.name).toBe("claude in side");
  });

  test("catching up lists only your new moves", async () => {
    const { dealer } = await setup(true);
    await dealer.key({ name: "j" });
    await dealer.key({ name: "j" });
    expect(dealer.card()?.name).toBe("sc-1");
    expect(plain(dealer.view())).not.toContain(" agents ");
  });

  test("scrolls the list to keep the picked card in view", async () => {
    const { core, hear, now } = harness();
    await hear({ type: "snapshot", tabs: [], agents: [], jobs: [] });
    for (const name of Array.from({ length: 30 }, (_, index) => `sc-${100 + index}`)) core.add(undefined, name);
    const dealer = new Dealer(recordingActions().actions, false, now);
    dealer.setSnapshot(core.snapshot());
    for (const _ of Array.from({ length: 25 })) await dealer.key({ name: "j" });
    const deck = plain(dealer.view(70, 30));
    expect(deck).toContain(`▎  ● ${dealer.card()?.name}`);
    expect(deck.split("\n").length).toBeLessThanOrEqual(30);
  });

  test("f starts a fresh Claude on the picked card even when one is in its tab", async () => {
    const { core, dealer, calls } = await setup();
    await dealer.key({ name: "2" });
    expect(plain(dealer.view())).toContain("f  fresh");
    expect(await dealer.key({ name: "f" })).toBe("close");
    expect(calls).toEqual([["pickUp", strandNamed(core, "sc-1").id, "fresh"]]);
  });

  test("skip puts the card at the back, and d marks it done", async () => {
    const { core, dealer, calls } = await setup();
    await dealer.key({ name: "s" });
    expect(dealer.card()?.name).toBe("sc-1");
    await dealer.key({ name: "s" });
    expect(dealer.card()?.name).toBe("claude in side");
    await dealer.key({ name: "d" });
    expect(calls).toEqual([["done", strandNamed(core, "claude in side").id]]);
  });

  test("w makes the card wait on a typed strand, or on none when left empty, and the card says what it waits on", async () => {
    const { core, dealer, calls } = await setup();
    const card = dealer.card()!;
    await dealer.key({ name: "w" });
    for (const char of "side") await dealer.key({ name: char, text: char });
    await dealer.key({ name: "return" });
    await dealer.key({ name: "w" });
    await dealer.key({ name: "return" });
    expect(calls).toEqual([["block", card.id, "side"], ["unblock", card.id]]);
    core.block(strandNamed(core, "sc-1").id, strandNamed(core, "claude in side").id);
    dealer.setSnapshot(core.snapshot());
    for (let step = 0; step < 10 && dealer.card()?.name !== "sc-1"; step++) await dealer.key({ name: "j" });
    expect(plain(dealer.view(100, 40))).toContain("waits on claude in side");
  });

  test("snoozes until a typed time, and keeps asking until it reads one", async () => {
    const { core, dealer, calls, now } = await setup();
    await dealer.key({ name: "z" });
    await dealer.key({ name: "t" });
    for (const char of "soon") await dealer.key({ name: char, text: char });
    await dealer.key({ name: "return" });
    expect(dealer.mode).toBe("time");
    expect(plain(dealer.view())).toContain("snooze until: soon▏  → ?");
    for (const _ of "soon") await dealer.key({ name: "backspace" });
    for (const char of "2h") await dealer.key({ name: char, text: char });
    await dealer.key({ name: "return" });
    expect(dealer.mode).toBe("card");
    expect(calls).toEqual([["snooze", strandNamed(core, "claude in side").id, now() + 2 * 3_600_000]]);
  });

  test("catching up marks each dealt strand seen", async () => {
    const { core, dealer, calls } = await setup(true);
    expect(plain(dealer.view())).toContain("since you last caught up 2");
    await dealer.key({ name: "s" });
    expect(await dealer.key({ name: "escape" })).toBe("close");
    expect(calls).toEqual([["seen", strandNamed(core, "claude in side").id]]);
  });

  test("a card says what the strand is: its title, the strands above it, and its latest note", async () => {
    const { core } = harness();
    const id = core.add(undefined, "sc-100 › sc-101");
    const epic = strandNamed(core, "sc-100").id;
    core.record("you", [
      { type: "strand.titled", strand: epic, kind: "epic", title: "Smarter widget pricing" },
      { type: "strand.titled", strand: id, kind: "story", title: "Gadgets: tools for import and export widgets" },
      { type: "strand.note", strand: id, text: "No PR yet; 15 uncommitted changes in gadgets." },
    ]);
    const dealer = new Dealer(recordingActions().actions, false, () => 1_000_000);
    dealer.setSnapshot(core.snapshot());
    const card = plain(dealer.view(100));
    expect(card).toContain("▎ sc-101  Gadgets: tools for import and export widgets");
    expect(card).toContain("in epic sc-100  Smarter widget pricing");
    expect(card).toContain("✎ No PR yet; 15 uncommitted changes in gadgets.");
  });

  test("a card shows the tree of strands under it with how each stands", async () => {
    const { core, now } = harness();
    core.add(undefined, "sc-1 › a › b");
    core.add(undefined, "sc-1 › c");
    core.wait({ strand: "sc-1 › c", who: "Copilot", kind: "machine", what: "PR review" }, "you");
    core.wait({ strand: "sc-1", who: "you", kind: "you", what: "look" }, "you");
    const dealer = new Dealer(recordingActions().actions, false, now);
    dealer.setSnapshot(core.snapshot());
    while (dealer.card()?.name !== "sc-1") await dealer.key({ name: "j" });
    const card = plain(dealer.view(100)).split("\n");
    const tree = card.slice(card.findIndex((line) => line.includes("under it · 3")));
    expect(tree[1]).toMatch(/▎ ○ a +waiting on b/);
    expect(tree[2]).toMatch(/▎   ● b +yours · no one on it/);
    expect(tree[3]).toMatch(/▎ ⊘ c +Copilot · PR review/);
  });

  test("opened on a tab, lists its strands with the trees under them, and edits the picked one", async () => {
    const { core, hear, now } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 3, number: 3, name: "widgets", dir: "/w/s", labels: { strand: "sc-1" } }, { id: 4, number: 4, name: "side", dir: "/w/side" }], agents: [], jobs: [] });
    await hear({ type: "agent.state", agent: { paneId: 7, tabId: 3, state: "done" } });
    core.add(strandNamed(core, "sc-1").id, "pr › ask");
    await hear({ type: "agent.state", agent: { paneId: 8, tabId: 4, state: "done" } });
    const { actions, calls } = recordingActions();
    const dealer = new Dealer(actions, false, now, { server: "s1", tabId: 3 });
    dealer.setSnapshot(core.snapshot());
    const deck = plain(dealer.view(120, 40)).split("\n");
    expect(deck[0]).toMatch(/^ tab 3 widgets 3/);
    expect(deck[1]).toMatch(/^▎1 ● sc-1  Widget CSV import +claude · turn ended/);
    expect(deck[2]).toMatch(/^ 2   ○ pr +waiting on ask/);
    expect(deck[3]).toMatch(/^ 3     ● ask +yours · no one on it/);
    expect(deck.join("\n")).not.toContain("side");
    await dealer.key({ name: "s" });
    expect(dealer.card()?.name).toBe("sc-1");
    await dealer.key({ name: "j" });
    for (const [key, text] of [["a", "tests"], ["n", "waiting on Sam"], ["m", "ptyparty"]] as const) {
      await dealer.key({ name: key });
      for (const char of text) await dealer.key({ name: char, text: char });
      await dealer.key({ name: "return" });
    }
    await dealer.key({ name: "r" });
    expect(plain(dealer.view(120, 40))).toContain("rename to: pr▏");
    for (const char of "-fix") await dealer.key({ name: char, text: char });
    await dealer.key({ name: "return" });
    const pr = strandNamed(core, "sc-1 › pr").id;
    expect(calls).toEqual([
      ["add", pr, "tests"],
      ["note", pr, "waiting on Sam"],
      ["reparent", pr, "ptyparty"],
      ["rename", pr, "pr-fix"],
    ]);
  });

  test("an empty hand says so", () => {
    const dealer = new Dealer({} as Actions, false);
    dealer.setSnapshot({ now: 0, counts: { yours: 0, agents: 0, snoozed: 0, waiting: 0 }, strands: [], moves: [], unseen: [], heard: [], labels: {} });
    expect(plain(dealer.view())).toContain("✓ clear");
  });
});
