import { ask } from "../client.ts";
import type { Request } from "../server.ts";
import { jobPlayerId } from "./translate.ts";

export type Claim = { strand: string; command: string[] };

export function readFor(args: string[], env: Record<string, string | undefined>): Claim | string {
  const split = args.indexOf("--");
  const fromEnv = env.PONPOKO_STRAND?.trim() ?? "";
  const before = split >= 0 ? args.slice(0, split) : fromEnv ? [] : args.slice(0, 1);
  const command = split >= 0 ? args.slice(split + 1) : fromEnv ? args : args.slice(1);
  const strand = before.join(" ").trim() || fromEnv;
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
  else {
    const failed = await send(request).then(
      () => undefined,
      (error: Error) => error,
    );
    if (failed) console.error(`ponpoko for: ${failed.message}; running the command anyway`);
  }
  if (claim.command.length === 0) return 0;
  const child = Bun.spawn(claim.command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
  process.on("SIGINT", () => undefined);
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  return await child.exited;
}
