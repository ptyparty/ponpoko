import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openableLink, readyDrafts } from "./actions.ts";
import { Ponpoko } from "./core.ts";
import { Dealer } from "./deal.ts";
import { fetchInbox, isUnreviewed, markReady, ownState, runGh, unreviewedThresholds, type Gh, type Inbox, type OwnPr, type PullRequest } from "./github.ts";
import { hasOpenPr, inboxFacts, ownPrs, reviewsId, unwatchedPrs } from "./inbox.ts";
import { Bridge } from "./komux/bridge.ts";
import { Store } from "./store.ts";
import { TabController } from "./tab.ts";
import { recordingActions } from "./test-harness.ts";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).join("\n");
import { readPool, savePool, unreviewedColor, unreviewedLine, type Pool } from "./unreviewed.ts";

const me = "octo";
const url = "https://github.com/acme/widgets/pull/212";

function own(over: Partial<OwnPr> = {}): OwnPr {
  return { repo: "acme/widgets", number: 212, title: "Partner Services section", url, author: me, draft: false, branch: "sc-52751/partner-services", head: "c1", requested: [], reviews: [], threads: [], ...over };
}

const copilot = (over: Record<string, unknown> = {}) => ({ author: "copilot-pull-request-reviewer", bot: true, state: "COMMENTED", commit: "c1", at: "2026-11-13T10:00:00Z", ...over });
const sam = (state: string, over: Record<string, unknown> = {}) => ({ author: "sam", bot: false, state, commit: "c1", at: "2026-11-13T11:00:00Z", ...over });

function setup() {
  let now = 1_000_000;
  let ids = 0;
  const newId = (prefix: string) => `${prefix}${++ids}`;
  const core = new Ponpoko(new Store(":memory:"), () => now, newId);
  const sync = (mine: OwnPr[], extra: Partial<Inbox> = {}) => {
    const facts = inboxFacts(core.knowledge(), { me, reviews: [], mentioned: [], mine, ...extra }, newId);
    core.record("github", facts);
    now += 1000;
    return facts;
  };
  const strand = (name: string) => core.snapshot().strands.find((candidate) => candidate.name === name)!;
  const line = (name: string) => {
    const found = strand(name);
    const move = found.open.find((candidate) => candidate.from === found.own.since);
    return `${found.own.whose ?? "-"} ${move && move.player !== "you" ? `${move.by.who} · ` : ""}${found.own.why}`;
  };
  return { core, sync, strand, line, tick: (ms: number) => (now += ms) };
}

