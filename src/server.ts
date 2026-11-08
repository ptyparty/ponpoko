import type { Socket } from "bun";
import { existsSync, rmSync } from "node:fs";
import { z } from "zod";
import { fact } from "./events.ts";
import { Ponpoko } from "./core.ts";
import { ensurePrivateDir, runtimeDir, socketPath } from "./paths.ts";
import { Store } from "./store.ts";

const where = {
  dir: z.string().optional(),
  self: z.string().optional().describe("The reporting agent's own place handle"),
  strand: z.string().max(200).optional(),
};

export const request = z.discriminatedUnion("method", [
  z.object({ method: z.literal("state") }),
  z.object({ method: z.literal("watch") }),
  z.object({ method: z.literal("knowledge") }),
  z.object({ method: z.literal("record"), params: z.object({ source: z.string().min(1).max(32), facts: z.array(fact) }) }),
  z.object({
    method: z.literal("present"),
    params: z.object({
      adapter: z.string().min(1),
      scope: z.string().min(1),
      players: z.array(z.string()),
      spaces: z.array(z.object({ dir: z.string(), strand: z.string().optional(), handle: z.string().optional(), label: z.string(), short: z.string(), players: z.array(z.string()) })),
    }),
  }),
  z.object({ method: z.literal("absent"), params: z.object({ adapter: z.string(), scope: z.string() }) }),
  z.object({ method: z.literal("status"), params: z.object({ ...where, text: z.string().min(1).max(120), page: z.string().max(200).optional() }) }),
  z.object({ method: z.literal("wait"), params: z.object({ ...where, who: z.string().min(1).max(80), kind: z.enum(["you", "person", "machine"]), what: z.string().min(1).max(200), over: z.boolean().optional() }) }),
  z.object({ method: z.literal("block-by"), params: z.object({ ...where, on: z.string().min(1).max(200), over: z.boolean().optional() }) }),
  z.object({ method: z.literal("block"), params: z.object({ strand: z.string(), on: z.string().min(1).max(200) }) }),
  z.object({ method: z.literal("unblock"), params: z.object({ strand: z.string(), on: z.string().optional() }) }),
  z.object({ method: z.literal("done-by"), params: z.object({ ...where, why: z.string().min(1).max(200) }) }),
  z.object({ method: z.literal("split"), params: z.object({ ...where, names: z.array(z.string().min(1).max(120)).min(1).max(50) }) }),
  z.object({ method: z.literal("add"), params: z.object({ parent: z.string().optional(), name: z.string().min(1).max(200) }) }),
  z.object({ method: z.literal("reparent"), params: z.object({ strand: z.string(), to: z.string().max(200) }) }),
  z.object({ method: z.literal("rename"), params: z.object({ strand: z.string(), name: z.string().min(1).max(200) }) }),
  z.object({ method: z.literal("done"), params: z.object({ strand: z.string() }) }),
  z.object({ method: z.literal("close-move"), params: z.object({ move: z.string() }) }),
  z.object({ method: z.literal("seen"), params: z.object({ strand: z.string() }) }),
  z.object({ method: z.literal("forget"), params: z.object({ strand: z.string() }) }),
  z.object({ method: z.literal("snooze"), params: z.object({ strand: z.string(), until: z.number(), untilNeeded: z.literal(false, "snooze till needed is gone; reopen this ponpoko screen").optional() }) }),
  z.object({ method: z.literal("note"), params: z.object({ strand: z.string(), text: z.string().min(1).max(500) }) }),
  z.object({ method: z.literal("point"), params: z.object({ dir: z.string(), to: z.string().min(1).max(200) }) }),
  z.object({ method: z.literal("changes"), params: z.object({ since: z.number() }) }),
]);

export type Request = z.infer<typeof request>;
export type Response = { ok: true; result?: unknown } | { ok: false; error: string };

