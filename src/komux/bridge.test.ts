import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness, strandNamed } from "../test-harness.ts";
import { inboxFacts } from "../inbox.ts";
import { handle } from "../server.ts";
import { forRequest, readFor, runFor } from "./for.ts";
import { loadProjects, readRoots } from "./projects.ts";
import { Bridge } from "./bridge.ts";
import { komuxLine } from "./stream.ts";
import { brief, goInKomux, goTarget, needsStoryDir, pickup, pickupOffer, pickUpInKomux } from "./go.ts";

const story = "/home/me/work/stories/sc-1234/widgets";
const side = "/home/me/work/ptyparty";

const sideTab = { id: 2, number: 2, name: "ptyparty", dir: side };

const snapshot = {
  type: "snapshot",
  tabs: [
    { id: 1, number: 1, name: "widgets", dir: story, labels: { strand: "sc-1234" } },
    sideTab,
  ],
  agents: [
    { paneId: 2, tabId: 1, state: "working", sessionId: "c1" },
    { paneId: 5, tabId: 2, state: "done" },
    { paneId: 6, tabId: 2, state: "idle" },
  ],
  jobs: [{ id: 7, tabId: 1, name: "build", state: "failed", code: 1, agent: false }],
  toasts: [],
  features: ["turns"],
};

const labelledSide = { ...snapshot, tabs: [snapshot.tabs[0], { ...sideTab, labels: { strand: "claude in ptyparty" } }] };

function shown(core: ReturnType<typeof harness>["core"]): string {
  return core
    .snapshot()
    .strands.map((strand) => `${"  ".repeat(strand.depth)}${strand.name} ${strand.own.whose ?? "-"} ${strand.open.map((move) => `${move.player === "you" ? `you(${move.answers?.id})` : move.by.id}: ${move.what}`).sort().join("; ")}`.trimEnd())
    .sort()
    .join("\n");
}

function line(core: ReturnType<typeof harness>["core"], name: string): string | undefined {
  return shown(core)
    .split("\n")
    .find((candidate) => candidate === name || candidate.startsWith(`${name} `));
}