describe("your own pull request's state", () => {
  test("waits on Copilot, then is yours while its comments are open on the head", () => {
    expect(ownState(own({ draft: true, requested: [{ kind: "bot", login: "copilot-pull-request-reviewer" }] }))).toEqual({ kind: "waiting", who: "Copilot", whoKind: "machine", what: "reviewing" });
    const commented = own({ draft: true, reviews: [copilot()], threads: [1, 2, 3, 4].map(() => ({ author: "copilot-pull-request-reviewer", resolved: false })) });
    expect(ownState(commented)).toEqual({ kind: "yours", what: "Copilot left 4 comments" });
    expect(ownState({ ...commented, head: "c2" })).toEqual({ kind: "draft", what: "draft" });
    expect(ownState({ ...commented, threads: commented.threads.map((thread) => ({ ...thread, resolved: true })) })).toEqual({ kind: "draft", what: "draft" });
  });

  test("waits on the team once ready and nobody has reviewed it", () => {
    expect(ownState(own())).toEqual({ kind: "waiting", who: "the team", whoKind: "person", what: "0 of 1 reviews" });
    expect(ownState(own({ requested: [{ kind: "team", login: "devs" }] }))).toEqual({ kind: "waiting", who: "the team", whoKind: "person", what: "0 of 1 reviews" });
    expect(ownState(own({ requested: [{ kind: "user", login: "sam" }] }))).toEqual({ kind: "waiting", who: "sam", whoKind: "person", what: "reviewing" });
  });

  test("is yours when changes are requested, waits on the reviewer after a push, and is yours to merge once approved", () => {
    const threads = [1, 2, 3].map(() => ({ author: "sam", resolved: false }));
    expect(ownState(own({ reviews: [sam("CHANGES_REQUESTED")], threads }))).toEqual({ kind: "yours", what: "sam requested changes · 3 threads" });
    expect(ownState(own({ reviews: [sam("CHANGES_REQUESTED")], threads, head: "c2" }))).toEqual({ kind: "waiting", who: "sam", whoKind: "person", what: "re-review" });
    expect(ownState(own({ reviews: [sam("CHANGES_REQUESTED"), sam("APPROVED", { commit: "c2", at: "2026-11-13T12:00:00Z" })], head: "c2" }))).toEqual({ kind: "yours", what: "approved by sam · merge it", approved: true });
  });

  test("names the latest reviewer asking for changes, and every reviewer with open comments", () => {
    const early = sam("CHANGES_REQUESTED", { author: "bob", at: "2026-11-13T09:00:00Z" });
    const late = sam("CHANGES_REQUESTED", { at: "2026-11-13T12:00:00Z" });
    expect(ownState(own({ head: "c2", reviews: [early, sam("COMMENTED", { at: "2026-11-13T08:00:00Z" }), late] }))).toMatchObject({ who: "sam", what: "re-review" });
    const threads = [{ author: "sam", resolved: false }, { author: "bob", resolved: false }];
    expect(ownState(own({ reviews: [sam("COMMENTED", { author: "bob", at: "2026-11-13T09:00:00Z" }), sam("COMMENTED")], threads: [threads[1]!] }))).toEqual({ kind: "yours", what: "bob left comments · 1 thread" });
    expect(ownState(own({ reviews: [sam("COMMENTED", { author: "bob", at: "2026-11-13T09:00:00Z" }), sam("COMMENTED")], threads }))).toEqual({ kind: "yours", what: "sam, bob left comments · 2 threads" });
  });

  test("is yours when a reviewer leaves comments, and ignores your own replies", () => {
    expect(ownState(own({ reviews: [sam("COMMENTED")], threads: [{ author: "sam", resolved: false }] }))).toEqual({ kind: "yours", what: "sam left comments · 1 thread" });
    expect(ownState(own({ reviews: [{ ...sam("COMMENTED"), author: me }], threads: [{ author: me, resolved: false }] })).kind).toBe("waiting");
  });
});

