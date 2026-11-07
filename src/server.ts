import type { Socket } from "bun";
import { existsSync, rmSync } from "node:fs";
import { z } from "zod";
import { whoseValues } from "./events.ts";
import { Ponpoko } from "./core.ts";
import { eventSockets, subscribe } from "./komux.ts";
import { ensurePrivateDir, komuxSessionsDir, runtimeDir, socketPath } from "./paths.ts";
import { Store } from "./store.ts";

export const request = z.discriminatedUnion("method", [
  z.object({ method: z.literal("state") }),
  z.object({ method: z.literal("watch") }),
  z.object({
    method: z.literal("report"),
    params: z.object({
      braid: z.string().optional(),
      dir: z.string().optional(),
      session: z.string().optional(),
      paneId: z.number().int().optional(),
      strand: z.string().optional(),
      whose: z.enum([...whoseValues, "done"]),
      who: z.string().max(80).optional(),
      reason: z.string().min(1).max(200),
    }),
  }),
  z.object({ method: z.literal("forget"), params: z.object({ strand: z.string() }) }),
  z.object({ method: z.literal("snooze"), params: z.object({ strand: z.string(), until: z.number() }) }),
  z.object({ method: z.literal("note"), params: z.object({ braid: z.string(), text: z.string().min(1).max(500) }) }),
  z.object({ method: z.literal("seen"), params: z.object({ braid: z.string() }) }),
  z.object({ method: z.literal("point"), params: z.object({ dir: z.string(), braid: z.string().min(1) }) }),
  z.object({ method: z.literal("go"), params: z.object({ strand: z.string() }) }),
  z.object({ method: z.literal("changes"), params: z.object({ since: z.number() }) }),
]);

export type Request = z.infer<typeof request>;
export type Response = { ok: true; result?: unknown } | { ok: false; error: string };

const scanMs = 2000;

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
  let badging = Promise.resolve();
  const syncBadges = () => {
    badging = badging.then(() => core.syncBadges()).catch(() => undefined);
  };
  core.onChange(() => {
    for (const socket of watchers) socket.write('{"changed":true}\n');
    syncBadges();
  });
  const badgeClock = setInterval(syncBadges, 30_000);

  const server = Bun.listen<{ buffer: string }>({
    unix: path,
    socket: {
      open: (socket) => void (socket.data = { buffer: "" }),
      async data(socket, data) {
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
          const response = parsed.ok ? await handle(core, parsed.request) : parsed.response;
          socket.write(`${JSON.stringify(response)}\n`);
        }
      },
      close: (socket) => void watchers.delete(socket),
      error: (socket) => void watchers.delete(socket),
    },
  });

  const connected = new Map<string, { close: () => void }>();
  const connecting = new Set<string>();
  const scan = () => {
    for (const { path: events } of eventSockets(komuxSessionsDir())) {
      if (connected.has(events) || connecting.has(events)) continue;
      connecting.add(events);
      let server: string | undefined;
      subscribe(
        events,
        (line) => {
          server = line.server;
          core.heardKomux(line);
        },
        () => {
          connected.delete(events);
          if (server) core.komuxGone(server);
        },
      ).then(
        (connection) => {
          connecting.delete(events);
          connected.set(events, connection);
        },
        () => connecting.delete(events),
      );
    }
  };
  scan();
  const scanner = setInterval(scan, scanMs);

  const stop = () => {
    clearInterval(scanner);
    clearInterval(badgeClock);
    for (const connection of connected.values()) connection.close();
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

export async function handle(core: Ponpoko, request: Request): Promise<Response> {
  try {
    switch (request.method) {
      case "state":
        return { ok: true, result: core.snapshot() };
      case "watch":
        return { ok: true };
      case "report":
        return { ok: true, result: { strand: core.report(request.params) } };
      case "forget":
        core.forget(request.params.strand);
        return { ok: true };
      case "snooze":
        core.snooze(request.params.strand, request.params.until);
        return { ok: true };
      case "note":
        core.note(request.params.braid, request.params.text);
        return { ok: true };
      case "seen":
        core.seen(request.params.braid);
        return { ok: true };
      case "point":
        core.point(request.params.dir, request.params.braid);
        return { ok: true };
      case "go":
        return { ok: true, result: await core.go(request.params.strand) };
      case "changes":
        return { ok: true, result: core.changes(request.params.since) };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