describe("the komux bridge", () => {
  test("a working Claude fills the agent role on its tab's strand; a Claude in a tab with no strand, or that never had a turn, shows nowhere", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await Bun.sleep(0);
    expect(shown(core)).toBe("sc-1234 you pane:s1:2: working; you(job:s1:7): build failed (exit 1)");
    expect(strandNamed(core, "sc-1234")).toMatchObject({ title: "Widget CSV import", kind: "story" });
    expect(core.model.roles.get(strandNamed(core, "sc-1234").id)).toEqual({ agent: "pane:s1:2" });
    expect(core.model.players.has("pane:s1:5")).toBe(true);
    expect(core.model.players.has("pane:s1:6")).toBe(false);
    const agent = strandNamed(core, "sc-1234").open.find((move) => move.player === "pane:s1:2")!.by;
    expect([agent.live, agent.space, agent.place]).toEqual([true, "tab 1 widgets", { adapter: "komux", handle: "komux:s1:2", session: "main", server: "s1", tabId: 1, paneId: 2, dir: story, sessionId: "c1" }]);
  });

  test("your prompt is a request to the agent, its turn end answers it, and a full toast asks you to read the reply until you prompt again", async () => {
    const { core, hear, tick } = harness();
    await hear({ ...snapshot, jobs: [] });
    tick(60_000);
    await hear({ type: "agent.prompt", paneId: 2, tabId: 1, sessionId: "c1", by: "you" });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: working; pane:s1:2: your prompt");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1" } });
    await hear({ type: "agent.turn", paneId: 2, tabId: 1, sessionId: "c1", toast: "full" });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(pane:s1:2): read reply");
    expect(strandNamed(core, "sc-1234").own.since).toBe(1_060_000);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "idle", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(pane:s1:2): read reply");
    await hear({ type: "agent.prompt", paneId: 2, tabId: 1, sessionId: "c1", by: "you" });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: working; pane:s1:2: your prompt");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1" } });
    await hear({ type: "agent.turn", paneId: 2, tabId: 1, sessionId: "c1", toast: "brief" });
    expect(line(core, "sc-1234")).toBe("sc-1234 -");
  });

  test("a task notification's turn asks nothing of the agent, and only a full toast asks you to read it", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    await hear({ type: "agent.prompt", paneId: 2, tabId: 1, sessionId: "c1", by: "task" });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: working");
    await hear({ type: "agent.turn", paneId: 2, tabId: 1, sessionId: "c1", toast: "none" });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "idle", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 -");
    await hear({ type: "agent.prompt", paneId: 2, tabId: 1, sessionId: "c1", by: "task" });
    await hear({ type: "agent.turn", paneId: 2, tabId: 1, sessionId: "c1", toast: "full" });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(pane:s1:2): read reply");
  });

  test("a prompt ponpoko sent is told apart from yours", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    await hear({ type: "agent.prompt", paneId: 2, tabId: 1, sessionId: "c1", by: "sent" });
    expect(strandNamed(core, "sc-1234").open.map((move) => move.what)).toContain("a prompt from ponpoko");
  });

  test("an older komux with no prompt lines counts each working turn as your prompt and each turn end as a full toast", async () => {
    const { core, hear } = harness();
    const { features: _features, ...older } = snapshot;
    await hear({ ...older, jobs: [], agents: [{ paneId: 2, tabId: 1, state: "idle", sessionId: "c1" }] });
    expect(line(core, "sc-1234")).toBe("sc-1234 -");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: working; pane:s1:2: your prompt");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(pane:s1:2): read reply");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: working; pane:s1:2: your prompt");
  });

  test("rule 2: a turn end with a full toast asks you to read it beside the review it doesn't answer", async () => {
    const { core, hear, replied } = harness();
    await hear({ ...snapshot, jobs: [] });
    const story = strandNamed(core, "sc-1234").id;
    core.record("github", [
      { type: "party.known", party: "group:team", kind: "group", name: "the team" },
      { type: "said", requests: [{ request: "r-review", strand: story, to: { group: "group:team" }, what: "review widgets#9" }], replies: [] },
    ]);
    await replied(2, 1, "full");
    expect(strandNamed(core, "sc-1234").rolled.tally).toBe("1 for the team · 1 for you (read reply)");
    await hear({ type: "agent.prompt", paneId: 2, tabId: 1, by: "you" });
    await hear({ type: "agent.turn", paneId: 2, tabId: 1, toast: "brief" });
    expect(strandNamed(core, "sc-1234").rolled.tally).toBe("1 for the team");
    expect(core.model.requests.get("r-review")!.closed).toBeUndefined();
  });

  test("a question open in komux asks the owner, and answering it hands the move back", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1", asking: true } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(job:s1:7): build failed (exit 1); you(pane:s1:2): asking you");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you pane:s1:2: working; you(job:s1:7): build failed (exit 1)");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "waiting", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(job:s1:7): build failed (exit 1); you(pane:s1:2): waiting on you");
  });

  test("closing a pane takes its agent off the strand and answers what it asked", async () => {
    const { core, hear, replied } = harness();
    await hear({ ...snapshot, jobs: [] });
    await replied(2, 1);
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    expect(shown(core)).toBe("sc-1234 -");
    expect(strandNamed(core, "sc-1234").own.why).toBe("quiet");
    expect(core.model.players.get("pane:s1:2")!.gone).toBeDefined();
  });

  test("closing a pane mid-turn withdraws your prompt to it, but what it asked of others stays open", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    core.present({ adapter: "komux", scope: "main/s1", players: ["pane:s1:2"], spaces: [] });
    core.wait({ self: "komux:s1:2", who: "Sam", kind: "person", what: "approve the schema" });
    await hear({ type: "agent.prompt", paneId: 2, tabId: 1, sessionId: "c1", by: "you" });
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    expect(strandNamed(core, "sc-1234").open.map((move) => move.what)).toEqual(["approve the schema"]);
    expect([...core.model.requests.values()].find((request) => request.kind === "prompt")!.closed?.as).toBe("withdrawn");
  });

  test("a Claude in a tab with no strand takes the strand it first names, and its turns land there", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await hear({ type: "agent.state", agent: { paneId: 5, tabId: 2, state: "working" } });
    expect(shown(core)).not.toContain("pane:s1:5");
    core.present({ adapter: "komux", scope: "main/s1", players: ["pane:s1:5"], spaces: [] });
    expect(() => core.status({ self: "komux:s1:5", text: "sketching an idea" })).toThrow("name the strand");
    core.status({ self: "komux:s1:5", strand: "sketch", text: "sketching an idea" });
    await hear({ type: "agent.prompt", paneId: 5, tabId: 2, by: "you" });
    await hear({ type: "agent.state", agent: { paneId: 5, tabId: 2, state: "done" } });
    await hear({ type: "agent.turn", paneId: 5, tabId: 2, toast: "full" });
    expect(line(core, "sketch")).toBe("sketch you you(pane:s1:5): read reply");
    await hear({ type: "agent.gone", paneId: 5, tabId: 2 });
    expect(line(core, "sketch")).toBe("sketch -");
  });

  test("komux's turns keep a Claude on the strand under its own that it said it's on, and count it once", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    core.present({ adapter: "komux", scope: "main/s1", players: ["pane:s1:2"], spaces: [] });
    core.status({ self: "komux:s1:2", strand: "importer", text: "fixing the importer" });
    await hear({ type: "agent.prompt", paneId: 2, tabId: 1, sessionId: "c1", by: "you" });
    expect(core.snapshot().counts.agents).toBe(1);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1", asking: true } });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1" } });
    expect(line(core, "  importer")).toBe("  importer agent pane:s1:2: working");
  });

  test("a second Claude in a tab can move from the strand made for it to the one it names", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    await hear({ type: "agent.state", agent: { paneId: 3, tabId: 1, state: "working", sessionId: "c3" } });
    core.present({ adapter: "komux", scope: "main/s1", players: ["pane:s1:2", "pane:s1:3"], spaces: [] });
    core.add(undefined, "sc-1250");
    expect(core.status({ self: "komux:s1:3", strand: "sc-1250", text: "on the fees story" })).toBe("sc-1250");
    expect(core.snapshot().strands.map((strand) => strand.name)).not.toContain("claude 3");
  });

  test("a second Claude in the same tab is the agent on a strand of its own under the tab's", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    await hear({ type: "agent.state", agent: { paneId: 3, tabId: 1, state: "working", sessionId: "c3" } });
    expect(line(core, "  claude 3")).toBe("  claude 3 agent pane:s1:3: working");
    expect(core.model.roles.get(strandNamed(core, "sc-1234").id)).toEqual({ agent: "pane:s1:2" });
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    await hear({ type: "agent.state", agent: { paneId: 4, tabId: 1, state: "working", sessionId: "c4" } });
    expect(core.model.roles.get(strandNamed(core, "sc-1234").id)).toEqual({ agent: "pane:s1:4" });
  });

  test("a tab labelled with a strand that doesn't exist makes nothing, but a failed job there gets a loose strand", async () => {
    const { core, hear } = harness(1_000_000, undefined, undefined, undefined, false);
    await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/widgets", labels: { strand: "widgets" } }], agents: [{ paneId: 2, tabId: 1, state: "done" }], jobs: [{ id: 7, tabId: 1, name: "build", state: "failed", code: 1, agent: false }], features: ["turns"] });
    expect(shown(core)).toBe("build in widgets you you(job:s1:7): build failed (exit 1)");
    core.add(undefined, "widgets");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working" } });
    expect(line(core, "widgets")).toBe("widgets agent pane:s1:2: working");
  });

  test("a new komux in the same session takes the old one's agents off, and its own Claude takes the strand", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await hear({ server: "s2", type: "snapshot", tabs: snapshot.tabs, agents: [{ paneId: 3, tabId: 1, state: "working", sessionId: "c1" }], jobs: [] });
    expect(shown(core)).toBe("sc-1234 agent pane:s2:3: working");
    expect(core.model.players.get("pane:s1:2")!.gone).toBeDefined();
  });

  test("a conversation resumed in a new pane is the agent on the strand it was on", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    core.present({ adapter: "komux", scope: "main/s1", players: ["pane:s1:2"], spaces: [] });
    core.status({ self: "komux:s1:2", strand: "importer", text: "fixing the importer" });
    await hear({ server: "s2", type: "snapshot", tabs: snapshot.tabs, agents: [{ paneId: 8, tabId: 1, state: "working", sessionId: "c1" }], jobs: [] });
    expect(core.model.roles.get(strandNamed(core, "sc-1234").id)).toEqual({ agent: "pane:s2:8" });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s2:8: working");
  });

  test("a tab's label finds its strand even when the strand sits under another, such as a story under its epic", async () => {
    const { core, hear } = harness();
    core.add(undefined, "epic 9 › sc-1234");
    await hear(snapshot);
    expect(line(core, "  sc-1234")).toBe("  sc-1234 you pane:s1:2: working; you(job:s1:7): build failed (exit 1)");
    expect(core.snapshot().strands.filter((strand) => strand.name === "sc-1234")).toHaveLength(1);
  });

  test("opening a tab labelled with a strand makes that strand at once, with nothing asked yet", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, agents: [], jobs: [] });
    await hear({ type: "tab.opened", tab: { id: 3, number: 3, name: "acme-libraries #540", dir: "/w/acme-libraries", labels: { strand: "sc-1235", pr: "540" } } });
    expect(line(core, "sc-1235")).toBe("sc-1235 -");
    await hear({ type: "tab.opened", tab: { id: 4, number: 4, name: "another", dir: "/w/x", labels: { strand: "SC-1235" } } });
    expect(core.snapshot().strands.filter((strand) => strand.name === "sc-1235")).toHaveLength(1);
  });

  test("a finished strand isn't made again when its Claude goes idle, and comes back when it works again or you open its tab", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    core.present({ adapter: "komux", scope: "main/s1", players: ["pane:s1:2"], spaces: [] });
    core.doneBy({ self: "komux:s1:2" }, "finished");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "idle", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBeUndefined();
    await hear({ ...snapshot, jobs: [], agents: [{ paneId: 2, tabId: 1, state: "idle", sessionId: "c1" }] });
    expect(line(core, "sc-1234")).toBeUndefined();
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: working");
    expect(core.snapshot().strands.filter((strand) => strand.name === "sc-1234")).toHaveLength(1);
    core.doneBy({ self: "komux:s1:2" }, "finished again");
    await hear({ type: "tab.opened", tab: { id: 5, number: 5, name: "widgets again", dir: story, labels: { strand: "sc-1234" } } });
    expect(line(core, "sc-1234")).toBe("sc-1234 -");
  });

  test("reconnecting or replaying a snapshot records nothing new", async () => {
    const { hear, store } = harness();
    await hear(snapshot);
    const facts = store.all().length;
    await hear(snapshot);
    expect(store.all().length).toBe(facts);
  });

  test("old open moves from komux are closed once komux is heard again", async () => {
    const { core, hear } = harness();
    core.add(undefined, "sc-1234");
    core.record("komux", [
      { type: "player.joined", player: "pane:s1:2", kind: "agent", who: "claude", adapter: "komux" },
      { type: "move.opened", move: "m-old", strand: strandNamed(core, "sc-1234").id, player: "you", with: "pane:s1:2", what: "ready for a prompt", kind: "ready" },
    ]);
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(pane:s1:2): ready for a prompt");
    await hear({ ...snapshot, jobs: [] });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: working");
  });

  test("a Claude's own background job runs on its strand for it, and goes when the job is over", async () => {
    const { core, hear, store } = harness();
    await hear({ ...snapshot, jobs: [] });
    const build = { id: 9, tabId: 1, name: "gadgets build", state: "running", agent: false, startedBy: 2 };
    await hear({ type: "job.started", job: build });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1" } });
    await hear({ type: "agent.turn", paneId: 2, tabId: 1, sessionId: "c1", toast: "none" });
    expect(line(core, "sc-1234")).toBe("sc-1234 machine job:s1:9: running");
    expect(strandNamed(core, "sc-1234").open[0]!.answers!.id).toBe("pane:s1:2");
    expect(core.snapshot().moves.map((strand) => strand.name)).not.toContain("sc-1234");
    expect(goTarget(strandNamed(core, "sc-1234"), [], { KOMUX_SESSION: "main", KOMUX_SERVER_ID: "s1" })?.player.id).toBe("pane:s1:2");
    const facts = store.all().length;
    await hear({ ...snapshot, agents: [{ paneId: 2, tabId: 1, state: "done", sessionId: "c1" }, ...snapshot.agents.slice(1)], jobs: [build] });
    expect(store.all().length).toBe(facts);
    await hear({ type: "job.finished", job: { ...build, state: "succeeded", code: 0 } });
    expect(line(core, "sc-1234")).toBe("sc-1234 -");
  });

  test("a Claude whose turn ends with background agents running shows them as its activity until nothing is left", async () => {
    const { core, hear, store } = harness();
    await hear({ ...snapshot, jobs: [] });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1", background: { agents: 3, tasks: 0 } } });
    await hear({ type: "agent.turn", paneId: 2, tabId: 1, sessionId: "c1", toast: "none" });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: 3 background agents");
    expect(core.snapshot().moves.map((strand) => strand.name)).not.toContain("sc-1234");
    const facts = store.all().length;
    await hear({ ...snapshot, agents: [{ paneId: 2, tabId: 1, state: "done", sessionId: "c1", background: { agents: 3, tasks: 0 } }, ...snapshot.agents.slice(1)], jobs: [] });
    expect(store.all().length).toBe(facts);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "idle", sessionId: "c1", background: { agents: 1, tasks: 2 } } });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: 1 background agent · 2 background tasks");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 -");
  });

  test("a live test an agent asked for survives its turn ending", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    core.present({ adapter: "komux", scope: "main/s1", players: ["pane:s1:2"], spaces: [] });
    core.wait({ self: "komux:s1:2", strand: "sc-1234", who: "you", kind: "you", what: "try it in the browser" });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1", background: { agents: 1, tasks: 0 } } });
    await hear({ type: "agent.turn", paneId: 2, tabId: 1, sessionId: "c1", toast: "none" });
    expect(strandNamed(core, "sc-1234").open.map((move) => move.what).sort()).toEqual(["1 background agent", "try it in the browser"]);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1" } });
    expect(strandNamed(core, "sc-1234").open.map((move) => move.what)).toEqual(["try it in the browser"]);
  });

  test("a Claude with background agents running that asks you something, or needs you, is your move", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    const busy = { agents: 2, tasks: 0 };
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1", background: busy } });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", asking: true, sessionId: "c1", background: busy } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(pane:s1:2): asking you");
  });

  test("background commands that run as komux jobs show as the jobs, not again in the count", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    const build = { id: 9, tabId: 1, name: "gadgets build", state: "running", agent: false, startedBy: 2 };
    await hear({ type: "job.started", job: build });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1", background: { agents: 1, tasks: 1 } } });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent job:s1:9: running; pane:s1:2: 1 background agent");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1", background: { agents: 0, tasks: 1 } } });
    expect(line(core, "sc-1234")).toBe("sc-1234 machine job:s1:9: running");
  });

  test("older komux lines with no background count, or a malformed one, read as nothing running", () => {
    const agent = (background: unknown) => komuxLine.parse({ type: "agent.state", session: "main", agent: { paneId: 2, tabId: 1, state: "done", background } });
    expect(komuxLine.parse({ type: "agent.state", session: "main", agent: { paneId: 2, tabId: 1, state: "done" } })).toMatchObject({ agent: { state: "done" } });
    expect(agent({ agents: 2, tasks: 1 })).toMatchObject({ agent: { background: { agents: 2, tasks: 1 } } });
    const malformed = agent("lots");
    expect(malformed.type === "agent.state" ? malformed.agent.background : "not an agent line").toBeUndefined();
  });

  test("a job that says which strand it's for runs there, not on the strand of the tab whose Claude started it, whichever comes first", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    core.add(strandNamed(core, "sc-1234").id, "gadgets");
    core.add(strandNamed(core, "sc-1234").id, "widgets");
    const build = { id: 9, tabId: 1, name: "build", state: "running", agent: false, startedBy: 2 };
    await hear({ type: "job.started", job: build });
    expect(handle(core, { method: "for", params: { strand: "gadgets", player: "job:s1:9", dir: story } })).toEqual({ ok: true, result: { strand: "sc-1234 › gadgets" } });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1" } });
    expect(shown(core)).toContain("  gadgets machine job:s1:9: running");
    expect(strandNamed(core, "sc-1234 › gadgets").open[0]?.answers?.id).toBe("pane:s1:2");
    const rerun = { ...build, id: 10 };
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1" } });
    await hear({ type: "job.started", job: rerun });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1" } });
    expect(shown(core)).toContain("sc-1234 machine job:s1:10: running");
    core.workFor({ strand: "widgets", player: "job:s1:10", dir: story });
    expect(shown(core)).toContain("  widgets machine job:s1:10: running");
    await hear({ type: "job.finished", job: { ...rerun, state: "succeeded", code: 0 } });
    expect(strandNamed(core, "sc-1234 › widgets").open).toEqual([]);
    await hear({ type: "job.finished", job: { ...build, state: "failed", code: 1 } });
    expect(strandNamed(core, "sc-1234 › gadgets").open).toEqual([]);
  });

  test("ponpoko for reads the strand from its arguments or PONPOKO_STRAND, and names the job it runs in", async () => {
    expect(readFor(["sc-1 › gadgets", "--", "scripts/build", "-v"], {})).toEqual({ strand: "sc-1 › gadgets", command: ["scripts/build", "-v"] });
    expect(readFor(["--", "scripts/build"], { PONPOKO_STRAND: "gadgets" })).toEqual({ strand: "gadgets", command: ["scripts/build"] });
    expect(readFor(["--", "scripts/build"], {})).toContain("name the strand");
    expect(readFor(["scripts/build", "-v"], { PONPOKO_STRAND: "gadgets" })).toEqual({ strand: "gadgets", command: ["scripts/build", "-v"] });
    expect(await runFor(["nowhere", "--", "false"], { KOMUX_SERVER_ID: "s1", KOMUX_JOB: "9", PATH: process.env.PATH }, async () => {
      throw new Error("ponpoko knows of no strand nowhere");
    })).toBe(1);
    expect(await runFor(["nowhere", "--", "true"], { KOMUX_SERVER_ID: "s1", KOMUX_JOB: "9", PATH: process.env.PATH }, async () => {
      throw new Error("ponpoko knows of no strand nowhere");
    })).toBe(0);
    expect(forRequest("gadgets", { KOMUX_SERVER_ID: "s1", KOMUX_JOB: "9" }, "/w")).toEqual({ method: "for", params: { strand: "gadgets", player: "job:s1:9", dir: "/w" } });
    expect(forRequest("gadgets", {}, "/w")).toBeUndefined();
    const sent: unknown[] = [];
    expect(await runFor(["gadgets", "--", "true"], { KOMUX_SERVER_ID: "s1", KOMUX_JOB: "9", PATH: process.env.PATH }, async (request) => sent.push(request))).toBe(0);
    expect(await runFor(["gadgets", "--", "false"], { PATH: process.env.PATH }, async (request) => sent.push(request))).toBe(1);
    expect(sent).toHaveLength(1);
  });

  test("a wait an agent asked for stays open through its turn ending, and a strand waiting on another is quiet till it's done", async () => {
    const { core, hear, tick } = harness();
    await hear({ ...snapshot, jobs: [] });
    core.wait({ self: "komux:s1:2", who: "Copilot", kind: "machine", what: "reviewing PR #821" });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1" } });
    await hear({ type: "agent.turn", paneId: 2, tabId: 1, sessionId: "c1", toast: "none" });
    expect(line(core, "sc-1234")).toBe("sc-1234 machine service:copilot: reviewing PR #821");
    core.wait({ self: "komux:s1:2", who: "Copilot", kind: "machine", what: "reviewing PR #821", over: true });
    core.add(undefined, "sc-2");
    core.blockBy({ self: "komux:s1:2", on: "sc-2" });
    expect(strandNamed(core, "sc-1234").own.why).toBe("waiting on sc-2");
    expect(core.snapshot().moves.map((strand) => strand.name)).not.toContain("sc-1234");
    tick(60_000);
    core.done(strandNamed(core, "sc-2").id);
    expect(strandNamed(core, "sc-1234").own.why).toBe("sc-2 is done");
  });

  test("a failed job stays yours through a dismissed toast, until it passes", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await hear({ type: "toast.dismissed", toast: { kind: "job", id: 7, tabId: 1 } });
    expect(strandNamed(core, "sc-1234").dismissedAt).toBe(1_000_000);
    await hear({ type: "job.finished", job: { id: 7, tabId: 1, name: "build", state: "succeeded", code: 0 } });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: working");
  });

  test("a Claude starting work answers nothing it wasn't handed: GitHub's asks and another Claude's question stay open", async () => {
    const { core, hear } = harness();
    const two = { type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: story, labels: { strand: "sc-1234" } }], agents: [{ paneId: 3, tabId: 1, state: "working", asking: true }], jobs: [] };
    await hear(two);
    core.record("github", [{ type: "move.opened", move: "gh", strand: strandNamed(core, "sc-1234").id, player: "you", what: "assigned to you" }]);
    await hear({ type: "agent.state", agent: { paneId: 4, tabId: 1, state: "working" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(pane:s1:3): asking you; you(undefined): assigned to you");
  });

  test("focusing an agent that asked you something marks its strand seen", async () => {
    const { core, hear, replied } = harness();
    await hear(labelledSide);
    await replied(5, 2);
    expect(strandNamed(core, "claude in ptyparty").unseen).toBe(true);
    await hear({ type: "focus", tabId: 2, paneId: 5 });
    expect(strandNamed(core, "claude in ptyparty").unseen).toBe(false);
  });

  test("pointing a directory gives its tabs a strand, and the agent's next turns land there", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    core.point(side, "ptyparty");
    expect(line(core, "ptyparty")).toBe("ptyparty -");
    await hear({ type: "agent.state", agent: { paneId: 5, tabId: 2, state: "working" } });
    expect(line(core, "ptyparty")).toBe("ptyparty agent pane:s1:5: working");
  });

  test("lines heard while the service is down are caught up once it's back", async () => {
    const { core, hear, bridge, service } = harness();
    await hear(snapshot);
    service.down = true;
    await hear({ type: "tab.opened", tab: { id: 3, number: 3, name: "new", dir: side, labels: { strand: "claude in new" } } });
    await hear({ type: "agent.state", agent: { paneId: 9, tabId: 3, state: "waiting" } });
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    service.down = false;
    await hear({ type: "focus", tabId: 1, paneId: 5 });
    expect(core.model.players.has("pane:s1:9")).toBe(false);
    await bridge.heartbeat();
    expect(strandNamed(core, "claude in new").open.map((move) => move.what)).toEqual(["waiting on you"]);
    expect(core.model.players.get("pane:s1:2")!.gone).toBeDefined();
  });

  test("a bridge leaving an old komux doesn't take away the new one's presence", async () => {
    const { core, hear, bridge } = harness();
    await hear(snapshot);
    const second = harness(1_000_000, undefined, core);
    await second.hear({ server: "s2", type: "snapshot", tabs: snapshot.tabs, agents: [{ paneId: 3, tabId: 1, state: "working" }], jobs: [] });
    await bridge.leave();
    expect(strandNamed(core, "sc-1234").open.find((move) => move.by.id === "pane:s2:3")!.by.live).toBe(true);
  });

  test("badges each tab with whose move its strands hold, sending only changes", async () => {
    const { core, hear, sent } = harness();
    await hear(snapshot);
    expect(sent).toEqual([{ method: "tab.badge", params: { tabId: 1, owner: "ponpoko", text: "●", color: "warning" } }]);
    sent.length = 0;
    await hear({ type: "job.closed", jobId: 7, tabId: 1 });
    core.wait({ dir: story, strand: "sc-1234", who: "Copilot", kind: "machine", what: "review" });
    await hear({ type: "toast.shown", toast: { kind: "job", id: 7, tabId: 1 } });
    expect(sent).toEqual([{ method: "tab.badge", params: { tabId: 1, owner: "ponpoko", text: null } }]);
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    expect(sent.at(-1)).toEqual({ method: "tab.badge", params: { tabId: 1, owner: "ponpoko", text: "⊘", color: "muted" } });
  });
});

