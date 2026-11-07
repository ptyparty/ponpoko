import { braidForDir } from "../braids.ts";
import { ask, watch } from "../client.ts";
import type { Knowledge, Presence } from "../core.ts";
import type { Fact } from "../events.ts";
import { komuxLine, sendKomux, subscribe, type KomuxLine } from "./stream.ts";
import { known, Translator } from "./translate.ts";

export type Service = {
  knowledge: () => Promise<Knowledge>;
  record: (facts: Fact[]) => Promise<void>;
  present: (presence: Presence) => Promise<void>;
  absent: (scope: string) => Promise<void>;
};

export type Badge = { tabId: number; text: string | null; color?: string };

const heartbeatMs = 30_000;

export class Bridge {
  readonly translator = new Translator();
  private readonly badgesSent = new Map<number, string>();
  private behind = false;

  constructor(
    private readonly service: Service,
    private readonly control: (request: unknown) => Promise<{ ok: boolean }>,
    private readonly now: () => number = Date.now,
  ) {}

  async line(line: KomuxLine): Promise<void> {
    try {
      const facts = this.translator.facts(line, known(await this.service.knowledge()));
      if (facts.length > 0) await this.service.record(facts);
      this.behind = false;
    } catch {
      this.behind = true;
      return;
    }
    await this.publish();
  }

  async heartbeat(): Promise<void> {
    const again = this.behind ? this.translator.resnapshot() : undefined;
    if (again) return this.line(again);
    await this.publish();
  }

  async publish(): Promise<void> {
    try {
      const presence = this.translator.presence();
      if (presence) await this.service.present({ adapter: "komux", ...presence });
      await this.syncBadges(await this.service.knowledge());
    } catch {
      this.behind = true;
    }
  }

  async leave(): Promise<void> {
    const presence = this.translator.presence();
    if (presence) await this.service.absent(presence.scope).catch(() => undefined);
  }

  badges(knowledge: Knowledge): Badge[] {
    const now = this.now();
    const pointed = new Map(knowledge.pointed);
    return this.translator.tabs().map((tab): Badge => {
      const braid = braidForDir(tab.dir, pointed).id;
      const strands = knowledge.strands.filter((strand) => strand.braid === braid);
      const snoozed = (strand: (typeof strands)[number]) => (strand.snoozedUntil ?? 0) > now;
      const yours = strands.filter((strand) => strand.whose === "you" && !snoozed(strand)).length;
      if (yours > 0) return { tabId: tab.id, text: yours > 1 ? `●${yours}` : "●", color: "warning" };
      if (strands.some((strand) => strand.whose === "machine" || strand.whose === "person")) return { tabId: tab.id, text: "⊘", color: "muted" };
      if (strands.some((strand) => strand.whose === "you" && snoozed(strand))) return { tabId: tab.id, text: "◷", color: "muted" };
      return { tabId: tab.id, text: null };
    });
  }

  private async syncBadges(knowledge: Knowledge): Promise<void> {
    const open = new Set<number>();
    for (const badge of this.badges(knowledge)) {
      open.add(badge.tabId);
      const look = badge.text === null ? "" : `${badge.text}:${badge.color}`;
      if ((this.badgesSent.get(badge.tabId) ?? "") === look) continue;
      this.badgesSent.set(badge.tabId, look);
      const sent = await this.control({ method: "tab.badge", params: { tabId: badge.tabId, owner: "ponpoko", text: badge.text, ...(badge.color ? { color: badge.color } : {}) } }).catch(() => ({ ok: false }));
      if (!sent.ok) this.badgesSent.delete(badge.tabId);
    }
    for (const tabId of this.badgesSent.keys()) if (!open.has(tabId)) this.badgesSent.delete(tabId);
  }
}

export const serviceForBridge: Service = {
  knowledge: async () => (await ask({ method: "knowledge" })) as Knowledge,
  record: async (facts) => void (await ask({ method: "record", params: { source: "komux", facts } })),
  present: async (presence) => void (await ask({ method: "present", params: presence })),
  absent: async (scope) => void (await ask({ method: "absent", params: { adapter: "komux", scope } })),
};

export async function runBridge(env = process.env): Promise<number> {
  const events = env.KOMUX_EVENTS_SOCKET;
  const control = env.KOMUX_SOCKET;
  if (!events || !control) {
    console.error("ponpoko komux runs as a komux helper: list it under the plugin's run, so komux gives it KOMUX_EVENTS_SOCKET and KOMUX_SOCKET");
    return 2;
  }
  const bridge = new Bridge(serviceForBridge, (request) => sendKomux(control, request));
  let queue = Promise.resolve();
  const serial = (work: () => Promise<void>) => {
    queue = queue.then(work).catch(() => undefined);
  };
  const closed = Promise.withResolvers<void>();
  await subscribe(events, (line) => serial(() => bridge.line(komuxLine.parse(line))), () => closed.resolve());
  let watching: { close: () => void } | undefined;
  const keepWatching = async () => {
    watching ??= await watch(
      () => serial(() => bridge.publish()),
      () => (watching = undefined),
    ).catch(() => undefined);
  };
  await keepWatching();
  const timer = setInterval(() => {
    void keepWatching();
    serial(() => bridge.heartbeat());
  }, heartbeatMs);
  const leave = async () => {
    clearInterval(timer);
    watching?.close();
    await queue;
    await bridge.leave();
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void leave().then(() => process.exit(0)));
  await closed.promise;
  await leave();
  return 0;
}
