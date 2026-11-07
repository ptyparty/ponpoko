import { describe, expect, test } from "bun:test";
import type { Actions } from "./actions.ts";
import { Dealer } from "./deal.ts";
import { harness, recordingActions, strandNamed } from "./test-harness.ts";

async function setup(unseen = false) {
  const { core, hear, tick, now } = harness();
  await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-1", labels: { braid: "sc-1" } }, { id: 2, number: 2, name: "side", dir: "/w/side" }], agents: [], jobs: [] });
  await hear({ type: "agent.state", agent: { paneId: 3, tabId: 1, state: "done" } });
  tick(60_000);
  await hear({ type: "agent.state", agent: { paneId: 4, tabId: 2, state: "waiting" } });
  tick(60_000);
  const { actions, calls } = recordingActions();
  const dealer = new Dealer(actions, unseen, now);
  dealer.setSnapshot(core.snapshot());
  return { core, dealer, calls };
}

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).join("\n");

describe("the deck", () => {
  test("deals the oldest strand first with its whole path, says where Enter goes, and closes after going", async () => {
    const { core, dealer, calls } = await setup();
    const card = plain(dealer.view());
    expect(card).toContain("your move · 1 of 2");
    expect(card).toContain("● sc-1");
    expect(card).toContain("claude · turn ended · 2m");
    expect(card).toContain("→ tab 1 widgets");
    expect(await dealer.key({ name: "return" })).toBe("close");
    expect(calls).toEqual([["go", strandNamed(core, "sc-1").id]]);
  });

  test("skip puts the card at the back, and d marks it done", async () => {
    const { core, dealer, calls } = await setup();
    await dealer.key({ name: "s" });
    expect(dealer.card()?.name).toBe("claude in side");
    await dealer.key({ name: "s" });
    expect(dealer.card()?.name).toBe("sc-1");
    await dealer.key({ name: "d" });
    expect(calls).toEqual([["done", strandNamed(core, "sc-1").id]]);
  });

  test("catching up marks each dealt strand seen", async () => {
    const { core, dealer, calls } = await setup(true);
    expect(plain(dealer.view())).toContain("since you last caught up · 1 of 2");
    await dealer.key({ name: "s" });
    expect(await dealer.key({ name: "escape" })).toBe("close");
    expect(calls).toEqual([["seen", strandNamed(core, "sc-1").id]]);
  });

  test("an empty hand says so", () => {
    const dealer = new Dealer({} as Actions, false);
    dealer.setSnapshot({ now: 0, counts: { yours: 0, agents: 0, snoozed: 0, waiting: 0 }, strands: [], moves: [], unseen: [], heard: [], labels: {} });
    expect(plain(dealer.view())).toContain("✓ clear");
  });
});
