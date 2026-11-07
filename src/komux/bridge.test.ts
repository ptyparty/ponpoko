import { describe, expect, test } from "bun:test";
import { rows } from "../render.ts";
import { harness } from "../test-harness.ts";
import { goInKomux } from "./go.ts";

const story = "/home/me/work/stories/sc-1234/widgets";
const side = "/home/me/work/ptyparty";

const snapshot = {
  type: "snapshot",
  tabs: [
    { id: 1, number: 1, name: "widgets", dir: story },
    { id: 2, number: 2, name: "ptyparty", dir: side },
  ],
  agents: [
    { paneId: 2, tabId: 1, state: "working", sessionId: "c1" },
    { paneId: 5, tabId: 2, state: "done" },
  ],
  jobs: [{ id: 7, tabId: 1, name: "build", state: "failed", code: 1, agent: false }],
  toasts: [],
};

describe("the komux bridge", () => {
  test("a snapshot makes braids and strands with whose move each is, all live", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await Bun.sleep(0);
    const view = core.snapshot();
    expect(view.braids.map((braid) => [braid.name, braid.title, braid.spaces.map((space) => space.short)])).toEqual([
      ["ptyparty", undefined, ["tab 2"]],
      ["SC-1234", "Widget CSV import", ["tab 1"]],
    ]);
    expect(view.moves.map((strand) => [strand.label, strand.why, strand.live, strand.space])).toEqual([
      ["agent pane 5", "turn ended", true, "tab 2 ptyparty"],
      ["job build", "failed (exit 1)", true, "tab 1 widgets"],
    ]);
    expect(core.model.strands.get("pane:s1:2")!.place).toMatchObject({ adapter: "komux", handle: "komux:s1:2", session: "main", paneId: 2 });
  });

  test("the move follows the agent's turns, and the clock restarts when it changes hands", async () => {
    const { core, hear, tick } = harness();
    await hear(snapshot);
    tick(60_000);
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "waiting", sessionId: "c1" } });
    expect(core.model.strands.get("pane:s1:2")).toMatchObject({ whose: "you", why: "waiting on you", since: 1_060_000 });
    await hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "idle", sessionId: "c1" } });
    expect(core.model.strands.get("pane:s1:2")!.whose).toBe("nobody");
    await hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    expect(core.model.strands.has("pane:s1:2")).toBe(false);
  });

  test("a failed job stays yours through a dismissed toast, until it passes", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await hear({ type: "toast.dismissed", toast: { kind: "job", id: 7, tabId: 1 } });
    expect(core.model.strands.get("job:s1:7")).toMatchObject({ whose: "you", dismissed: true });
    await hear({ type: "job.finished", job: { id: 7, tabId: 1, name: "build", state: "succeeded", code: 0 } });
    expect(core.model.strands.has("job:s1:7")).toBe(false);
  });

  test("strands outlive komux, and a new komux ends only its own missing panes", async () => {
    const { core, hear, bridge } = harness();
    await hear(snapshot);
    await bridge.leave();
    expect(core.snapshot().moves.map((strand) => strand.live)).toEqual([false, false]);
    await hear({ server: "s2", type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: story }], agents: [{ paneId: 3, tabId: 1, state: "working", sessionId: "c1" }], jobs: [] });
    expect([...core.model.strands.keys()].sort()).toEqual(["job:s1:7", "pane:s1:5", "pane:s2:3"]);
  });

  test("reconnecting or replaying a snapshot records nothing new, and keeps an agent's report", async () => {
    const { core, hear, store } = harness();
    await hear(snapshot);
    core.report({ self: "komux:s1:5", whose: "person", who: "Sam", reason: "asked Sam" });
    const facts = store.all().length;
    await hear(snapshot);
    expect(store.all().length).toBe(facts);
    expect(core.model.strands.get("pane:s1:5")).toMatchObject({ whose: "person", who: "Sam" });
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
    expect(core.model.strands.has("pane:s1:9")).toBe(false);
    await bridge.heartbeat();
    expect(core.model.strands.get("pane:s1:9")).toMatchObject({ whose: "you", why: "waiting on you" });
    expect(core.model.strands.has("pane:s1:2")).toBe(false);
  });

  test("a bridge leaving an old komux doesn't take away the new one's presence", async () => {
    const { core, hear, bridge } = harness();
    await hear(snapshot);
    const second = harness(1_000_000, undefined, core);
    await second.hear({ server: "s2", type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: story }], agents: [{ paneId: 3, tabId: 1, state: "done" }], jobs: [] });
    await bridge.leave();
    expect(core.snapshot().moves.find((strand) => strand.id === "pane:s2:3")!.live).toBe(true);
  });

  test("badges each live tab with whose move its braid holds, sending only changes", async () => {
    const { core, hear, sent } = harness();
    await hear(snapshot);
    expect(sent).toEqual([
      { method: "tab.badge", params: { tabId: 1, owner: "ponpoko", text: "●", color: "warning" } },
      { method: "tab.badge", params: { tabId: 2, owner: "ponpoko", text: "●", color: "warning" } },
    ]);
    sent.length = 0;
    core.report({ dir: story, strand: "PR #1 review", whose: "machine", who: "Copilot", reason: "review" });
    core.forget("job:s1:7");
    await hear({ type: "toast.shown", toast: { kind: "job", id: 7, tabId: 1 } });
    expect(sent).toEqual([{ method: "tab.badge", params: { tabId: 1, owner: "ponpoko", text: "⊘", color: "muted" } }]);
  });

  test("names ended strands in the heard list", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    core.end("job:s1:7", "you went to it");
    expect(rows(core.snapshot(), 100).map((row) => row.text).join("\n")).toContain("SC-1234 job build ended: you went to it");
  });
});

describe("go in komux", () => {
  const env = { KOMUX_SOCKET: "/run/main.control.sock", KOMUX_SESSION: "main", KOMUX_SERVER_ID: "s1" };

  test("focuses a live pane in this session, and opens a tab here for anything else", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    const sent: unknown[] = [];
    const control = async (request: unknown) => (sent.push(request), { ok: true });
    const strand = (id: string) => core.snapshot().braids.flatMap((braid) => braid.strands).find((candidate) => candidate.id === id)!;
    expect(await goInKomux(strand("pane:s1:5"), side, env, control)).toBe("focused");
    expect(await goInKomux(strand("pane:s1:5"), side, { ...env, KOMUX_SESSION: "other", KOMUX_SERVER_ID: "s9" }, control)).toBe("opened");
    expect(sent).toEqual([
      { method: "pane.focus", params: { paneId: 5 } },
      { method: "project.open", params: { target: side } },
    ]);
  });

  test("needs komux", async () => {
    const { core, hear } = harness();
    await hear(snapshot);
    await expect(goInKomux(core.snapshot().moves[0]!, side, {})).rejects.toThrow("go works from inside komux");
  });
});