describe("Shortcut titles", () => {
  test("the bridge titles top-level story strands once Shortcut answers, and leaves titled and nested ones alone", async () => {
    const asked: string[] = [];
    const { core, hear } = harness(1_000_000, undefined, undefined, async (name) => (asked.push(name), name === "sc-2" ? undefined : { kind: "epic", title: `title of ${name}` }));
    core.add(undefined, "sc-1 › sc-3");
    core.add(undefined, "sc-2");
    core.add(undefined, "sc-4");
    core.record("you", [{ type: "strand.titled", strand: strandNamed(core, "sc-4").id, title: "already" }]);
    core.add(undefined, "ptyparty");
    await hear(snapshot);
    await Bun.sleep(0);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1" } });
    await Bun.sleep(0);
    expect(asked.sort()).toEqual(["sc-1", "sc-1234", "sc-2"]);
    expect(strandNamed(core, "sc-1")).toMatchObject({ kind: "epic", title: "title of sc-1" });
    expect(strandNamed(core, "sc-1 › sc-3").title).toBeUndefined();
    expect(strandNamed(core, "sc-2").title).toBeUndefined();
    expect(strandNamed(core, "sc-4").title).toBe("already");
  });

  test("a lookup that fails is tried again ten minutes later", async () => {
    let fail = true;
    let asks = 0;
    const { core, hear, tick } = harness(1_000_000, undefined, undefined, async () => {
      asks++;
      if (fail) throw new Error("offline");
      return { kind: "story", title: "Widget CSV import" };
    });
    await hear(snapshot);
    await Bun.sleep(0);
    fail = false;
    tick(5 * 60_000);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "done", sessionId: "c1" } });
    await Bun.sleep(0);
    expect([asks, strandNamed(core, "sc-1234").title]).toEqual([1, undefined]);
    tick(5 * 60_000);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1" } });
    await Bun.sleep(0);
    expect([asks, strandNamed(core, "sc-1234").title]).toEqual([2, "Widget CSV import"]);
  });
});