describe("your own pull requests as requests", () => {
  test("each gets a strand of its own under the story its branch names, following its journey from draft to merged", () => {
    const { core, sync, strand, line } = setup();
    const story = core.add(undefined, "sc-52751");
    core.add(undefined, "sc-5275");
    sync([own({ draft: true, requested: [{ kind: "bot", login: "copilot-pull-request-reviewer" }] })]);
    expect(strand("widgets#212")).toMatchObject({ id: "pr:acme/widgets#212", parent: story, title: "Partner Services section", kind: "pr" });
    expect(strand("widgets#212").links.find((link) => link.adapter === "github")?.ref).toBe(url);
    expect(strand("sc-5275").links).toEqual([]);
    expect(line("widgets#212")).toBe("machine Copilot · reviewing");
    const comments = [1, 2, 3, 4].map(() => ({ author: "copilot-pull-request-reviewer", resolved: false }));
    sync([own({ draft: true, reviews: [copilot()], threads: comments })]);
    expect(line("widgets#212")).toBe("you Copilot left 4 comments");
    expect(openableLink(strand("widgets#212"))?.ref).toBe(url);
    expect(openableLink(strand("sc-52751"))?.ref).toBe(url);
    sync([own({ reviews: [copilot()], threads: comments.map((thread) => ({ ...thread, resolved: true })) })]);
    expect(line("widgets#212")).toBe("person team · 0 of 1 reviews");
    expect(strand("sc-52751").rolled.tally).toBe("1 for team");
    sync([own({ reviews: [copilot(), sam("CHANGES_REQUESTED")], threads: [1, 2, 3].map(() => ({ author: "sam", resolved: false })) })]);
    expect(line("widgets#212")).toBe("you sam requested changes · 3 threads");
    sync([own({ head: "c2", reviews: [copilot(), sam("CHANGES_REQUESTED")] })]);
    expect(line("widgets#212")).toBe("person sam · re-review");
    sync([own({ head: "c2", reviews: [copilot(), sam("APPROVED", { commit: "c2" })] })]);
    expect(line("widgets#212")).toBe("you approved by sam · merge it");
    expect(ownPrs(strand("widgets#212"))).toEqual([{ url, repo: "acme/widgets", number: 212, title: "Partner Services section", branch: "sc-52751/partner-services", draft: false, state: "yours", what: "approved by sam · merge it", approved: true }]);
    expect(hasOpenPr(core.knowledge(), "pr:acme/widgets#212")).toBe(true);
    sync([]);
    expect(hasOpenPr(core.knowledge(), "pr:acme/widgets#212")).toBe(false);
    expect(core.snapshot().strands.map((candidate) => candidate.name)).toEqual(["sc-52751", "sc-5275"]);
    expect([...core.model.requests.values()].filter((request) => !request.closed).map((request) => [request.strand, request.what])).toEqual([[story, "parts done: close it?"]]);
  });

  test("a story under way finds its PR through the branch checked out in its directory", () => {
    const { core, sync, strand } = setup();
    const story = core.add(undefined, "sc-1");
    const facts = inboxFacts(core.knowledge(), { me, reviews: [], mentioned: [], mine: [own({ branch: "partner-services" })] }, (prefix) => `${prefix}x`, new Map([["partner-services", story]]));
    core.record("github", facts);
    expect(strand("widgets#212").parent).toBe(story);
  });

  test("only reacts when the state changes, and leaves what others asked alone", () => {
    const { core, sync, strand } = setup();
    const story = core.add(undefined, "sc-52751");
    sync([own()]);
    core.record("komux", [{ type: "move.opened", move: "turn", strand: story, player: "you", what: "turn ended" }]);
    core.record("agent", [
      { type: "player.joined", player: "machine:copilot", kind: "machine", who: "Copilot" },
      { type: "move.opened", move: "agent-wait", strand: story, player: "machine:copilot", what: "reviewing PR #212" },
    ]);
    expect(sync([own()])).toEqual([]);
    sync([own({ reviews: [sam("CHANGES_REQUESTED")] })]);
    sync([own({ head: "c2", reviews: [sam("CHANGES_REQUESTED")] })]);
    expect(strand("widgets#212").own.whose).toBe("person");
    expect(strand("sc-52751").open.map((move) => move.what).sort()).toEqual(["reviewing PR #212", "turn ended"]);
  });

  test("a PR an agent linked goes under that strand even when its branch names none, and the bridge polls for it soon", async () => {
    const { core, sync, line, strand } = setup();
    const ponpoko = core.add(undefined, "ponpoko");
    core.record("agent", [{ type: "link.added", link: "agent-link", strand: ponpoko, adapter: "github", ref: url, label: "widgets#212" }]);
    expect(unwatchedPrs(core.knowledge())).toEqual([url]);
    sync([own({ branch: "fix-things" })]);
    expect(strand("widgets#212").parent).toBe(ponpoko);
    expect(line("widgets#212")).toBe("person team · 0 of 1 reviews");
    expect(unwatchedPrs(core.knowledge())).toEqual([]);
  });

  test("moves the PR's strand when an agent links it to another strand", () => {
    const { core, sync, strand } = setup();
    const story = core.add(undefined, "sc-52751");
    const tests = core.add(story, "tests");
    sync([own()]);
    expect(strand("widgets#212").parent).toBe(story);
    core.record("agent", [{ type: "link.added", link: "moved", strand: tests, adapter: "github", ref: url, label: "widgets#212" }]);
    sync([own()]);
    expect(strand("widgets#212").parent).toBe(tests);
    expect(sync([own()])).toEqual([]);
  });

  test("a PR whose branch names no story, or more than one, goes at the top", () => {
    const { core, sync, strand } = setup();
    core.add(undefined, "ponpoko");
    sync([own({ branch: "ponpoko/fix", title: "Fix things" })]);
    expect(strand("widgets#212").parent).toBeUndefined();
  });

  test("a PR strand you finish or forget stays that way while the PR is open, and comes back if GitHub reopens it", () => {
    const { core, sync, strand } = setup();
    core.add(undefined, "sc-52751");
    sync([own()]);
    core.done("pr:acme/widgets#212");
    expect(sync([own()])).toEqual([]);
    sync([own({ number: 9, url: "https://github.com/acme/widgets/pull/9", branch: "sc-52751/more" })]);
    core.forget("pr:acme/widgets#9");
    sync([own({ number: 9, url: "https://github.com/acme/widgets/pull/9", branch: "sc-52751/more" })]);
    expect(core.snapshot().strands.map((candidate) => candidate.name)).toEqual(["sc-52751"]);
    const reopened = setup();
    reopened.core.add(undefined, "sc-52751");
    reopened.sync([own()]);
    reopened.sync([]);
    reopened.sync([own()]);
    expect(reopened.strand("widgets#212").own.whose).toBe("person");
    expect(strand("sc-52751")).toBeDefined();
  });

  test("doesn't end a PR when the search may have been cut short", () => {
    const { core, sync, strand } = setup();
    core.add(undefined, "sc-52751");
    sync([own()]);
    sync([], { complete: { reviews: true, mentioned: true, mine: false } });
    expect(strand("widgets#212").own.whose).toBe("person");
  });
});

