import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ask, watch } from "../client.ts";
import { ensurePrivateDir, runtimeDir } from "../paths.ts";
import type { Knowledge, Presence } from "../core.ts";
import type { Fact } from "../events.ts";
import { pickWhose, whoseOf } from "../model.ts";
import { fetchInbox, type Inbox } from "../github.ts";
import { inboxFacts, source as githubSource } from "../inbox.ts";
import { shortcutTitle, storyNumber, type TitleLookup } from "../shortcut.ts";
import { sendKomux, subscribe, type KomuxLine } from "./stream.ts";
import { known, komuxPlace, tabStrand, Translator, type Known } from "./translate.ts";

export type Service = {
  knowledge: () => Promise<Knowledge>;
  record: (facts: Fact[], source?: string) => Promise<void>;
  present: (presence: Presence) => Promise<void>;
  absent: (scope: string) => Promise<void>;
};

export type Badge = { tabId: number; text: string | null; color?: string };

const heartbeatMs = 30_000;
const titleRetryMs = 10 * 60_000;
const inboxMs = 2 * 60_000;

export class Bridge {
  readonly translator = new Translator();
  private readonly badgesSent = new Map<number, string>();
  private behind = false;
  private cached: Knowledge | undefined;
  private last: Knowledge = { strands: [], closed: [], players: [], open: [], links: [], on: {}, resumed: {}, spoke: [] };
  private readonly titled = new Set<string>();
  private readonly titling = new Set<string>();
  private readonly titleFailed = new Map<string, number>();
  private inboxAt = Number.NEGATIVE_INFINITY;
  private inboxing = false;
  private inboxError: string | undefined;

  constructor(
    private readonly service: Service,
    private readonly control: (request: unknown) => Promise<{ ok: boolean }>,
    private readonly now: () => number = Date.now,
    private readonly lookupTitle: TitleLookup = shortcutTitle,
    private readonly lookupInbox: (() => Promise<Inbox>) | undefined = undefined,
    private readonly newId: (prefix: string) => string = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`,
  ) {}

  async pollInbox(inTurn: <T>(work: () => Promise<T>) => Promise<T> = (work) => work()): Promise<boolean> {
    if (!this.lookupInbox || this.inboxing || this.now() < this.inboxAt + inboxMs) return false;
    this.inboxing = true;
    this.inboxAt = this.now();
    try {
      const inbox = await this.lookupInbox();
      const recorded = await inTurn(async () => {
        this.cached = undefined;
        const facts = inboxFacts(await this.knowledge(), inbox, this.newId);
        if (facts.length === 0) return false;
        await this.service.record(facts, githubSource);
        this.cached = undefined;
        return true;
      });
      this.inboxError = undefined;
      return recorded;
    } catch (error) {
      const message = (error as Error).message;
      if (message !== this.inboxError) console.error(`ponpoko: GitHub reviews and mentions: ${message}`);
      this.inboxError = message;
      return false;
    } finally {
      this.inboxing = false;
    }
  }

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
      this.askTitles(knowledge);
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

  private askTitles(knowledge: Knowledge): void {
    for (const strand of knowledge.strands) {
      if (strand.parent !== undefined || strand.title || storyNumber(strand.name) === undefined) continue;
      if (this.titled.has(strand.id) || this.titling.has(strand.id) || this.now() < (this.titleFailed.get(strand.id) ?? 0) + titleRetryMs) continue;
      this.titling.add(strand.id);
      void this.lookupTitle(strand.name)
        .then(async (found) => {
          if (found) await this.service.record([{ type: "strand.titled", strand: strand.id, ...found }]);
          this.titled.add(strand.id);
          this.titleFailed.delete(strand.id);
        })
        .catch(() => void this.titleFailed.set(strand.id, this.now()))
        .finally(() => this.titling.delete(strand.id));
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

export class PollLock {
  constructor(
    private readonly file: string,
    private readonly pid = process.pid,
    private readonly alive: (pid: number) => boolean = isAlive,
  ) {}

  take(): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.file, "wx", 0o600);
        writeSync(fd, `${this.pid}\n`);
        closeSync(fd);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      }
      const holder = Number(readFileSync(this.file, "utf8").trim());
      if (holder === this.pid) return true;
      if (Number.isInteger(holder) && holder > 0 && this.alive(holder)) return false;
      rmSync(this.file, { force: true });
    }
    return false;
  }

  release(): void {
    if (existsSync(this.file) && Number(readFileSync(this.file, "utf8").trim()) === this.pid) rmSync(this.file, { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const serviceForBridge: Service = {
  knowledge: async () => (await ask({ method: "knowledge" })) as Knowledge,
  record: async (facts, source = "komux") => void (await ask({ method: "record", params: { source, facts } })),
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
  const bridge = new Bridge(serviceForBridge, (request) => sendKomux(control, request), Date.now, shortcutTitle, env.PONPOKO_GITHUB === "off" ? undefined : () => fetchInbox());
  let queue = Promise.resolve();
  const serial = (work: () => Promise<void>) => {
    queue = queue.then(work).catch(() => undefined);
  };
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const done = queue.then(work);
    queue = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
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
  const lock = env.PONPOKO_GITHUB === "off" ? undefined : new PollLock(join(ensurePrivateDir(runtimeDir()), "github.lock"));
  const pollInbox = async () => {
    if (lock?.take() && (await bridge.pollInbox(inTurn))) serial(() => bridge.publish());
  };
  const timer = setInterval(() => {
    void keepWatching();
    serial(() => bridge.heartbeat());
    void pollInbox();
  }, heartbeatMs);
  void pollInbox();
  const leave = async () => {
    clearInterval(timer);
    watching?.close();
    await queue;
    lock?.release();
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
