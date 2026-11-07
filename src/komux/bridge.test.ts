import { describe, expect, test } from "bun:test";
import { harness, strandNamed } from "../test-harness.ts";
import { brief, goInKomux, pickup, pickUpInKomux } from "./go.ts";

const story = "/home/me/work/stories/sc-1234/widgets";
const side = "/home/me/work/ptyparty";

const snapshot = {
  type: "snapshot",
  tabs: [
    { id: 1, number: 1, name: "widgets", dir: story, labels: { braid: "sc-1234" } },
    { id: 2, number: 2, name: "ptyparty", dir: side },
  ],
  agents: [
    { paneId: 2, tabId: 1, state: "working", sessionId: "c1" },
    { paneId: 5, tabId: 2, state: "done" },
    { paneId: 6, tabId: 2, state: "idle" },
  ],
  jobs: [{ id: 7, tabId: 1, name: "build", state: "failed", code: 1, agent: false }],
  toasts: [],
};

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
  test("agents' turns become moves on their tab's strand, or on a loose strand of their own; a Claude never prompted shows nowhere", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await Bun.sleep(0);
    expect(shown(core)).toBe(
      [
        "claude in ptyparty you you(pane:s1:5): turn ended",
        "sc-1234 you pane:s1:2: working; you(job:s1:7): build failed (exit 1)",
      ].join("\n"),
    );
    expect(strandNamed(core, "sc-1234")).toMatchObject({ title: "Widget CSV import", kind: "story" });
    expect(strandNamed(core, "claude in ptyparty").kind).toBe("loose");
    expect(core.model.players.has("pane:s1:6")).toBe(false);
    const agent = strandNamed(core, "sc-1234").open.find((move) => move.player === "pane:s1:2")!.by;
    expect([agent.live, agent.space, agent.place]).toEqual([true, "tab 1 widgets", { adapter: "komux", handle: "komux:s1:2", session: "main", server: "s1", tabId: 1, paneId: 2, dir: story, sessionId: "c1" }]);
  });

  test("the move follows the agent's turns: yours when a turn ends, the agent's when you prompt it", async () => {
    const { core, hear, tick } = harness();
    await hear(snapshot);
    tick(60_000);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "waiting", sessionId: "c1" } });
    await hear({ type: "job.finished", job: { id: 7, tabId: 1, name: "build", state: "succeeded", code: 0 } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(pane:s1:2): waiting on you");
    expect(strandNamed(core, "sc-1234").own.since).toBe(1_060_000);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "idle", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(pane:s1:2): waiting on you");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: working");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "idle", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(pane:s1:2): ready for a prompt");
    expect(strandNamed(core, "sc-1234").recent.map((move) => `${move.player === "you" ? "you" : "agent"} ${move.what}`)).toEqual([
      "agent working",
      "you build failed (exit 1)",
      "you waiting on you",
      "agent working",
      "you ready for a prompt",
    ]);
  });

  test("a question open in komux is your move, and answering it hands the move back", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1", asking: true } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you you(job:s1:7): build failed (exit 1); you(pane:s1:2): asking you");
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "working", sessionId: "c1" } });
    expect(line(core, "sc-1234")).toBe("sc-1234 you pane:s1:2: working; you(job:s1:7): build failed (exit 1)");
  });

  test("closing a pane takes its agent off the strand; a rogue that never said what it was doing leaves nothing", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await hear({ type: "agent.gone", paneId: 5, tabId: 2 });
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    await hear({ type: "job.closed", jobId: 7, tabId: 1 });
    expect(shown(core)).toBe("sc-1234 you");
    expect(strandNamed(core, "sc-1234").own.why).toBe("no one on it");
    expect(core.model.players.get("pane:s1:2")!.gone).toBeDefined();
  });

  test("a rogue that said what it was doing leaves its loose strand behind", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await hear({ type: "agent.state", agent: { paneId: 5, tabId: 2, state: "working" } });
    core.present({ adapter: "komux", scope: "main/s1", players: ["pane:s1:5"], spaces: [] });
    core.status({ self: "komux:s1:5", text: "sketching an idea" });
    await hear({ type: "agent.gone", paneId: 5, tabId: 2 });
    expect(line(core, "claude in ptyparty")).toBe("claude in ptyparty you");
  });

  test("a new komux in the same session takes the old one's agents off their strands, but keeps their loose strands", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await hear({ server: "s2", type: "snapshot", tabs: snapshot.tabs, agents: [{ paneId: 3, tabId: 1, state: "working", sessionId: "c1" }], jobs: [] });
    expect(shown(core)).toBe(["claude in ptyparty you", "sc-1234 agent pane:s2:3: working"].join("\n"));
    expect(core.model.players.get("pane:s1:5")!.gone).toBeDefined();
  });

  test("reconnecting or replaying a snapshot records nothing new", async () => {
    const { hear, store } = harness();
    await hear(snapshot);
    const facts = store.all().length;
    await hear(snapshot);
    expect(store.all().length).toBe(facts);
  });

  test("a failed job stays yours through a dismissed toast, until it passes", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await hear({ type: "toast.dismissed", toast: { kind: "job", id: 7, tabId: 1 } });
    expect(strandNamed(core, "sc-1234").dismissedAt).toBe(1_000_000);
    await hear({ type: "job.finished", job: { id: 7, tabId: 1, name: "build", state: "succeeded", code: 0 } });
    expect(line(core, "sc-1234")).toBe("sc-1234 agent pane:s1:2: working");
  });

  test("focusing an agent whose turn ended marks its strand seen", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    expect(strandNamed(core, "claude in ptyparty").unseen).toBe(true);
    await hear({ type: "focus", tabId: 2, paneId: 5 });
    expect(strandNamed(core, "claude in ptyparty").unseen).toBe(false);
  });

  test("pointing a directory takes in its rogue, and the agent's next turns land there", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    core.point(side, "ptyparty");
    expect(line(core, "ptyparty")).toBe("ptyparty you you(pane:s1:5): turn ended");
    await hear({ type: "agent.state", agent: { paneId: 5, tabId: 2, state: "working" } });
    expect(line(core, "ptyparty")).toBe("ptyparty agent pane:s1:5: working");
  });

  test("lines heard while the service is down are caught up once it's back", async () => {
    const { core, hear, bridge, service } = harness();
    await hear(snapshot);
    service.down = true;
    await hear({ type: "tab.opened", tab: { id: 3, number: 3, name: "new", dir: side } });
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
    await second.hear({ server: "s2", type: "snapshot", tabs: snapshot.tabs, agents: [{ paneId: 3, tabId: 1, state: "done" }], jobs: [] });
    await bridge.leave();
    expect(strandNamed(core, "sc-1234").open.find((move) => move.answers?.id === "pane:s2:3")!.answers!.live).toBe(true);
  });

  test("badges each tab with whose move its strands hold, sending only changes", async () => {
    const { core, hear, sent } = harness();
    await hear(snapshot);
    expect(sent).toEqual([
      { method: "tab.badge", params: { tabId: 1, owner: "ponpoko", text: "●", color: "warning" } },
      { method: "tab.badge", params: { tabId: 2, owner: "ponpoko", text: "●", color: "warning" } },
    ]);
    sent.length = 0;
    await hear({ type: "job.closed", jobId: 7, tabId: 1 });
    core.wait({ dir: story, strand: "sc-1234", who: "Copilot", kind: "machine", what: "review" });
    await hear({ type: "toast.shown", toast: { kind: "job", id: 7, tabId: 1 } });
    expect(sent).toEqual([{ method: "tab.badge", params: { tabId: 1, owner: "ponpoko", text: null } }]);
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    expect(sent.at(-1)).toEqual({ method: "tab.badge", params: { tabId: 1, owner: "ponpoko", text: "⊘", color: "muted" } });
  });
});