describe("go in komux", () => {
  const env = { KOMUX_SOCKET: "/run/main.control.sock", KOMUX_SESSION: "main", KOMUX_SERVER_ID: "s1" };
  const recorder = () => {
    const sent: unknown[] = [];
    return { sent, control: async (request: unknown) => (sent.push(request), { ok: true }) };
  };

  test("opens a review's pull request in the pr-review layout by repo, and comes back to that tab once it's open", async () => {
    const { core, hear } = harness();
    const pr = { repo: "acme/widgets", number: 1860, title: "Add a widget cache", url: "https://github.com/acme/widgets/pull/1860", author: "alice", assignees: ["octo"], requested: [], reviews: [], head: "c1" };
    let ids = 0;
    core.record("github", inboxFacts(core.knowledge(), { me: "octo", reviews: [pr], mentioned: [] }, (prefix) => `${prefix}gh${++ids}`));
    const review = () => core.snapshot().strands.find((strand) => strand.name === "widgets#1860")!;
    const { sent, control } = recorder();
    await goInKomux(review(), core.snapshot().strands, env, control);
    expect(sent).toEqual([{ method: "project.open", params: { repo: "acme/widgets", layout: "pr-review", args: { pr: "1860", strand: "reviews › widgets#1860" } } }]);
    await hear({ type: "snapshot", tabs: [{ id: 4, number: 4, name: "widgets #1860", dir: "/w/acme/widgets", layout: "pr-review", args: { pr: "1860", strand: "reviews › widgets#1860" }, labels: { strand: "reviews › widgets#1860" } }], agents: [], jobs: [] });
    sent.length = 0;
    expect((await goInKomux(review(), core.snapshot().strands, env, control)).how).toBe("focused");
    expect(sent).toEqual([{ method: "tab.focus", params: { tabId: 4 } }]);
  });

  test("focuses the tab a strand waits on in this session, and opens a tab here for anything else", async () => {
    const { core, hear } = harness();
    await hear(labelledSide);
    const { sent, control } = recorder();
    expect((await goInKomux(strandNamed(core, "claude in ptyparty"), [], env, control)).how).toBe("focused");
    expect((await goInKomux(strandNamed(core, "claude in ptyparty"), [], { ...env, KOMUX_SESSION: "other", KOMUX_SERVER_ID: "s9" }, control)).how).toBe("opened");
    expect(sent).toEqual([
      { method: "tab.focus", params: { tabId: 2 } },
      { method: "project.open", params: { target: side } },
    ]);
  });

  test("goes to an agent's tab without showing the agent, even when it waits on you", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    const { sent, control } = recorder();
    await goInKomux(strandNamed(core, "sc-1234"), [], env, control);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "waiting", sessionId: "c1" } });
    await goInKomux(strandNamed(core, "sc-1234"), [], env, control);
    expect(sent).toEqual([
      { method: "tab.focus", params: { tabId: 1 } },
      { method: "tab.focus", params: { tabId: 1 } },
    ]);
  });

  test("needs komux", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await expect(goInKomux(strandNamed(core, "sc-1234"), [], {})).rejects.toThrow("go works from inside komux");
  });

  test("a strand no one is on offers its last Claude to resume, or a fresh one briefed with its moves", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    core.present({ adapter: "komux", scope: "main/s1", players: ["pane:s1:2"], spaces: [] });
    core.status({ self: "komux:s1:2", text: "fixing the importer", page: "sc-1234/plan.md" });
    expect(pickup(strandNamed(core, "sc-1234"))).toBeUndefined();
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    const strand = strandNamed(core, "sc-1234");
    expect(pickup(strand)).toEqual({ resume: { session: "c1", dir: story, who: "claude", at: 1_000_000 }, dir: story });
    expect(brief(strand)).toContain('You\'re picking up the strand "sc-1234" in ponpoko: Widget CSV import.');
    expect(brief(strand)).toContain("- claude: fixing the importer");
    expect(brief(strand)).toContain("- quoll sc-1234/plan.md");
    const { sent, control } = recorder();
    await pickUpInKomux(strand, "resume", env, control);
    await pickUpInKomux(strand, "fresh", env, control);
    expect(sent).toEqual([
      { method: "claude.start", params: { target: story, resume: "c1" } },
      { method: "claude.start", params: { target: story, prompt: brief(strand) } },
    ]);
  });

  test("picking up a strand reopens the layout and args its Claude's tab was opened with, such as a PR review", async () => {
    const { core, hear } = harness();
    const review = { id: 3, number: 3, name: "acme-libraries #540", dir: "/w/acme-libraries", labels: { strand: "sc-1235" }, layout: "pr-review", args: { pr: "540", strand: "sc-1235" } };
    await hear({ ...snapshot, tabs: [...snapshot.tabs, review], agents: [{ paneId: 9, tabId: 3, state: "done", sessionId: "r1" }], jobs: [] });
    await hear({ type: "agent.gone", paneId: 9, tabId: 3 });
    const { sent, control } = recorder();
    await pickUpInKomux(strandNamed(core, "sc-1235"), "resume", env, control);
    await pickUpInKomux(strandNamed(core, "sc-1235"), "fresh", env, control);
    expect(sent).toEqual([
      { method: "claude.start", params: { target: "/w/acme-libraries", layout: "pr-review", args: { pr: "540", strand: "sc-1235" }, resume: "r1" } },
      { method: "claude.start", params: { target: "/w/acme-libraries", layout: "pr-review", args: { pr: "540", strand: "sc-1235" }, prompt: brief(strandNamed(core, "sc-1235")) } },
    ]);
  });

  test("a PR review strand comes back as its PR review tab after komux restarts, even if its Claude was never prompted", async () => {
    const { core, hear, store } = harness();
    const review = { id: 3, number: 3, name: "acme-libraries #540", dir: "/w/acme-libraries", labels: { strand: "sc-1235" }, layout: "pr-review", args: { pr: "540", strand: "sc-1235" } };
    await hear({ ...snapshot, tabs: [...snapshot.tabs, review], agents: [], jobs: [] });
    const facts = store.all().length;
    await hear({ ...snapshot, tabs: [...snapshot.tabs, review], agents: [], jobs: [] });
    expect(store.all().length).toBe(facts);
    await hear({ server: "s2", type: "snapshot", tabs: snapshot.tabs, agents: [], jobs: [] });
    const { sent, control } = recorder();
    await goInKomux(strandNamed(core, "sc-1235"), [], { ...env, KOMUX_SERVER_ID: "s2" }, control);
    await pickUpInKomux(strandNamed(core, "sc-1235"), "fresh", { ...env, KOMUX_SERVER_ID: "s2" }, control);
    expect(sent).toEqual([
      { method: "project.open", params: { target: "/w/acme-libraries", layout: "pr-review", args: { pr: "540", strand: "sc-1235" } } },
      { method: "claude.start", params: { target: "/w/acme-libraries", layout: "pr-review", args: { pr: "540", strand: "sc-1235" }, prompt: brief(strandNamed(core, "sc-1235")) } },
    ]);
  });

  test("a strand with no place of its own goes to its nearest ancestor's tab", async () => {
    const { core, hear } = harness();
    const review = { id: 3, number: 3, name: "acme-libraries #540", dir: "/w/acme-libraries", labels: { strand: "sc-1235" }, layout: "pr-review", args: { pr: "540", strand: "sc-1235" } };
    await hear({ ...snapshot, tabs: [...snapshot.tabs, review], agents: [], jobs: [] });
    core.add(strandNamed(core, "sc-1235").id, "fixups › rename");
    const strands = core.snapshot().strands;
    const rename = strandNamed(core, "sc-1235 › fixups › rename");
    const { sent, control } = recorder();
    await goInKomux(rename, strands, env, control);
    await expect(goInKomux(rename, [], env, control)).rejects.toThrow("doesn't know where this strand lives");
    expect(sent).toEqual([{ method: "project.open", params: { target: "/w/acme-libraries", layout: "pr-review", args: { pr: "540", strand: "sc-1235" } } }]);
  });

  test("a story under an epic opens its own komux project rather than the epic's tab, the deepest strand with a project winning", async () => {
    const work = mkdtempSync(join(tmpdir(), "ponpoko-projects-"));
    for (const dir of ["stories/sc-900", "stories/sc-901", "repos/gadgets", "repos/merlin"]) mkdirSync(join(work, dir), { recursive: true });
    const projects = { ...env, PONPOKO_PROJECT_ROOTS: `${work}/stories/*:${work}/repos/*` };
    const { core, hear } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 4, number: 4, name: "epic", dir: join(work, "stories/sc-900"), labels: { strand: "sc-900" } }], agents: [{ paneId: 9, tabId: 4, state: "working", sessionId: "e1" }], jobs: [] });
    await hear({ type: "agent.state", agent: { paneId: 9, tabId: 4, state: "done", sessionId: "e1" } });
    core.add(strandNamed(core, "sc-900").id, "sc-901 › implement");
    core.add(strandNamed(core, "sc-900").id, "sc-901 › merlin");
    core.add(undefined, "gadgets");
    core.present({ adapter: "komux", scope: "main/s1", players: ["pane:s1:9"], spaces: [] });
    core.status({ self: "komux:s1:9", strand: "sc-901", text: "mapping the story" });
    core.status({ self: "komux:s1:9", strand: "sc-900", text: "back on the epic" });
    const strands = core.snapshot().strands;
    const story = strandNamed(core, "sc-900 › sc-901");
    const step = strandNamed(core, "sc-900 › sc-901 › implement");
    expect(goTarget(story, strands, projects)).toBeUndefined();
    expect(needsStoryDir(story, strands, projects)).toBe("sc-901");
    await loadProjects(projects);
    expect(goTarget(story, strands, projects)).toBeUndefined();
    expect(needsStoryDir(story, strands, projects)).toBeUndefined();
    const { sent, control } = recorder();
    await goInKomux(story, strands, projects, control);
    await goInKomux(step, strands, projects, control);
    await goInKomux(strandNamed(core, "sc-900 › sc-901 › merlin"), strands, projects, control);
    await goInKomux(strandNamed(core, "gadgets"), strands, projects, control);
    await expect(goInKomux(story, strands, { ...projects, PONPOKO_PROJECT_ROOTS: "" }, control)).rejects.toThrow("sc-901 has no story directory yet");
    expect(sent).toEqual([
      { method: "project.open", params: { target: join(work, "stories/sc-901") } },
      { method: "project.open", params: { target: join(work, "stories/sc-901") } },
      { method: "project.open", params: { target: join(work, "stories/sc-901") } },
      { method: "project.open", params: { target: join(work, "repos/gadgets") } },
    ]);
  });

  test("a story with its own project goes there, not to a Claude elsewhere that asked something of it, nor to the epic's directory", async () => {
    const work = mkdtempSync(join(tmpdir(), "ponpoko-projects-"));
    for (const dir of ["stories/sc-900", "stories/sc-901", "tools"]) mkdirSync(join(work, dir), { recursive: true });
    const projects = { ...env, PONPOKO_PROJECT_ROOTS: `${work}/stories/*` };
    const { core, hear } = harness();
    await hear({ type: "snapshot", tabs: [{ id: 4, number: 4, name: "epic", dir: join(work, "stories/sc-900"), labels: { strand: "sc-900" } }, { id: 6, number: 6, name: "tools", dir: join(work, "tools"), labels: { strand: "tools" } }], agents: [{ paneId: 9, tabId: 4, state: "waiting", sessionId: "e1" }, { paneId: 7, tabId: 6, state: "waiting", sessionId: "t1" }], jobs: [] });
    core.point(join(work, "stories/sc-900"), "sc-900");
    core.add(strandNamed(core, "sc-900").id, "sc-901 › merlin#1");
    core.wait({ self: "komux:s1:7", strand: "sc-900 › sc-901", who: "you", kind: "you", what: "in progress in Shortcut" });
    core.wait({ self: "komux:s1:9", strand: "sc-900 › sc-901 › merlin#1", who: "the team", kind: "person", what: "review" });
    core.wait({ self: "komux:s1:9", strand: "sc-900 › sc-902", who: "you", kind: "you", what: "look at the plan" });
    const strands = core.snapshot().strands;
    const story = strandNamed(core, "sc-900 › sc-901");
    const pr = strandNamed(core, "sc-900 › sc-901 › merlin#1");
    await loadProjects(projects);
    expect(goTarget(story, strands, projects)).toBeUndefined();
    expect(goTarget(pr, strands, projects)).toBeUndefined();
    expect(pickupOffer(pr, strands, projects)?.dir).toBe(join(work, "stories/sc-901"));
    const { sent, control } = recorder();
    await goInKomux(story, strands, projects, control);
    await goInKomux(pr, strands, projects, control);
    expect(sent).toEqual([
      { method: "project.open", params: { target: join(work, "stories/sc-901") } },
      { method: "project.open", params: { target: join(work, "stories/sc-901") } },
    ]);
    const homeless = strandNamed(core, "sc-900 › sc-902");
    expect(goTarget(homeless, strands, projects)).toBeUndefined();
    expect(pickupOffer(homeless, strands, projects)).toBeUndefined();
    expect(needsStoryDir(homeless, strands, projects)).toBe("sc-902");
    expect(needsStoryDir(story, strands, projects)).toBeUndefined();
    await expect(goInKomux(homeless, strands, projects, control)).rejects.toThrow("sc-902 has no story directory yet");
  });

  test("reads komux's project roots from its config without running it", () => {
    expect(readRoots(`import p from "./p.ts";\nexport default {\n  projects: {\n    roots: ["~/work/*/*", '~/work/ptyparty'],\n    layout: "ide",\n  },\n};`)).toEqual(["~/work/*/*", "~/work/ptyparty"]);
    expect(readRoots("export default { layouts: {} };")).toBeUndefined();
  });

  test("a strand no one is on goes to a Claude already in the tab it lives in, rather than offering a new one", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    core.add(strandNamed(core, "sc-1234").id, "fixups");
    const strands = core.snapshot().strands;
    const fixups = strandNamed(core, "sc-1234 › fixups");
    expect(goTarget(fixups, strands, env)?.player.id).toBe("pane:s1:2");
    expect(pickupOffer(fixups, strands, env)).toBeUndefined();
    expect(goTarget(fixups, strands, { ...env, KOMUX_SESSION: "other" })).toBeUndefined();
    const { sent, control } = recorder();
    await goInKomux(fixups, strands, env, control);
    expect(sent).toEqual([{ method: "tab.focus", params: { tabId: 1 } }]);
  });

  test("a strand whose own tab is open goes to that tab, even with no Claude in it", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    const strand = strandNamed(core, "sc-1234");
    const strands = core.snapshot().strands;
    expect(pickup(strand)?.resume?.session).toBe("c1");
    expect(pickupOffer(strand, strands, env)).toBeUndefined();
    expect(pickupOffer(strand, strands, { ...env, KOMUX_SERVER_ID: "s2" })?.resume?.session).toBe("c1");
    const { sent, control } = recorder();
    expect((await goInKomux(strand, strands, env, control)).how).toBe("focused");
    expect(sent).toEqual([{ method: "tab.focus", params: { tabId: 1 } }]);
  });

  test("picking up falls back to a new pane when the tab's docked Claude is busy or missing", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    const strand = strandNamed(core, "sc-1234");
    const sent: unknown[] = [];
    const control = async (request: unknown) => {
      sent.push(request);
      return (request as { method: string }).method === "claude.start" ? { ok: false, error: "busy: Claude is already running in that tab" } : { ok: true };
    };
    await pickUpInKomux(strand, "resume", { ...env, PONPOKO_CLAUDE: "komux claude --mode auto" }, control);
    expect(sent.at(-1)).toEqual({ method: "pane.open", params: { command: ["komux", "claude", "--mode", "auto", "--resume", "c1"], cwd: story, placement: "right", name: "claude" } });
    const old = async (request: unknown) => ((request as { method: string }).method === "claude.start" ? { ok: false, error: "Invalid input" } : { ok: true });
    await expect(pickUpInKomux(strand, "resume", env, old)).rejects.toThrow("it may need restarting");
  });
});

