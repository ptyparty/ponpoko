import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ponpoko } from "./core.ts";
import { fetchInbox, mentionsUser, pendingMentions, reviewState, type Gh, type Inbox, type Mentioned, type PullRequest } from "./github.ts";
import { assignFacts, inboxFacts, isBookkeeping, isPooled, reviewsId } from "./inbox.ts";
import { PollLock } from "./komux/bridge.ts";
import { tabStrand } from "./komux/translate.ts";
import { Store } from "./store.ts";

const me = "octo";

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { repo: "acme/widgets", number: 1860, title: "Add a widget cache", url: "https://github.com/acme/widgets/pull/1860", author: "alice", assignees: [], requested: [], reviews: [], head: "c1", ...over };
}

function mentioned(over: Partial<Mentioned> = {}): Mentioned {
  return { repo: "acme/gadgets", number: 927, title: "Gadget emails", url: "https://github.com/acme/gadgets/pull/927", entries: [], ...over };
}

function setup() {
  let now = 1_000_000;
  let ids = 0;
  const newId = (prefix: string) => `${prefix}${++ids}`;
  const core = new Ponpoko(new Store(":memory:"), () => now, newId);
  const sync = (inbox: Partial<Inbox>) => {
    const facts = inboxFacts(core.knowledge(), { me, reviews: [], mentioned: [], ...inbox }, newId);
    core.record("github", facts);
    now += 1000;
    return facts;
  };
  const shown = () =>
    core
      .snapshot()
      .strands.map((strand) => `${"  ".repeat(strand.depth)}${strand.name} ${strand.own.whose ?? "-"}${strand.own.why ? ` ${strand.own.why}` : ""}`)
      .join("\n");
  const strand = (name: string) => core.snapshot().strands.find((candidate) => candidate.name === name)!;
  return { core, sync, shown, strand, newId };
}

describe("a pull request's review state", () => {
  test("is pooled until someone takes it, and names who approved it already", () => {
    expect(reviewState(pr(), me)).toEqual({ kind: "pool", why: "waiting for a reviewer" });
    expect(reviewState(pr({ reviews: [{ author: "carol", state: "APPROVED", commit: "c1" }] }), me)).toEqual({ kind: "pool", why: "nobody assigned; approved by carol" });
    expect(reviewState(pr({ assignees: ["bob"] }), me)).toEqual({ kind: "gone", why: "bob took it" });
  });

  test("is yours when you're assigned or asked, and the author's after you request changes until they push", () => {
    expect(reviewState(pr({ assignees: ["OCTO"] }), me)).toEqual({ kind: "yours", why: "assigned to you" });
    expect(reviewState(pr({ requested: [me] }), me)).toEqual({ kind: "yours", why: "your review is asked for" });
    const asked = { assignees: [me], reviews: [{ author: me, state: "CHANGES_REQUESTED", commit: "c1" }] };
    expect(reviewState(pr(asked), me)).toEqual({ kind: "author", why: "addressing your review", author: "alice" });
    expect(reviewState(pr({ ...asked, head: "c2" }), me)).toEqual({ kind: "yours", why: "alice pushed since your review" });
    expect(reviewState(pr({ ...asked, head: "c2", requested: [me] }), me)).toEqual({ kind: "yours", why: "your review is asked for again" });
  });

  test("is over once you approve, even if the author pushes after", () => {
    const approved = { assignees: [me], reviews: [{ author: me, state: "CHANGES_REQUESTED", commit: "c1" }, { author: me, state: "APPROVED", commit: "c2" }] };
    expect(reviewState(pr({ ...approved, head: "c2" }), me)).toEqual({ kind: "gone", why: "you approved it" });
    expect(reviewState(pr({ ...approved, head: "c3" }), me)).toEqual({ kind: "gone", why: "you approved it" });
  });

  test("ignores comments when deciding", () => {
    expect(reviewState(pr({ assignees: [me], reviews: [{ author: me, state: "CHANGES_REQUESTED", commit: "c1" }, { author: me, state: "COMMENTED", commit: "c2" }] }), me).kind).toBe("author");
  });
});

