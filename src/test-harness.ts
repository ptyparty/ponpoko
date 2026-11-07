import type { Actions } from "./actions.ts";
import { Ponpoko } from "./core.ts";
import { Bridge } from "./komux/bridge.ts";
import { komuxLine } from "./komux/stream.ts";
import { Store } from "./store.ts";

export function harness(start = 1_000_000, store = new Store(":memory:")) {
  let now = start;
  const core = new Ponpoko(store, async () => ({ kind: "story", title: "Widget CSV import" }), () => now);
  const sent: unknown[] = [];
  const bridge = new Bridge(
    {
      knowledge: async () => core.knowledge(),
      record: async (facts) => core.record("komux", facts),
      present: async (presence) => core.present(presence),
      absent: async (scope) => core.absent("komux", scope),
    },
    async (request) => {
      sent.push(request);
      return { ok: true };
    },
    () => now,
  );
  const hear = (line: Record<string, unknown>) => bridge.line(komuxLine.parse({ session: "main", server: "s1", ...line }));
  return { core, bridge, sent, hear, store, tick: (ms: number) => (now += ms), now: () => now };
}

export function recordingActions() {
  const calls: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => void calls.push([name, ...args]);
  const actions = {
    go: async (strand: { id: string }, dir: string | undefined) => void calls.push(["go", strand.id, dir]),
    forget: record("forget"),
    snooze: record("snooze"),
    note: record("note"),
    point: record("point"),
    seen: record("seen"),
    showPage: record("showPage"),
  } as Actions;
  return { actions, calls };
}
