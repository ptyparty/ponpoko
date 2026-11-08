import { readTourRef, type StrandView } from "./core.ts";
import type { Link } from "./model.ts";

export type Run = (command: string[], env: Record<string, string | undefined>) => Promise<{ code: number; out: string; err: string }>;

export function strandTour(strand: StrandView): Link | undefined {
  return strand.links
    .filter((link) => link.adapter === "remax")
    .sort((a, b) => a.at - b.at)
    .at(-1);
}

export async function showTour(link: Link, tabDir: string | undefined, run: Run = runCommand, waitMs = 8000, sleep = Bun.sleep): Promise<string> {
  const tour = readTourRef(link.ref);
  if (!tour) throw new Error("ponpoko can't read this tour link");
  if (!tabDir) throw new Error("komux didn't say which tab it went to; restart komux to open tours from ponpoko");
  const command = ["remax", "-C", tour.repo, "do", `:tour show ${tour.name}`];
  const env = { ...process.env, KOMUX_TAB_DIR: tabDir };
  for (let waited = 0; ; waited += 400) {
    const done = await run(command, env);
    if (done.code === 0) return done.out.trim();
    const why = done.err.trim() || done.out.trim();
    if (!why.startsWith("No remax is open")) throw new Error(`remax: ${why}`);
    if (waited >= waitMs) throw new Error("No remax is open in that tab to show the tour; start remax there, then pick the tour with :tours");
    await sleep(400);
  }
}

async function runCommand(command: string[], env: Record<string, string | undefined>): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}