describe("GitHub polling", () => {
  test("polls again soon after something happens on a review, instead of waiting the full two minutes", async () => {
    const { core } = harness();
    let now = 1_000_000;
    let polls = 0;
    const pr = { repo: "acme/widgets", number: 1860, title: "Add a widget cache", url: "https://github.com/acme/widgets/pull/1860", author: "alice", assignees: ["octo"], requested: [], reviews: [], head: "c1" };
    const bridge = new Bridge(
      { knowledge: async () => core.knowledge(), record: async (facts, source = "komux") => core.record(source, facts), present: async () => undefined, absent: async () => undefined, importEpic: async () => undefined },
      async () => ({ ok: true }),
      () => now,
      async () => undefined,
      async () => (polls++, { me: "octo", reviews: [pr], mentioned: [] }),
    );
    core.onChange(() => bridge.changed());
    await bridge.pollInbox();
    expect(polls).toBe(1);
    now += 30_000;
    await bridge.pollInbox();
    expect(polls).toBe(1);
    const tab = { id: 4, number: 4, name: "widgets #1860", dir: "/w/acme/widgets", layout: "pr-review", args: { pr: "1860", strand: "reviews › widgets#1860" }, labels: { strand: "reviews › widgets#1860" } };
    await bridge.line(komuxLine.parse({ session: "main", server: "s1", type: "snapshot", tabs: [tab], agents: [{ paneId: 2, tabId: 4, state: "working" }], jobs: [] }));
    await bridge.line(komuxLine.parse({ session: "main", server: "s1", type: "agent.state", agent: { paneId: 2, tabId: 4, state: "done" } }));
    now += 10_000;
    await bridge.pollInbox();
    expect(polls).toBe(1);
    now += 6_000;
    await bridge.pollInbox();
    expect(polls).toBe(2);
    await bridge.line(komuxLine.parse({ session: "main", server: "s1", type: "tab.closed", tabId: 4 }));
    now += 16_000;
    await bridge.pollInbox();
    expect(polls).toBe(3);
  });
});
