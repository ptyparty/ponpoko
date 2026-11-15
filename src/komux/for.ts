import { ask } from "../client.ts";
import type { Request } from "../server.ts";
import { jobPlayerId } from "./translate.ts";

export type Claim = { strand: string; command: string[] };

export function readFor(args: string[], env: Record<string, string | undefined>): Claim | string {
  const split = args.indexOf("--");
  const before = split >= 0 ? args.slice(0, split) : args.slice(0, 1);
  const command = split >= 0 ? args.slice(split + 1) : args.slice(1);
  const strand = before.join(" ").trim() || env.PONPOKO_STRAND?.trim() || "";
  if (strand === "") return "name the strand the job is for, or set PONPOKO_STRAND";
  return { strand, command };
}

export function forRequest(strand: string, env: Record<string, string | undefined>, cwd: string): Extract<Request, { method: "for" }> | undefined {
  const job = Number(env.KOMUX_JOB);
  if (!env.KOMUX_SERVER_ID || !env.KOMUX_JOB || !Number.isInteger(job)) return undefined;
  return { method: "for", params: { strand, player: jobPlayerId(env.KOMUX_SERVER_ID, job), dir: cwd } };
}

export async function runFor(args: string[], env = process.env, send: (request: Request) => Promise<unknown> = ask): Promise<number> {
  const claim = readFor(args, env);
  if (typeof claim === "string") {
    console.error(`ponpoko for: ${claim}\nUsage: ponpoko for STRAND -- COMMAND...`);
    return 2;
  }
  const request = forRequest(claim.strand, env, process.cwd());
  if (!request) console.error("ponpoko for: not running as a komux job, so the strand isn't told");
  else await send(request).catch((error: Error) => console.error(`ponpoko for: ${error.message}`));
  if (claim.command.length === 0) return 0;
  const child = Bun.spawn(claim.command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  return await child.exited;
}