export async function serve(): Promise<void> {
  ensurePrivateDir(runtimeDir());
  const path = socketPath();
  if (existsSync(path)) {
    const alive = await Bun.connect({ unix: path, socket: { data() {} } }).then(
      (socket) => (socket.end(), true),
      () => false,
    );
    if (alive) throw new Error(`ponpoko is already running on ${path}`);
    rmSync(path, { force: true });
  }
  const core = new Ponpoko(new Store());
  const watchers = new Set<Socket<{ buffer: string }>>();
  core.onChange(() => {
    for (const socket of watchers) socket.write('{"changed":true}\n');
  });
  const expiry = setInterval(() => core.expire(), 15_000);

  const server = Bun.listen<{ buffer: string }>({
    unix: path,
    socket: {
      open: (socket) => void (socket.data = { buffer: "" }),
      data(socket, data) {
        const lines = (socket.data.buffer + data.toString()).split("\n");
        socket.data.buffer = lines.pop()!;
        for (const line of lines) {
          if (line.trim() === "") continue;
          const parsed = parse(line);
          if (parsed.ok && parsed.request.method === "watch") {
            watchers.add(socket);
            socket.write(`${JSON.stringify({ ok: true })}\n`);
            continue;
          }
          const response = parsed.ok ? handle(core, parsed.request) : parsed.response;
          socket.write(`${JSON.stringify(response)}\n`);
        }
      },
      close: (socket) => void watchers.delete(socket),
      error: (socket) => void watchers.delete(socket),
    },
  });

  const stop = () => {
    clearInterval(expiry);
    server.stop(true);
    rmSync(path, { force: true });
    process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);
  console.log(`ponpoko listening on ${path}`);
}

function parse(line: string): { ok: true; request: Request } | { ok: false; response: Response } {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, response: { ok: false, error: "request is not valid JSON" } };
  }
  const parsed = request.safeParse(json);
  return parsed.success ? { ok: true, request: parsed.data } : { ok: false, response: { ok: false, error: z.prettifyError(parsed.error) } };
}

export function handle(core: Ponpoko, request: Request): Response {
  try {
    switch (request.method) {
      case "state":
        return { ok: true, result: core.snapshot() };
      case "watch":
        return { ok: true };
      case "knowledge":
        return { ok: true, result: core.knowledge() };
      case "record":
        core.record(request.params.source, request.params.facts);
        return { ok: true };
      case "present":
        core.present(request.params);
        return { ok: true };
      case "absent":
        core.absent(request.params.adapter, request.params.scope);
        return { ok: true };
      case "status":
        return { ok: true, result: { strand: core.status(request.params) } };
      case "wait":
        return { ok: true, result: { strand: core.wait(request.params) } };
      case "block-by":
        return { ok: true, result: { strand: core.blockBy(request.params) } };
      case "block":
        return { ok: true, result: { strand: core.block(request.params.strand, request.params.on) } };
      case "unblock":
        core.unblock(request.params.strand, request.params.on);
        return { ok: true };
      case "done-by":
        return { ok: true, result: { strand: core.doneBy(request.params, request.params.why) } };
      case "split":
        return { ok: true, result: { strands: core.split(request.params, request.params.names) } };
      case "add":
        return { ok: true, result: { strand: core.add(request.params.parent, request.params.name) } };
      case "reparent":
        return { ok: true, result: { strand: core.reparent(request.params.strand, request.params.to) } };
      case "rename":
        core.rename(request.params.strand, request.params.name);
        return { ok: true };
      case "done":
        core.done(request.params.strand);
        return { ok: true };
      case "close-move":
        core.closeMove(request.params.move);
        return { ok: true };
      case "seen":
        core.seen(request.params.strand);
        return { ok: true };
      case "forget":
        core.forget(request.params.strand);
        return { ok: true };
      case "snooze":
        core.snooze(request.params.strand, request.params.until);
        return { ok: true };
      case "note":
        core.note(request.params.strand, request.params.text);
        return { ok: true };
      case "point":
        return { ok: true, result: { strand: core.point(request.params.dir, request.params.to) } };
      case "changes":
        return { ok: true, result: core.changes(request.params.since) };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