describe("mentions", () => {
  test("are pending when someone else mentions you after your last word and you haven't reacted", () => {
    const entries = [
      { url: "u1", author: "alice", at: "2026-11-01T10:00:00Z", body: "@octo can you look?", reacted: false },
      { url: "u2", author: me, at: "2026-11-01T11:00:00Z", body: "sure", reacted: false },
      { url: "u3", author: "bob", at: "2026-11-01T12:00:00Z", body: "cc @OCTO", reacted: false },
      { url: "u4", author: "bob", at: "2026-11-01T13:00:00Z", body: "@octo thoughts?", reacted: true },
      { url: "u5", author: "bob", at: "2026-11-01T14:00:00Z", body: "mail octo@example.com", reacted: false },
    ];
    expect(pendingMentions(mentioned({ entries }), me).map((mention) => mention.url)).toEqual(["u3"]);
  });

  test("need a real @login", () => {
    expect(mentionsUser("@octo hi", me)).toBe(true);
    expect(mentionsUser("(@octo)", me)).toBe(true);
    expect(mentionsUser("@octo-bot", me)).toBe(false);
    expect(mentionsUser("@octoter", me)).toBe(false);
    expect(mentionsUser("org/@octo", me)).toBe(false);
  });
});

describe("the GitHub inbox as strands", () => {
  test("pools reviews nobody has taken under reviews, waiting on GitHub", () => {
    const { sync, shown, strand } = setup();
    sync({ reviews: [pr(), pr({ number: 1861, title: "Drop old widgets", url: "https://github.com/acme/widgets/pull/1861", assignees: [me] })] });
    expect(shown()).toBe(["reviews - 1 yours · 1 waiting", "  widgets#1861 you assigned to you", "  widgets#1860 machine waiting for a reviewer"].join("\n"));
    expect(strand("widgets#1860").title).toBe("Add a widget cache");
    expect(isPooled(strand("widgets#1860"))).toBe(true);
    expect(isPooled(strand("widgets#1861"))).toBe(false);
    expect(strand("reviews").title).toBe("Pull requests waiting for a review");
  });

  test("records nothing when nothing changed", () => {
    const { sync } = setup();
    sync({ reviews: [pr()] });
    expect(sync({ reviews: [pr()] })).toEqual([]);
  });

  test("taking a pooled review makes it yours, and the next poll agrees", () => {
    const { core, sync, shown, strand, newId } = setup();
    sync({ reviews: [pr()] });
    core.record("github", assignFacts(strand("widgets#1860"), newId));
    expect(shown()).toContain("widgets#1860 you assigned to you");
    expect(sync({ reviews: [pr({ assignees: [me] })] }).filter((fact) => fact.type.startsWith("move"))).toEqual([]);
  });

  test("follows a review through changes requested, a push, and approval", () => {
    const { sync, shown } = setup();
    sync({ reviews: [pr({ assignees: [me] })] });
    sync({ reviews: [pr({ assignees: [me], reviews: [{ author: me, state: "CHANGES_REQUESTED", commit: "c1" }] })] });
    expect(shown()).toContain("widgets#1860 person addressing your review");
    sync({ reviews: [pr({ assignees: [me], head: "c2", reviews: [{ author: me, state: "CHANGES_REQUESTED", commit: "c1" }] })] });
    expect(shown()).toContain("widgets#1860 you alice pushed since your review");
    sync({ reviews: [pr({ assignees: [me], head: "c2", reviews: [{ author: me, state: "APPROVED", commit: "c2" }] })] });
    expect(shown()).toBe("");
  });

  test("closes your turn-ended moves when the review goes back to the author", () => {
    const { core, sync, strand } = setup();
    sync({ reviews: [pr({ assignees: [me] })] });
    core.record("komux", [{ type: "move.opened", move: "turn", strand: strand("widgets#1860").id, player: "you", what: "turn ended" }]);
    sync({ reviews: [pr({ assignees: [me], reviews: [{ author: me, state: "CHANGES_REQUESTED", commit: "c1" }] })] });
    expect(strand("widgets#1860").own.whose).toBe("person");
  });

  test("finishes reviews someone else took or that closed, and the reviews strand once nothing waits", () => {
    const { sync, shown, core } = setup();
    sync({ reviews: [pr(), pr({ number: 7, url: "https://github.com/acme/widgets/pull/7" })] });
    sync({ reviews: [pr({ assignees: ["bob"] })] });
    expect(shown()).toBe("");
    const done = core.knowledge().closed.map((strand) => [strand.name, strand.done !== undefined]);
    expect(done).toContainEqual(["reviews", true]);
    sync({ reviews: [pr({ number: 9, url: "https://github.com/acme/widgets/pull/9" })] });
    expect(shown()).toBe(["reviews - 1 waiting", "  widgets#9 machine waiting for a reviewer"].join("\n"));
  });

  test("a review you marked done stays done until your review is asked for or the author pushes", () => {
    const { core, sync, shown, strand } = setup();
    sync({ reviews: [pr()] });
    core.done(strand("widgets#1860").id);
    sync({ reviews: [pr()] });
    expect(shown()).toBe("");
    sync({ reviews: [pr({ assignees: [me] })] });
    expect(shown()).toContain("widgets#1860 you assigned to you");
    core.done(strand("widgets#1860").id);
    sync({ reviews: [pr({ assignees: [me] })] });
    expect(shown()).toBe("");
    sync({ reviews: [pr({ assignees: [me], head: "c9" })] });
    expect(shown()).toContain("widgets#1860 you assigned to you");
  });

  test("marking the reviews strand done dismisses every review in it until one changes", () => {
    const { core, sync, shown } = setup();
    sync({ reviews: [pr({ assignees: [me] }), pr({ number: 2, url: "https://github.com/acme/widgets/pull/2" })] });
    core.done(reviewsId);
    expect(sync({ reviews: [pr({ assignees: [me] }), pr({ number: 2, url: "https://github.com/acme/widgets/pull/2" })] }).filter((fact) => fact.type !== "link.added" && fact.type !== "link.removed")).toEqual([]);
    expect(shown()).toBe("");
    sync({ reviews: [pr({ assignees: [me], head: "c2" }), pr({ number: 2, url: "https://github.com/acme/widgets/pull/2" })] });
    expect(shown()).toBe(["reviews - 1 yours", "  widgets#1860 you assigned to you"].join("\n"));
  });

  test("makes each unanswered mention your move, naming who, and finishes it once you answer", () => {
    const { sync, shown, strand } = setup();
    const ask = { url: "https://github.com/acme/gadgets/pull/927#issuecomment-1", author: "alice", at: "2026-11-01T10:00:00Z", body: "@octo ok?", reacted: false };
    const again = { ...ask, url: "https://github.com/acme/gadgets/pull/927#issuecomment-2", author: "bob", at: "2026-11-01T11:00:00Z" };
    sync({ mentioned: [mentioned({ entries: [ask, again] })] });
    expect(shown()).toBe(["mentions - 1 yours", "  gadgets#927 you mentioned you, as did 1 more"].join("\n"));
    const move = strand("gadgets#927").open[0]!;
    expect(move.answers?.who).toBe("bob");
    expect(move.links.map((link) => link.ref)).toEqual([again.url]);
    sync({ mentioned: [mentioned({ entries: [ask, again, { ...ask, url: "mine", author: me, at: "2026-11-01T12:00:00Z", body: "yes" }] })] });
    expect(shown()).toBe("");
  });

  test("doesn't finish strands missing from a search that may have been cut short", () => {
    const { sync, shown } = setup();
    sync({ reviews: [pr(), pr({ number: 2, url: "https://github.com/acme/widgets/pull/2" })] });
    sync({ reviews: [pr()], complete: { reviews: false, mentioned: true } });
    expect(shown()).toContain("widgets#2");
    sync({ reviews: [pr()] });
    expect(shown()).not.toContain("widgets#2");
  });

  test("keeps the reviews strand open while a strand you added under it is", () => {
    const { core, sync, shown } = setup();
    sync({ reviews: [pr()] });
    core.add(reviewsId, "talk to bob");
    sync({ reviews: [] });
    expect(shown()).toBe(["reviews - 1 yours", "  talk to bob you no one on it"].join("\n"));
  });

  test("a forgotten review comes back under reviews on the next poll", () => {
    const { core, sync, shown } = setup();
    sync({ reviews: [pr()] });
    core.forget(reviewsId);
    sync({ reviews: [pr()] });
    expect(shown()).toBe(["reviews - 1 waiting", "  widgets#1860 machine waiting for a reviewer"].join("\n"));
  });

  test("keeps its bookkeeping out of the links a strand shows and the log", () => {
    const { core, sync, strand } = setup();
    sync({ reviews: [pr()] });
    expect(strand("widgets#1860").links.filter((link) => !isBookkeeping(link)).map((link) => link.adapter)).toEqual(["github"]);
    expect(core.snapshot().heard.some((event) => event.type === "link.added" && isBookkeeping(event))).toBe(false);
  });

  test("leaves everything alone when GitHub can't be reached", async () => {
    const failing: Gh = async () => {
      throw new Error("gh api failed: offline");
    };
    await expect(fetchInbox(failing, "is:open")).rejects.toThrow("offline");
  });
});