describe("go in komux", () => {
  const env = { KOMUX_SOCKET: "/run/main.control.sock", KOMUX_SESSION: "main", KOMUX_SERVER_ID: "s1" };
  const recorder = () => {
    const sent: unknown[] = [];
    return { sent, control: async (request: unknown) => (sent.push(request), { ok: true }) };
  };

  test("focuses the pane a strand waits on in this session, and opens a tab here for anything else", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    const { sent, control } = recorder();
    expect(await goInKomux(strandNamed(core, "claude in ptyparty"), env, control)).toBe("focused");
    expect(await goInKomux(strandNamed(core, "claude in ptyparty"), { ...env, KOMUX_SESSION: "other", KOMUX_SERVER_ID: "s9" }, control)).toBe("opened");
    expect(sent).toEqual([
      { method: "pane.focus", params: { paneId: 5 } },
      { method: "project.open", params: { target: side } },
    ]);
  });

  test("goes to a working agent's tab without showing the agent, but shows one asking you", async () => {
    const { core, hear } = harness();
    await hear({ ...snapshot, jobs: [] });
    const { sent, control } = recorder();
    await goInKomux(strandNamed(core, "sc-1234"), env, control);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "waiting", sessionId: "c1" } });
    await goInKomux(strandNamed(core, "sc-1234"), env, control);
    expect(sent).toEqual([
      { method: "tab.focus", params: { tabId: 1 } },
      { method: "pane.focus", params: { paneId: 2 } },
    ]);
  });

  test("needs komux", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await expect(goInKomux(strandNamed(core, "sc-1234"), {})).rejects.toThrow("go works from inside komux");
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
    expect(brief(strand)).toContain("- claude: fixing the importer (quoll sc-1234/plan.md)");
    const { sent, control } = recorder();
    await pickUpInKomux(strand, "resume", { ...env, PONPOKO_CLAUDE: "komux claude --mode auto" }, control);
    await pickUpInKomux(strand, "fresh", env, control);
    expect(sent).toEqual([
      { method: "project.open", params: { target: story } },
      { method: "pane.open", params: { command: ["komux", "claude", "--mode", "auto", "--resume", "c1"], cwd: story, placement: "right", name: "claude" } },
      { method: "project.open", params: { target: story } },
      { method: "pane.open", params: { command: ["komux", "claude", "--prompt", brief(strand)], cwd: story, placement: "right", name: "claude" } },
    ]);
  });
});