describe("the bridge and newly linked PRs", () => {
  test("polls soon after a PR is linked, once", async () => {
    const core = new Ponpoko(new Store(":memory:"));
    let now = 1_000_000;
    let polls = 0;
    const bridge = new Bridge(
      { knowledge: async () => core.knowledge(), record: async (facts, source = "komux") => core.record(source, facts), present: async () => undefined, absent: async () => undefined, importEpic: async () => undefined },
      async () => ({ ok: true }),
      () => now,
      async () => undefined,
      async () => (polls++, { me, reviews: [], mentioned: [], mine: [] }),
    );
    core.onChange(() => bridge.changed());
    await bridge.pollInbox();
    const strand = core.add(undefined, "ponpoko");
    core.record("agent", [{ type: "link.added", link: "agent-link", strand, adapter: "github", ref: url, label: "widgets#212" }]);
    await bridge.publish();
    now += 16_000;
    await bridge.pollInbox();
    expect(polls).toBe(2);
    await bridge.publish();
    now += 16_000;
    await bridge.pollInbox();
    expect(polls).toBe(2);
  });
});

describe("agents linking a PR through status", () => {
  test("links the strand once, however often it's reported", () => {
    const core = new Ponpoko(new Store(":memory:"));
    core.record("komux", [{ type: "player.joined", player: "a1", kind: "agent", who: "claude", place: { handle: "komux:s1:2" } }]);
    core.status({ self: "komux:s1:2", strand: "sc-1", text: "opened the PR", link: { adapter: "github", ref: url, label: "widgets#212" } });
    core.status({ self: "komux:s1:2", text: "pushed fixes", link: { adapter: "github", ref: url, label: "widgets#212" } });
    expect(core.snapshot().strands[0]!.links.map((link) => [link.adapter, link.ref, link.label])).toEqual([["github", url, "widgets#212"]]);
  });
});