describe("fetching the inbox", () => {
  test("searches the pool, your assignments and requests, and mentions, then drops your own PRs and repeats", async () => {
    const calls: string[] = [];
    const node = (over: Record<string, unknown>) => ({ title: "t", number: 1, url: "https://github.com/acme/widgets/pull/1", author: { login: "alice" }, repository: { nameWithOwner: "acme/widgets" }, assignees: { nodes: [] }, reviewRequests: { nodes: [] }, reviews: { nodes: [] }, commits: { nodes: [{ commit: { oid: "c1" } }] }, ...over });
    const gh: Gh = async (args) => {
      if (args[1] === "user") return "octo\n";
      const q = args.find((arg) => arg.startsWith("q="))!.slice(2);
      calls.push(q);
      if (q.includes("mentions:")) return JSON.stringify({ data: { search: { nodes: [] } } });
      return JSON.stringify({ data: { search: { nodes: [node({}), node({ number: 2, url: "https://github.com/acme/widgets/pull/2", author: { login: "octo" } })] } } });
    };
    const inbox = await fetchInbox(gh, "is:open is:pr org:acme");
    expect(calls).toEqual(["is:open is:pr org:acme -author:octo", "is:open is:pr draft:false assignee:octo", "is:open is:pr draft:false review-requested:octo", "is:open is:pr draft:false reviewed-by:octo", "is:pr is:open mentions:octo"]);
    expect(inbox.reviews.map((found) => found.number)).toEqual([1]);
    expect(inbox.reviews[0]).toMatchObject({ head: "c1", author: "alice", repo: "acme/widgets" });
  });

  test("skips the pool without a review query", async () => {
    const calls: string[] = [];
    const gh: Gh = async (args) => {
      if (args[1] === "user") return "octo";
      calls.push(args.find((arg) => arg.startsWith("q="))!);
      return JSON.stringify({ data: { search: { nodes: [] } } });
    };
    await fetchInbox(gh, "");
    expect(calls).toHaveLength(4);
  });

  test("treats a review asked of your team as asked of you", async () => {
    const node = { title: "t", number: 4, url: "https://github.com/acme/widgets/pull/4", author: { login: "alice" }, repository: { nameWithOwner: "acme/widgets" }, assignees: { nodes: [] }, reviewRequests: { nodes: [{ requestedReviewer: {} }] }, reviews: { nodes: [] }, commits: { nodes: [] } };
    const gh: Gh = async (args) => {
      if (args[1] === "user") return "octo";
      const q = args.find((arg) => arg.startsWith("q="))!;
      return JSON.stringify({ data: { search: { nodes: q.includes("review-requested") || q.includes("org:") ? [node] : [] } } });
    };
    const inbox = await fetchInbox(gh, "is:open is:pr org:acme");
    expect(reviewState(inbox.reviews[0]!, me)).toEqual({ kind: "yours", why: "your review is asked for" });
  });

  test("keeps PRs you reviewed only while you're asking for changes, so they wait on the author without a review query", async () => {
    const node = (number: number, state: string) => ({ title: "t", number, url: `https://github.com/acme/widgets/pull/${number}`, author: { login: "alice" }, repository: { nameWithOwner: "acme/widgets" }, assignees: { nodes: [] }, reviewRequests: { nodes: [] }, reviews: { nodes: [{ state, author: { login: "octo" }, commit: { oid: "c1" } }] }, commits: { nodes: [{ commit: { oid: "c1" } }] } });
    const gh: Gh = async (args) => {
      if (args[1] === "user") return "octo";
      const q = args.find((arg) => arg.startsWith("q="))!;
      return JSON.stringify({ data: { search: { nodes: q.includes("reviewed-by") ? [node(1, "CHANGES_REQUESTED"), node(2, "APPROVED"), node(3, "COMMENTED")] : [] } } });
    };
    const inbox = await fetchInbox(gh, "");
    expect(inbox.reviews.map((found) => found.number)).toEqual([1]);
    expect(reviewState(inbox.reviews[0]!, me).kind).toBe("author");
  });

  test("reads mentions in reviews and review threads too, and says when a search may have been cut short", async () => {
    const entry = (url: string, body: string) => ({ url, createdAt: "2026-11-01T10:00:00Z", body, author: { login: "bob" }, reactionGroups: [] });
    const mentionNode = { title: "t", number: 5, url: "https://github.com/acme/widgets/pull/5", createdAt: "2026-11-01T09:00:00Z", body: "", author: { login: "alice" }, reactionGroups: [], repository: { nameWithOwner: "acme/widgets" }, comments: { nodes: [] }, reviews: { nodes: [entry("review", "@octo see this")] }, reviewThreads: { nodes: [{ comments: { nodes: [entry("thread", "@octo and this")] } }] } };
    const many = Array.from({ length: 50 }, (_, index) => ({ title: "t", number: 100 + index, url: `https://github.com/acme/widgets/pull/${100 + index}`, author: { login: "alice" }, repository: { nameWithOwner: "acme/widgets" } }));
    const gh: Gh = async (args) => {
      if (args[1] === "user") return "octo";
      const q = args.find((arg) => arg.startsWith("q="))!;
      return JSON.stringify({ data: { search: { nodes: q.includes("mentions:") ? [mentionNode] : q.includes("org:") ? many : [] } } });
    };
    const inbox = await fetchInbox(gh, "is:open is:pr org:acme");
    expect(pendingMentions(inbox.mentioned[0]!, me).map((mention) => mention.url).sort()).toEqual(["review", "thread"]);
    expect(inbox.complete).toEqual({ reviews: false, mentioned: true });
  });
});

