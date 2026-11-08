import { describe, expect, test } from "bun:test";
import { tourRef } from "./core.ts";
import type { Link } from "./model.ts";
import { showTour, type Run } from "./remax.ts";

const link: Link = { id: "l1", strand: "s1", adapter: "remax", ref: tourRef({ repo: "/w/sc-1/gadgets", name: "caching toggle" }), label: "caching toggle", at: 1 };

function runner(answers: { code: number; out?: string; err?: string }[]) {
  const calls: { command: string[]; tabDir?: string }[] = [];
  const run: Run = async (command, env) => {
    calls.push({ command, tabDir: env.KOMUX_TAB_DIR });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return { code: answer.code, out: answer.out ?? "", err: answer.err ?? "" };
  };
  return { calls, run };
}

describe("showing a tour", () => {
  test("asks the remax in the tab go landed in, waiting while it starts", async () => {
    const { calls, run } = runner([{ code: 1, err: "No remax is open on this checkout here." }, { code: 0, out: "tour step 1\n" }]);
    expect(await showTour(link, "/run/komux/sessions/main/tabs/3", run, 8000, async () => {})).toBe("tour step 1");
    expect(calls).toEqual([
      { command: ["remax", "-C", "/w/sc-1/gadgets", "do", ":tour show caching toggle"], tabDir: "/run/komux/sessions/main/tabs/3" },
      { command: ["remax", "-C", "/w/sc-1/gadgets", "do", ":tour show caching toggle"], tabDir: "/run/komux/sessions/main/tabs/3" },
    ]);
  });

  test("gives up when no remax starts in the tab, and passes other refusals straight on", async () => {
    const nobody = runner([{ code: 1, err: "No remax is open on this checkout here." }]);
    await expect(showTour(link, "/tabs/3", nobody.run, 800, async () => {})).rejects.toThrow("No remax is open in that tab");
    expect(nobody.calls.length).toBe(3);
    const refused = runner([{ code: 1, err: "that command is the reviewer's" }]);
    await expect(showTour(link, "/tabs/3", refused.run, 800, async () => {})).rejects.toThrow("remax: that command is the reviewer's");
    await expect(showTour(link, undefined, refused.run)).rejects.toThrow("restart komux");
  });
});
