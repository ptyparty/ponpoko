import { describe, expect, test } from "bun:test";
import type { Actions } from "./actions.ts";
import { Ponpoko } from "./core.ts";
import { Dealer } from "./deal.ts";
import { komuxLine } from "./komux.ts";
import { Store } from "./store.ts";

function setup(unseen = false) {
  let now = 1_000_000;
  const core = new Ponpoko(new Store(":memory:"), async () => ({ ok: true }), async () => undefined, () => now);
  const hear = (line: Record<string, unknown>) => core.heardKomux(komuxLine.parse({ session: "main", server: "s1", ...line }));
  hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-1" }, { id: 2, number: 2, name: "side", dir: "/w/side" }], agents: [], jobs: [] });
  hear({ type: "agent.state", agent: { paneId: 3, tabId: 1, state: "done" } });
  now += 60_000;
  hear({ type: "agent.state", agent: { paneId: 4, tabId: 2, state: "waiting" } });
  now += 60_000;
  const calls: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => void calls.push([name, ...args]);
  const actions = { go: record("go"), forget: record("forget"), snooze: record("snooze"), note: record("note"), point: record("point"), seen: record("seen") } as Actions;
  const dealer = new Dealer(actions, unseen, () => now);
  dealer.setSnapshot(core.snapshot());
  return { dealer, calls };
}

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).join("\n");

describe("the deck", () => {
  test("deals the oldest move first, says where Enter goes, and closes after going", async () => {
    const { dealer, calls } = setup();
    const card = plain(dealer.view());
    expect(card).toContain("your move · 1 of 2");
    expect(card).toContain("● SC-1");
    expect(card).toContain("agent pane 3 · turn ended · 2m");
    expect(card).toContain("→ tab 1 widgets");
    expect(await dealer.key({ name: "return" })).toBe("close");
    expect(calls).toEqual([["go", "pane:s1:3"]]);
  });

  test("skip puts the card at the back", async () => {
    const { dealer } = setup();
    await dealer.key({ name: "s" });
    expect(dealer.card()?.id).toBe("pane:s1:4");
    await dealer.key({ name: "s" });
    expect(dealer.card()?.id).toBe("pane:s1:3");
  });

  test("catching up marks a braid seen once every new card in it was dealt", async () => {
    const { dealer, calls } = setup(true);
    expect(plain(dealer.view())).toContain("since you last caught up · 1 of 2");
    await dealer.key({ name: "s" });
    expect(await dealer.key({ name: "escape" })).toBe("close");
    expect(calls).toEqual([["seen", "sc-1"]]);
  });

  test("an empty hand says so", () => {
    const dealer = new Dealer({} as Actions, false);
    dealer.setSnapshot({ now: 0, counts: { yours: 0, agents: 0, snoozed: 0, waiting: 0 }, braids: [], moves: [], unseen: [], heard: [], labels: {} });
    expect(plain(dealer.view())).toContain("✓ clear");
  });
});
