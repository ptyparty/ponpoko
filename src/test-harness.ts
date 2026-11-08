import type { Actions } from "./actions.ts";
import { Ponpoko } from "./core.ts";
import { Bridge } from "./komux/bridge.ts";
import { komuxLine } from "./komux/stream.ts";
import { handle, request } from "./server.ts";
import type { TitleLookup } from "./shortcut.ts";
import { Store } from "./store.ts";

export function harness(start = 1_000_000, store = new Store(":memory:"), shared?: Ponpoko, lookupTitle: TitleLookup = async () => ({ kind: "story", title: "Widget CSV import" })) {
  let now = start;
  let ids = 0;
  const core = shared ?? new Ponpoko(store, () => now, (prefix) => `${prefix}${++ids}`);
  const sent: unknown[] = [];
  const service = { down: false };
  const up = () => {
    if (service.down) throw new Error("ponpoko isn't running");
  };
  const bridge = new Bridge(
    {
      knowledge: async () => (up(), core.knowledge()),
      record: async (facts, source = "komux") => (up(), core.record(source, facts)),
      present: async (presence) => (up(), void handle(core, request.parse({ method: "present", params: presence }))),
      absent: async (scope) => (up(), core.absent("komux", scope)),
    },
    async (request) => {
      sent.push(request);
      return { ok: true };
    },
    () => now,
    lookupTitle,
  );
  const hear = (line: Record<string, unknown>) => bridge.line(komuxLine.parse({ session: "main", server: "s1", ...line }));
  core.onChange(() => bridge.changed());
  return { core, bridge, sent, hear, store, service, tick: (ms: number) => (now += ms), now: () => now };
}

export function recordingActions() {
  const calls: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => void calls.push([name, ...args]);
  const actions = {
    go: async (strand: { id: string }) => void calls.push(["go", strand.id]),
    assign: async (strand: { id: string }) => void calls.push(["assign", strand.id]),
    pickUp: async (strand: { id: string }, how: string) => void calls.push(["pickUp", strand.id, how]),
    forget: record("forget"),
    snooze: record("snooze"),
    note: record("note"),
    point: record("point"),
    seen: record("seen"),
    add: record("add"),
    reparent: record("reparent"),
    block: record("block"),
    unblock: record("unblock"),
    rename: record("rename"),
    title: record("title"),
    done: record("done"),
    open: async (link: { ref: string }) => void calls.push(["open", link.ref]),
  } as Actions;
  return { actions, calls };
}

export function strandNamed(core: Ponpoko, path: string) {
  const found = core.snapshot().strands.find((strand) => strand.path.join(" › ") === path);
  if (!found) throw new Error(`no strand ${path}: ${core.snapshot().strands.map((strand) => strand.path.join(" › ")).join(", ")}`);
  return found;
}
