import { describe, expect, test } from "bun:test";
import { braidForDir } from "./braids.ts";
import { Ponpoko } from "./core.ts";
import { komuxLine, type KomuxLine } from "./komux.ts";
import { rows } from "./render.ts";
import { Store } from "./store.ts";

const story = "/home/me/work/stories/sc-1234/widgets";
const side = "/home/me/work/ptyparty";

function setup(start = 1_000_000) {
  let now = start;
  const sent: { session: string; request: unknown }[] = [];
  const store = new Store(":memory:");
  const core = new Ponpoko(
    store,
    async (session, request) => {
      sent.push({ session, request });
      return { ok: true };
    },
    async () => ({ kind: "story", title: "Widget CSV import" }),
    () => now,
  );
  const hear = (line: Record<string, unknown>) => core.heardKomux(komuxLine.parse({ session: "main", server: "s1", ...line }) as KomuxLine);
  return { core, store, sent, hear, tick: (ms: number) => (now += ms) };
}

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

describe("braidForDir", () => {
  test("maps story directories to their story, and anything else to side work", () => {
    expect(braidForDir(story, new Map())).toEqual({ id: "sc-1234", name: "SC-1234" });
    expect(braidForDir(side, new Map())).toEqual({ id: `side:${side}`, name: "ptyparty", kind: "side" });
    expect(braidForDir(`${side}/komux`, new Map([[side, "sc-1"]]))).toEqual({ id: "sc-1", name: "sc-1" });
  });
});

describe("ponpoko", () => {
  test("a snapshot makes braids and strands with whose move each is", async () => {
    const { core, hear } = setup();
    hear(snapshot);
    await Bun.sleep(0);
    const view = core.snapshot();
    expect(view.braids.map((braid) => [braid.name, braid.title])).toEqual([
      ["ptyparty", undefined],
      ["SC-1234", "Widget CSV import"],
    ]);
    expect(view.moves.map((strand) => [strand.label, strand.whose, strand.why])).toEqual([
      ["agent pane 5", "you", "turn ended"],
      ["job build", "you", "failed (exit 1)"],
    ]);
    expect(view.counts).toMatchObject({ yours: 2, agents: 1 });
  });

  test("the move follows the agent's turns, and the clock restarts when it changes hands", () => {
    const { core, hear, tick } = setup();
    hear(snapshot);
    tick(60_000);
    hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "waiting", sessionId: "c1" } });
    const strand = core.model.strands.get("pane:s1:2")!;
    expect([strand.whose, strand.why, strand.since]).toEqual(["you", "waiting on you", 1_060_000]);
    tick(1000);
    hear({ type: "agent.state", agent: { paneId: 2, tabId: 1, state: "idle", sessionId: "c1" } });
    expect(core.model.strands.get("pane:s1:2")!.whose).toBe("nobody");
    hear({ type: "agent.gone", paneId: 2, tabId: 1 });
    expect(core.model.strands.has("pane:s1:2")).toBe(false);
  });

  test("a failed job stays yours until it passes", () => {
    const { core, hear } = setup();
    hear(snapshot);
    hear({ type: "toast.dismissed", toast: { kind: "job", id: 7, tabId: 1 } });
    expect(core.model.strands.get("job:s1:7")).toMatchObject({ whose: "you", dismissed: true });
    hear({ type: "job.finished", job: { id: 7, tabId: 1, name: "build", state: "succeeded", code: 0 } });
    expect(core.model.strands.has("job:s1:7")).toBe(false);
  });

  test("strands outlive komux, and a new komux closes only its own missing panes", () => {
    const { core, hear } = setup();
    hear(snapshot);
    core.komuxGone("s1");
    expect(core.snapshot().moves.map((strand) => [strand.label, strand.live])).toEqual([
      ["agent pane 5", false],
      ["job build", false],
    ]);
    hear({ server: "s2", type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: story }], agents: [{ paneId: 3, tabId: 1, state: "working", sessionId: "c1" }], jobs: [] });
    expect([...core.model.strands.keys()].sort()).toEqual(["job:s1:7", "pane:s1:5", "pane:s2:3"]);
  });

  test("a restarted ponpoko keeps what it knew", () => {
    const { store, hear } = setup();
    hear(snapshot);
    const again = new Ponpoko(store, async () => ({ ok: true }), async () => undefined);
    expect([...again.model.strands.keys()].sort()).toEqual(["job:s1:7", "pane:s1:2", "pane:s1:5"]);
  });

  test("agents report what komux can't see", () => {
    const { core, hear } = setup();
    hear(snapshot);
    const id = core.report({ session: "main", paneId: 2, strand: "PR #821 review", whose: "machine", who: "Copilot", reason: "waiting on Copilot review of PR #821" });
    expect(core.model.strands.get(id)).toMatchObject({ braid: "sc-1234", kind: "report", whose: "machine", who: "Copilot" });
    core.report({ session: "main", paneId: 2, whose: "person", who: "Sam", reason: "asked Sam about the CSV columns" });
    expect(core.model.strands.get("pane:s1:2")).toMatchObject({ whose: "person", who: "Sam", source: "agent" });
    core.report({ braid: "SC-1234", strand: "PR #821 review", whose: "done", reason: "review in" });
    expect(core.model.strands.has(id)).toBe(false);
    expect(() => core.report({ dir: side, whose: "you", reason: "x" })).toThrow(/name the strand/);
  });

  test("go focuses a live pane, and reopens the tab of one that's gone", async () => {
    const { core, hear, sent } = setup();
    hear(snapshot);
    await core.go("pane:s1:5");
    expect(core.model.strands.get("pane:s1:5")!.seen).toBe(true);
    core.komuxGone("s1");
    hear({ server: "s2", type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: story }], agents: [], jobs: [] });
    await core.go("job:s1:7");
    expect(sent).toEqual([
      { session: "main", request: { method: "pane.focus", params: { paneId: 5 } } },
      { session: "main", request: { method: "project.open", params: { target: story } } },
    ]);
    expect(core.model.strands.has("job:s1:7")).toBe(false);
    expect(rows(core.snapshot(), 100).map((row) => row.text).join("\n")).toContain("SC-1234 job build ended: you went to it");
  });

  test("snoozed moves leave the deal until they wake", () => {
    const { core, hear, tick } = setup();
    hear(snapshot);
    core.snooze("job:s1:7", 1_000_000 + 30 * 60_000);
    expect(core.snapshot().moves.map((strand) => strand.id)).toEqual(["pane:s1:5"]);
    tick(31 * 60_000);
    expect(core.snapshot().moves.map((strand) => strand.id)).toEqual(["pane:s1:5", "job:s1:7"]);
  });
});

describe("tab glyphs", () => {
  test("each live tab shows whose move its braid holds, and only changes are sent", async () => {
    const { core, hear, sent } = setup();
    hear(snapshot);
    await core.syncBadges();
    expect(sent.map((entry) => entry.request)).toEqual([
      { method: "tab.badge", params: { tabId: 1, owner: "ponpoko", text: "●", color: "warning" } },
      { method: "tab.badge", params: { tabId: 2, owner: "ponpoko", text: "●", color: "warning" } },
    ]);
    sent.length = 0;
    core.report({ dir: story, strand: "PR #1 review", whose: "machine", who: "Copilot", reason: "review" });
    core.forget("job:s1:7");
    await core.syncBadges();
    expect(sent.map((entry) => entry.request)).toEqual([{ method: "tab.badge", params: { tabId: 1, owner: "ponpoko", text: "⊘", color: "muted" } }]);
  });
});
