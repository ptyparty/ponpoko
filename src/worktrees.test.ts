import { describe, expect, test } from "bun:test";
import { Ponpoko } from "./core.ts";
import { Store } from "./store.ts";
import { checkouts } from "./worktrees.ts";

describe("branches checked out under a strand", () => {
  test("maps each branch to the strand whose directory holds its worktree, leaving out branches two strands have", async () => {
    const core = new Ponpoko(new Store(":memory:"));
    const story = core.add(undefined, "sc-1");
    const other = core.add(undefined, "sc-2");
    core.point("/w/stories/sc-1", "sc-1");
    core.point("/w/stories/sc-2", "sc-2");
    const repos: Record<string, string[]> = { "/w/stories/sc-1": ["/w/stories/sc-1/widgets", "/w/stories/sc-1/gadgets"], "/w/stories/sc-2": ["/w/stories/sc-2/widgets"] };
    const branches: Record<string, string> = { "/w/stories/sc-1/widgets": "sc-1/import", "/w/stories/sc-1/gadgets": "main", "/w/stories/sc-2/widgets": "main" };
    const found = await checkouts(core.knowledge(), async (dir) => branches[dir], (dir) => repos[dir] ?? []);
    expect([...found]).toEqual([["sc-1/import", story]]);
    expect(core.knowledge().strands.map((strand) => strand.id)).toContain(other);
  });
});