describe("marking a draft ready", () => {
  test("runs gh pr ready for each draft the strand links to", async () => {
    const { core, sync, strand } = setup();
    core.add(undefined, "sc-52751");
    sync([own({ draft: true }), own({ number: 9, url: "https://github.com/acme/gadgets/pull/9", repo: "acme/gadgets" })]);
    const calls: string[][] = [];
    const gh: Gh = async (args) => (calls.push(args), "");
    expect(await readyDrafts(strand("sc-52751"), gh)).toBe("Marked widgets#212 ready for review");
    expect(calls).toEqual([["pr", "ready", url]]);
    await expect(markReady("not a url", gh)).rejects.toThrow("isn't a pull request");
  });

  test("goes through a fake gh on PATH", async () => {
    const bin = mkdtempSync(join(tmpdir(), "ponpoko-gh-"));
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> ${log}\n`);
    chmodSync(join(bin, "gh"), 0o755);
    expect(Bun.which("gh", { PATH: `${bin}:${process.env.PATH}` })).toBe(join(bin, "gh"));
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await markReady(url, runGh);
    } finally {
      process.env.PATH = path;
    }
    expect(readFileSync(log, "utf8")).toBe(`pr ready ${url}\n`);
  });

  test("R in the command tab and the deck marks it ready, and says so when there's no draft", async () => {
    const { core, sync } = setup();
    core.add(undefined, "sc-52751");
    core.add(undefined, "sc-1");
    core.wait({ strand: "sc-52751", who: "you", kind: "you", what: "finish the draft" }, "you");
    sync([own({ draft: true })]);
    const { actions, calls } = recordingActions();
    const tab = new TabController(actions, () => 0);
    tab.setSnapshot(core.snapshot());
    const pick = async (name: string) => {
      for (let step = 0; step < 20; step++) await tab.key({ name: "k" });
      for (let step = 0; step < 20 && tab.current()?.strand?.name !== name; step++) await tab.key({ name: "j" });
      expect(tab.current()?.strand?.name).toBe(name);
    };
    await pick("sc-52751");
    expect(tab.view(120, 30).join("\n")).toContain("mark ready");
    await tab.key({ name: "R" });
    expect(tab.message).toStartWith("Marked ");
    expect(calls).toContainEqual(["ready", core.snapshot().strands.find((strand) => strand.name === "sc-52751")!.id, url]);
    await tab.key({ name: "o" });
    expect(calls).toContainEqual(["open", url]);
    await pick("sc-1");
    await tab.key({ name: "R" });
    expect(tab.message).toBe("This strand has no draft pull request to mark ready");
    const dealer = new Dealer(actions, false, () => 0);
    dealer.setSnapshot(core.snapshot());
    for (let step = 0; step < 20 && dealer.card()?.name !== "sc-52751"; step++) await dealer.key({ name: "j" });
    expect(dealer.card()?.name).toBe("sc-52751");
    await dealer.key({ name: "R" });
    expect(calls.filter((call) => call[0] === "ready")).toHaveLength(2);
  });

  test("with two drafts, R asks which, and on a PR row in Reviews marks only that one", async () => {
    const { core, sync, strand } = setup();
    core.add(undefined, "sc-52751");
    const other = "https://github.com/acme/gadgets/pull/9";
    sync([own({ draft: true }), own({ draft: true, number: 9, url: other, repo: "acme/gadgets", title: "Gadgets" })]);
    const calls: string[][] = [];
    expect(await readyDrafts(strand("sc-52751"), async (args) => (calls.push(args), ""), other)).toBe("Marked gadgets#9 ready for review");
    expect(calls).toEqual([["pr", "ready", other]]);
    const { actions, calls: done } = recordingActions();
    const tab = new TabController(actions, () => 0);
    tab.setSnapshot(core.snapshot());
    await tab.key({ name: "j" });
    await tab.key({ name: "R" });
    expect(plain(tab.view(120, 30))).toContain("mark ready  1 widgets#212  2 gadgets#9");
    await tab.key({ name: "2", text: "2" });
    const reviews = new TabController(actions, () => 0, "reviews");
    reviews.setSnapshot(core.snapshot());
    await reviews.key({ name: "j" });
    expect(reviews.current()?.pr?.url).toBe(other);
    await reviews.key({ name: "R" });
    expect(done.filter((call) => call[0] === "ready")).toEqual([["ready", strand("sc-52751").id, other], ["ready", "pr:acme/gadgets#9", other]]);
  });
});

describe("the command tab on its reviews", () => {
  test("opens on Reviews: your PRs and where each stands, the pool nobody has reviewed with internal repos first, then what's already reviewed", async () => {
    const { core, sync } = setup();
    core.add(undefined, "sc-52751");
    const pool = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({ repo: "acme/widgets", number, title: `pool ${number}`, url: `https://github.com/acme/widgets/pull/${number}`, author: "alice", assignees: [], requested: [], reviews: [], head: "c1", ...over });
    const { actions, calls } = recordingActions();
    const empty = new TabController(actions, () => 0, "reviews");
    empty.setSnapshot(core.snapshot());
    expect(plain(empty.view(120, 30))).toContain("none open");
    sync([own({ reviews: [sam("APPROVED")] })], {
      reviews: [pool(1), pool(2, { repo: "acme/lib", url: "https://github.com/acme/lib/pull/2", public: true }), pool(3, { assignees: [me] }), pool(4, { reviews: [{ author: me, state: "CHANGES_REQUESTED", commit: "c1" }] }), pool(5, { reviews: [{ author: "sam", state: "APPROVED", commit: "c1" }] })],
    });
    const tab = new TabController(actions, () => 0, "reviews");
    tab.setSnapshot(core.snapshot());
    const screen = plain(tab.view(140, 40));
    expect(screen).toMatch(/1 Work 1 +2 Reviews 6 +3 Mentions 0/);
    expect(screen).toMatch(/my PRs 1[^\n]*\n▎ ● Partner Services section +widgets#212 +approved by sam · merge it/);
    expect(screen).toMatch(/waiting for review 3[^\n]*\n {2}● pool 3 +widgets#3 +assigned to you[^\n]*\n {2}○ pool 1 +widgets#1 +nobody yet[^\n]*\n {4}▸ 1 on public repos/);
    expect(screen).toMatch(/already reviewed 2[^\n]*\n {2}○ pool 5 +widgets#5 +approved by sam · nobody assigned[^\n]*\n {2}⊘ pool 4 +widgets#4 +you asked for changes · alice on it/);
    expect(screen).toContain("⏎  open widgets#212 on GitHub to merge");
    await tab.key({ name: "return" });
    await tab.key({ name: "o", text: "o" });
    expect(calls).toEqual([["open", url], ["open", url]]);
    for (let step = 0; step < 3; step++) await tab.key({ name: "j" });
    expect(tab.current()?.fold).toBe(true);
    await tab.key({ name: " ", text: " " });
    expect(plain(tab.view(140, 40))).toMatch(/▾ 1 on public repos[^\n]*\n {2}○ pool 2 +lib#2 +nobody yet/);
  });
});

describe("the unreviewed pool", () => {
  const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ repo: "acme/widgets", number: 1, title: "t", url: "https://github.com/acme/widgets/pull/1", author: "alice", assignees: [], requested: [], reviews: [], head: "c1", ...over });

  test("counts PRs nobody has taken or reviewed, not counting bots, Copilot or the author", () => {
    expect(isUnreviewed(pr())).toBe(true);
    expect(isUnreviewed(pr({ reviews: [{ author: "copilot-pull-request-reviewer", state: "COMMENTED", bot: true }, { author: "github-actions", state: "COMMENTED", bot: true }, { author: "alice", state: "COMMENTED" }] }))).toBe(true);
    expect(isUnreviewed(pr({ assignees: ["bob"] }))).toBe(false);
    expect(isUnreviewed(pr({ reviews: [{ author: "bob", state: "COMMENTED" }, { author: "carol", state: "DISMISSED" }] }))).toBe(true);
    expect(isUnreviewed(pr({ reviews: [{ author: "bob", state: "APPROVED" }] }))).toBe(false);
    expect(isUnreviewed(pr({ reviews: [{ author: "bob", state: "CHANGES_REQUESTED" }] }))).toBe(false);
  });

  test("comes from the pool search only", async () => {
    const node = (number: number, over: Record<string, unknown> = {}) => ({ title: "t", number, url: `https://github.com/acme/widgets/pull/${number}`, author: { login: "alice" }, repository: { nameWithOwner: "acme/widgets" }, assignees: { nodes: [] }, reviewRequests: { nodes: [] }, reviews: { nodes: [] }, commits: { nodes: [] }, ...over });
    const gh: Gh = async (args) => {
      if (args[1] === "user") return "octo";
      const q = args.find((arg) => arg.startsWith("q="))!;
      if (q.includes("org:")) return JSON.stringify({ data: { search: { nodes: [node(1), node(2, { assignees: { nodes: [{ login: "bob" }] } }), node(3, { reviews: { nodes: [{ state: "COMMENTED", author: { __typename: "Bot", login: "copilot-pull-request-reviewer" } }] } })] } } });
      if (q.includes("assignee:")) return JSON.stringify({ data: { search: { nodes: [node(4)] } } });
      return JSON.stringify({ data: { search: { nodes: [] } } });
    };
    expect((await fetchInbox(gh, "is:open is:pr org:acme")).unreviewed?.map((found) => found.number)).toEqual([1, 3]);
    expect((await fetchInbox(gh, "")).unreviewed).toBeUndefined();
  });

  test("is saved by the bridge after each poll", async () => {
    const core = new Ponpoko(new Store(":memory:"));
    const saved: Pool[] = [];
    const bridge = new Bridge(
      { knowledge: async () => core.knowledge(), record: async (facts, source = "komux") => core.record(source, facts), present: async () => undefined, absent: async () => undefined, importEpic: async () => undefined },
      async () => ({ ok: true }),
      () => 5,
      async () => undefined,
      async () => ({ me, reviews: [], mentioned: [], unreviewed: [{ repo: "acme/widgets", number: 1, title: "t", url: "u" }], complete: { reviews: false, mentioned: true, pool: true } }),
      undefined,
      (pool) => void saved.push(pool),
    );
    await bridge.pollInbox();
    expect(saved).toEqual([{ at: 5, complete: true, prs: [{ repo: "acme/widgets", number: 1, title: "t", url: "u" }] }]);
    const file = join(mkdtempSync(join(tmpdir(), "ponpoko-pool-")), "unreviewed.json");
    savePool(saved[0]!, file);
    expect(readPool(file)).toEqual(saved[0]);
  });

  test("colours the tray count by thresholds from the config, defaulting to 3, 6 and 10", () => {
    const defaults = unreviewedThresholds("/nonexistent/config.json");
    expect([0, 2, 3, 5, 6, 9, 10, 40].map((count) => unreviewedColor(count, defaults))).toEqual(["ok", "ok", "#ffc45e", "#ffc45e", "warning", "warning", "error", "error"]);
    const file = join(mkdtempSync(join(tmpdir(), "ponpoko-config-")), "config.json");
    writeFileSync(file, JSON.stringify({ github: { unreviewed: { yellow: 1, red: 4 } } }));
    expect(unreviewedThresholds(file)).toEqual({ yellow: 1, orange: 6, red: 4 });
    const pool = (count: number, complete = true): Pool => ({ at: 0, complete, prs: Array.from({ length: count }, (_, number) => ({ repo: "a/b", number, title: "t", url: "u" })) });
    expect(unreviewedLine(pool(7), defaults, 1000)).toEqual({ text: "● 7 to review", color: "warning" });
    expect(unreviewedLine(pool(50, false), defaults, 1000)).toEqual({ text: "● 50+ to review", color: "error" });
    expect(unreviewedLine(pool(2), defaults, 60 * 60_000)).toEqual({ text: "● 2 to review ?", color: "muted" });
    expect(unreviewedLine(undefined, defaults, 0)).toEqual({ text: "● ? to review", color: "muted" });
  });
});
