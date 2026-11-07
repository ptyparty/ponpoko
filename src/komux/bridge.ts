import { ask, watch } from "../client.ts";
import type { Knowledge, Presence } from "../core.ts";
import type { Fact } from "../events.ts";
import { pickWhose, whoseOf } from "../model.ts";
import { sendKomux, subscribe, type KomuxLine } from "./stream.ts";
import { known, komuxPlace, tabStrand, Translator, type Known } from "./translate.ts";

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
  private cached: Knowledge | undefined;
  private last: Knowledge = { strands: [], players: [], open: [], links: [], on: {}, resumed: {}, spoke: [] };

  constructor(
    private readonly service: Service,
    private readonly control: (request: unknown) => Promise<{ ok: boolean }>,
    private readonly now: () => number = Date.now,
  ) {}

  async line(line: KomuxLine): Promise<void> {
    const knowledge = await this.knowledge().catch(() => undefined);
    const facts = this.translator.facts(line, known(knowledge ?? this.last));
    if (!knowledge || this.behind) {
      this.behind = true;
      return;
    }
    if (!(await this.record(facts))) return;
    await this.publish();
  }

  async heartbeat(): Promise<void> {
    if (this.behind) {
      const again = this.translator.resnapshot();
      this.cached = undefined;
      const knowledge = await this.knowledge().catch(() => undefined);
      if (!again || !knowledge) return;
      if (!(await this.record(this.translator.facts(again, known(knowledge))))) return;
      this.behind = false;
    }
    await this.publish();
  }

  changed(): void {
    this.cached = undefined;
  }

  async publish(): Promise<void> {
    try {
      const knowledge = await this.knowledge();
      const presence = this.translator.presence(known(knowledge));
      if (presence) await this.service.present({ adapter: "komux", ...presence });
      await this.syncBadges(knowledge);
    } catch {
      this.behind = true;
    }
  }

  private async knowledge(): Promise<Knowledge> {
    this.cached ??= await this.service.knowledge();
    this.last = this.cached;
    return this.cached;
  }

  private async record(facts: Fact[]): Promise<boolean> {
    if (facts.length === 0) return true;
    try {
      await this.service.record(facts);
      this.cached = undefined;
      return true;
    } catch {
      this.behind = true;
      return false;
    }
  }

  async leave(): Promise<void> {
    const presence = this.translator.presence(known(this.last));
    if (presence) await this.service.absent(presence.scope).catch(() => undefined);
  }

  badges(knowledge: Knowledge): Badge[] {
    const now = this.now();
    const model = known(knowledge);
    return this.translator.tabs().map((tab): Badge => {
      const players = [...model.players.values()].filter((player) => this.inTab(player, tab.id)).map((player) => player.id);
      const strands = new Set([...(tabStrand(tab, model)?.id ? [tabStrand(tab, model)!.id!] : []), ...players.flatMap((player) => model.on.get(player) ?? [])]);
      const standings = [...strands].flatMap((id) => {
        const strand = model.strands.get(id);
        return strand ? [{ strand, whose: whoseNow(model, strand) }] : [];
      });
      const snoozed = (strand: (typeof standings)[number]["strand"]) => (strand.snoozedUntil ?? 0) > now;
      const yours = standings.filter((entry) => entry.whose === "you" && !snoozed(entry.strand)).length;
      if (yours > 0) return { tabId: tab.id, text: yours > 1 ? `●${yours}` : "●", color: "warning" };
      if (standings.some((entry) => entry.whose === "waiting")) return { tabId: tab.id, text: "⊘", color: "muted" };
      if (standings.some((entry) => entry.whose === "you" && snoozed(entry.strand))) return { tabId: tab.id, text: "◷", color: "muted" };
      return { tabId: tab.id, text: null };
    });
  }

  private inTab(player: Knowledge["players"][number], tabId: number): boolean {
    const place = komuxPlace(player);
    return place !== undefined && place.server === this.translator.server() && place.tabId === tabId;
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
  await subscribe(events, (line) => serial(() => bridge.line(line)), () => closed.resolve());
  let watching: { close: () => void } | undefined;
  const keepWatching = async () => {
    watching ??= await watch(
      () => {
        bridge.changed();
        serial(() => bridge.publish());
      },
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

function whoseNow(model: Known, strand: Knowledge["strands"][number]): "you" | "agent" | "waiting" | undefined {
  const whose = pickWhose(model.open.filter((move) => move.strand === strand.id).map((move) => (move.player === "you" ? "you" : whoseOf(model.players.get(move.player)?.kind ?? "machine"))));
  if (whose) return whose === "person" || whose === "machine" ? "waiting" : whose;
  return [...model.strands.values()].some((child) => child.parent === strand.id) ? undefined : "you";
}