describe("a pr-review tab", () => {
  test("finds its strand by path", () => {
    const { sync, core } = setup();
    sync({ reviews: [pr()], mentioned: [mentioned({ number: 1860, repo: "acme/widgets", entries: [{ url: "u", author: "bob", at: "1", body: "@octo", reacted: false }] })] });
    const knowledge = core.knowledge();
    const model = { strands: new Map(knowledge.strands.map((strand) => [strand.id, strand])), closed: new Map(knowledge.closed.map((strand) => [strand.id, strand])), links: knowledge.links };
    const tab = (strand: string) => ({ id: 1, number: 1, name: "widgets #1860", dir: "/w/acme/widgets", labels: { strand } });
    expect(tabStrand(tab("reviews › widgets#1860"), model)?.id).toBe("github:review:acme/widgets#1860");
    expect(tabStrand(tab("mentions › widgets#1860"), model)?.id).toBe("github:mention:acme/widgets#1860");
    expect(tabStrand(tab("widgets#1860"), model)?.id).toBeUndefined();
    expect(tabStrand(tab("reviews › gadgets#1"), model)).toBeUndefined();
  });
});

describe("polling GitHub from several komux sessions", () => {
  test("only one bridge holds the lock while it lives", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ponpoko-lock-")), "github.lock");
    const living = new Set([1, 2]);
    const one = new PollLock(file, 1, (pid) => living.has(pid));
    const two = new PollLock(file, 2, (pid) => living.has(pid));
    expect(one.take()).toBe(true);
    expect(two.take()).toBe(false);
    living.delete(1);
    expect(two.take()).toBe(true);
    two.release();
    expect(one.take()).toBe(true);
    one.release();
  });
});
