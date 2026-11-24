import { describe, expect, test } from "bun:test";
import type { Actions } from "./actions.ts";
import { Dealer } from "./deal.ts";
import { inboxFacts } from "./inbox.ts";
import { harness, recordingActions, strandNamed } from "./test-harness.ts";

async function setup(unseen = false) {
  const { core, hear, replied, tick, now } = harness();
  await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-1", labels: { strand: "sc-1" } }, { id: 2, number: 2, name: "side", dir: "/w/side", labels: { strand: "claude in side" } }], agents: [], jobs: [] });
  await replied(3, 1);
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
    expect(hand).toContain("Claude replied: go read it");
    expect(hand).toMatch(/▎ 1 ● claude in side +claude is waiting o… +1m/);
    expect(hand).toMatch(/ 2 ● Widget CSV import +· sc-1 +claude replied +2m/);
    await dealer.key({ name: "j" });
    const card = plain(dealer.view());
    expect(card).toContain("▎ sc-1  Widget CSV import");
    expect(card).toContain("● claude · read reply  ·  2m");
    expect(card).toContain("⏎  go to claude in tab 1 widgets");
    expect(await dealer.key({ name: "return" })).toBe("close");
    expect(calls).toEqual([["go", strandNamed(core, "sc-1").id]]);
    const tall = plain(dealer.view(90, 40)).split("\n");
    expect(tall).toHaveLength(40);
    expect(tall.at(-1)).toContain("esc  close");
    expect(tall.at(-2)).toContain("⏎  go to");
  });

  test("replies to the picked card, with or without words", async () => {
    const { core, dealer, calls } = await setup();
    await dealer.key({ name: "j" });
    expect(plain(dealer.view())).toContain("e  reply");
    await dealer.key({ name: "e" });
    for (const text of "read it") await dealer.key({ name: text, text });
    await dealer.key({ name: "return" });
    await dealer.key({ name: "e" });
    await dealer.key({ name: "return" });
    expect(calls).toEqual([
      ["reply", strandNamed(core, "sc-1").id, "read it"],
      ["reply", strandNamed(core, "sc-1").id, ""],
    ]);
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
    expect(plain(dealer.view(160, 80))).toContain("▸ 2 waiting on other strands     ▸ 1 nothing asked     ▸ 1 snoozed");
    await dealer.key({ name: "tab" });
    for (let step = 0; step < 10 && dealer.card(); step++) await dealer.key({ name: "j" });
    await dealer.key({ name: "return" });
    for (const _ of [1, 2, 3]) await dealer.key({ name: "j" });
    await dealer.key({ name: "return" });
    for (const _ of [1, 2]) await dealer.key({ name: "j" });
    await dealer.key({ name: "return" });
    const view = plain(dealer.view(160, 80));
    for (const strand of core.snapshot().strands) expect(view).toContain(strand.name);
    expect(view).toContain("▾ 2 waiting on other strands");
    expect(view).toContain("▾ 1 nothing asked");
    expect(view).toMatch(/◷ ask Sam +snoozed till/);
    expect(calls).toEqual([]);
    core.done(strandNamed(core, "sc-1 › sc-3").id);
    core.done(strandNamed(core, "sc-1 › sc-2").id);
    dealer.setSnapshot(core.snapshot());
    expect(plain(dealer.view(160, 80))).toMatch(/1 ● sc-1 +parts done: close it?/);
    await dealer.key({ name: "1" });
    expect(dealer.card()?.name).toBe("sc-1");
    expect(plain(dealer.view(160, 80))).toContain("c  keep open");
    await dealer.key({ name: "c" });
    expect(calls).toEqual([["keepOpen", strandNamed(core, "sc-1").id]]);
    calls.length = 0;
    await dealer.key({ name: "return" });
    expect(calls).toEqual([["go", strandNamed(core, "sc-1").id]]);
  });

  test("groups your moves by what is asked, newest first in each: what Claude asks, what it replied, review, pick up", async () => {
    const { core, hear, replied, tick, now } = harness();
    const tabs = ["a", "b", "c", "d"].map((name, index) => ({ id: index + 1, number: index + 1, name, dir: `/w/${name}`, labels: { strand: `claude in ${name}` } }));
    await hear({ type: "snapshot", tabs, agents: [], jobs: [] });
    await replied(1, 1);
    await replied(4, 4);
    tick(60_000);
    await replied(2, 2);
    await hear({ type: "agent.state", agent: { paneId: 4, tabId: 4, state: "idle" } });
    tick(60_000);
    await hear({ type: "agent.state", agent: { paneId: 3, tabId: 3, state: "waiting" } });
    tick(60_000);
    const dealer = new Dealer(recordingActions().actions, false, now);
    dealer.setSnapshot(core.snapshot());
    core.wait({ strand: "› sc-10", who: "you", kind: "you", what: "pick it up" }, "you");
    core.add(undefined, "sc-9");
    core.split({ strand: "sc-9" }, [{ name: "review gadgets", title: "Review the gadget cache", tour: { repo: "/w/gadgets", name: "cache" } }]);
    dealer.setSnapshot(core.snapshot());
    const deck = plain(dealer.view(100));
    expect(deck.match(/(^ [a-zC].*$)|\d ● [^·]+?(?= {2})/gm)?.map((text) => text.trimEnd())).toEqual([
      " Claude asks you",
      "1 ● claude in c",
      " Claude replied: go read it",
      "2 ● claude in b",
      "3 ● claude in a",
      "4 ● claude in d",
      " review",
      "5 ● Review the gadget cache",
      " pick up",
      "6 ● sc-10",
    ]);
    expect(deck).toMatch(/1 ● claude in c +claude is waiting on you/);
    expect(deck).toMatch(/5 ● Review the gadget cache +· review gadgets +tour ready/);
    expect(deck).toMatch(/6 ● sc-10 +pick it up/);
  });

  test("lists agents at work, what waits on people and machines, and snoozed strands folded, and goes to any of them", async () => {
    const { core, hear, replied, tick, now } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/widgets", labels: { strand: "claude in widgets" } }, { id: 2, number: 2, name: "side", dir: "/w/side", labels: { strand: "claude in side" } }], agents: [], jobs: [] });
    await replied(1, 1);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 2, state: "working" } });
    core.wait({ strand: "sc-7", who: "Copilot", kind: "machine", what: "PR review" }, "you");
    core.add(undefined, "sc-8");
    core.snooze(strandNamed(core, "sc-8").id, now() + 3_600_000);
    tick(60_000);
    const { actions, calls } = recordingActions();
    const dealer = new Dealer(actions, false, now);
    dealer.setSnapshot(core.snapshot());
    const deck = plain(dealer.view());
    expect(deck).toMatch(/Claude replied: go read it *\n.*1 ● claude in widgets[^\n]*\n\n agents 1 *\n.*2 ◐ claude in side +claude · working[^\n]*\n\n waiting on Copilot 1 *\n.*3 ⊘ sc-7 +Copilot · PR review[^\n]*\n\n ▸ 1 snoozed/);
    await dealer.key({ name: "3" });
    await dealer.key({ name: "s" });
    expect(dealer.card()?.name).toBe("sc-7");
    expect(await dealer.key({ name: "return" })).toBe("close");
    expect(calls).toEqual([["go", strandNamed(core, "sc-7").id]]);
  });

  test("keeps a strand under agents while its Claude works, even when it also asks you something", async () => {
    const { core, hear, now } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-1", labels: { strand: "sc-1" } }], agents: [{ paneId: 2, tabId: 1, state: "working" }], jobs: [] });
    core.wait({ strand: "sc-1", who: "you", kind: "you", what: "try it in the browser" }, "you");
    const dealer = new Dealer(recordingActions().actions, false, now);
    dealer.setSnapshot(core.snapshot());
    const deck = plain(dealer.view(90, 40));
    expect(deck).toMatch(/1 ● Widget CSV import +· sc-1 +try it in the browser/);
    expect(deck).toMatch(/ agents 1 *\n.*2 ◐ Widget CSV import +· sc-1 +claude · working/);
    await dealer.key({ name: "2" });
    dealer.setSnapshot(core.snapshot());
    expect(plain(dealer.view(90, 40))).toMatch(/▎ 2 ◐ Widget CSV import/);
  });

  test("puts yours on the left and everyone else's on the right when the popup is wide, and moves between them", async () => {
    const { core, hear, replied, tick, now } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/widgets", labels: { strand: "claude in widgets" } }, { id: 2, number: 2, name: "side", dir: "/w/side", labels: { strand: "claude in side" } }, { id: 3, number: 3, name: "docs", dir: "/w/docs", labels: { strand: "claude in docs" } }], agents: [], jobs: [] });
    await replied(1, 1);
    await replied(3, 3);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 2, state: "working" } });
    core.wait({ strand: "sc-7", who: "Copilot", kind: "machine", what: "PR review" }, "you");
    tick(60_000);
    const dealer = new Dealer(recordingActions().actions, false, now);
    dealer.setSnapshot(core.snapshot());
    const lines = plain(dealer.view(140, 40)).split("\n");
    expect(lines[0]).toMatch(/^ Claude replied: go read it +│  agents 1 *$/);
    expect(lines[1]).toMatch(/^▎ 1 ● claude in \w+ .*│   3 ◐ claude in side/);
    expect(lines[2]).toMatch(/^  2 ● claude in \w+ .*│ *$/);
    expect(lines[3]).toMatch(/^ +│  waiting on Copilot 1/);
    expect(lines[4]).toMatch(/^ +│   4 ⊘ sc-7 /);
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

  test("a request you took on shows as in progress, and what waits on others is grouped by whom", async () => {
    const { core, now } = harness();
    const review = core.add(undefined, "widgets#9");
    core.record("github", [
      { type: "party.known", party: "group:team", kind: "group", name: "the team" },
      { type: "said", requests: [{ request: "r1", strand: review, to: { group: "group:team" }, what: "review" }], replies: [{ request: "r1", as: "progress", by: "you" }] },
    ]);
    core.wait({ strand: "› sc-1", who: "Sam", kind: "person", what: "the terms question" }, "you");
    core.wait({ strand: "› sc-2", who: "CI", kind: "machine", what: "the build" }, "you");
    core.wait({ strand: "› sc-3", who: "Sam", kind: "person", what: "the fees question" }, "you");
    const dealer = new Dealer(recordingActions().actions, false, now);
    dealer.setSnapshot(core.snapshot());
    const deck = plain(dealer.view(100, 40));
    expect(deck).toMatch(/ in progress: you took it on *\n.*● widgets#9/);
    expect(deck).toMatch(/ waiting on CI 1 *\n.*⊘ sc-2[^\n]*\n\n waiting on Sam 2 *\n/);
  });

  test("scrolls the list to keep the picked card in view", async () => {
    const { core, hear, replied, now } = harness();
    await hear({ type: "snapshot", tabs: [], agents: [], jobs: [] });
    for (const name of Array.from({ length: 30 }, (_, index) => `sc-${100 + index}`)) core.wait({ strand: `› ${name}`, who: "you", kind: "you", what: "look" }, "you");
    const dealer = new Dealer(recordingActions().actions, false, now);
    dealer.setSnapshot(core.snapshot());
    for (const _ of Array.from({ length: 25 })) await dealer.key({ name: "j" });
    const deck = plain(dealer.view(70, 30));
    expect(deck).toContain(`▎26 ● ${dealer.card()?.name}`);
    expect(deck.split("\n").length).toBeLessThanOrEqual(30);
  });

  test("f starts a fresh Claude on the picked card even when one is in its tab", async () => {
    const { core, dealer, calls } = await setup();
    await dealer.key({ name: "2" });
    expect(plain(dealer.view())).toContain("f  fresh");
    expect(await dealer.key({ name: "f" })).toBe("close");
    expect(calls).toEqual([["pickUp", strandNamed(core, "sc-1").id, "fresh"]]);
  });

  test("d marks the card done", async () => {
    const { dealer, calls } = await setup();
    const card = dealer.card()!;
    await dealer.key({ name: "d" });
    expect(calls).toEqual([["done", card.id]]);
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
    expect(plain(dealer.view(100, 40))).toContain("▸ 1 waiting on other strands");
    await dealer.key({ name: "j" });
    await dealer.key({ name: "return" });
    await dealer.key({ name: "j" });
    expect(dealer.card()?.name).toBe("sc-1");
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
    const { dealer, calls } = await setup(true);
    expect(plain(dealer.view())).toContain("since you last caught up 2");
    const card = dealer.card()!;
    expect(await dealer.key({ name: "return" })).toBe("close");
    expect(calls.filter(([call]) => call === "seen")).toEqual([["seen", card.id]]);
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
    core.wait({ strand: "sc-100 › sc-101", who: "you", kind: "you", what: "look" }, "you");
    const dealer = new Dealer(recordingActions().actions, false, () => 1_000_000);
    dealer.setSnapshot(core.snapshot());
    const card = plain(dealer.view(100));
    expect(card).toContain("▎ sc-101  Gadgets: tools for import and export widgets");
    expect(card).toContain("in epic sc-100  Smarter widget pricing");
    expect(card).toContain("✎ No PR yet; 15 uncommitted changes in gadgets.");
  });

  test("a card shows the tree of strands under it with how each stands", async () => {
    const { core, now } = harness();
    core.wait({ strand: "› sc-1 › a › b", who: "you", kind: "you", what: "try it" }, "you");
    core.add(undefined, "sc-1 › c");
    core.wait({ strand: "sc-1 › c", who: "Copilot", kind: "machine", what: "PR review" }, "you");
    core.wait({ strand: "sc-1", who: "you", kind: "you", what: "look" }, "you");
    const dealer = new Dealer(recordingActions().actions, false, now);
    dealer.setSnapshot(core.snapshot());
    while (dealer.card()?.name !== "sc-1") await dealer.key({ name: "j" });
    const card = plain(dealer.view(100)).split("\n");
    const tree = card.slice(card.findIndex((line) => line.includes("under it · 3")));
    expect(tree[1]).toMatch(/▎ ○ a +1 for you \(try it\)/);
    expect(tree[2]).toMatch(/▎   ● b +yours · you: try it/);
    expect(tree[3]).toMatch(/▎ ⊘ c +Copilot · PR review/);
  });

  test("opened on a tab, lists its strands with the trees under them, and edits the picked one", async () => {
    const { core, hear, replied, now } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 3, number: 3, name: "widgets", dir: "/w/s", labels: { strand: "sc-1" } }, { id: 4, number: 4, name: "side", dir: "/w/side", labels: { strand: "claude in side" } }], agents: [], jobs: [] });
    await replied(7, 3);
    core.wait({ strand: "sc-1 › pr › ask", who: "you", kind: "you", what: "ask Sam" }, "you");
    await replied(8, 4);
    const { actions, calls } = recordingActions();
    const dealer = new Dealer(actions, false, now, { server: "s1", tabId: 3 });
    dealer.setSnapshot(core.snapshot());
    const deck = plain(dealer.view(120, 40)).split("\n");
    expect(deck[0]).toMatch(/^ tab 3 widgets 3/);
    expect(deck[1]).toMatch(/^▎1 ● sc-1  Widget CSV import +claude · read reply/);
    expect(deck[2]).toMatch(/^ 2   ○ pr +1 for you \(ask Sam\)/);
    expect(deck[3]).toMatch(/^ 3     ● ask +yours · you: ask Sam/);
    expect(deck.join("\n")).not.toContain("side");
    expect(dealer.card()?.name).toBe("sc-1");
    await dealer.key({ name: "t" });
    expect(plain(dealer.view(120, 40))).toContain("title (empty to clear): Widget CSV import▏");
    for (const _ of "Widget CSV import") await dealer.key({ name: "backspace" });
    await dealer.key({ name: "return" });
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
      ["title", strandNamed(core, "sc-1").id, ""],
      ["add", pr, "tests"],
      ["note", pr, "waiting on Sam"],
      ["reparent", pr, "ptyparty"],
      ["rename", pr, "pr-fix"],
    ]);
  });

  test("files an agent waiting on its own build under agents, and your PRs out for review apart from people, with approved ones to review", async () => {
    const { core, hear, replied, now } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-1", labels: { strand: "sc-1" } }], agents: [{ paneId: 2, tabId: 1, state: "working" }], jobs: [] });
    await hear({ type: "job.started", job: { id: 9, tabId: 1, name: "build", state: "running", agent: false, startedBy: 2 } });
    await replied(2, 1, "none");
    const pr = (number: number, branch: string, reviews: { author: string; bot: boolean; state: string; commit: string; at: string }[] = []) => ({ repo: "acme/widgets", number, title: `PR ${number}`, url: `https://github.com/acme/widgets/pull/${number}`, author: "octo", draft: false, branch, head: "c1", requested: [], reviews, threads: [] });
    core.add(undefined, "sc-2");
    core.add(undefined, "sc-3");
    core.wait({ strand: "sc-4", who: "Sam", kind: "person", what: "the terms question" }, "you");
    let ids = 0;
    core.record("github", inboxFacts(core.knowledge(), { me: "octo", reviews: [], mentioned: [], mine: [pr(20, "sc-2/x"), pr(30, "sc-3/y", [{ author: "sam", bot: false, state: "APPROVED", commit: "c1", at: "2026-11-13T11:00:00Z" }])] }, (prefix) => `${prefix}gh${++ids}`));
    const dealer = new Dealer(recordingActions().actions, false, now);
    dealer.setSnapshot(core.snapshot());
    const deck = plain(dealer.view(100, 60));
    expect(deck).toMatch(/ review *\n.*● PR 30 +· widgets#30 +approved by sam · merge it/);
    expect(deck).toMatch(/ agents 1 *\n.*◐ Widget CSV import +· sc-1 +claude · on its build/);
    expect(deck).toMatch(/ your PRs out for review 1 *\n.*⊘ PR 20 +· widgets#20 +the team · 0 of 1 reviews/);
    expect(deck).toMatch(/ waiting on Sam 1 *\n.*⊘ sc-4 +Sam · the terms question/);
  });

  test("an empty hand says so", () => {
    const dealer = new Dealer({} as Actions, false);
    dealer.setSnapshot({ now: 0, counts: { yours: 0, agents: 0, snoozed: 0, waiting: 0 }, strands: [], moves: [], unseen: [], heard: [], labels: {} });
    expect(plain(dealer.view())).toContain("✓ clear");
  });
});
