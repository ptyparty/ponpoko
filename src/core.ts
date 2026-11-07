import { braidForDir, storyNumber } from "./braids.ts";
import type { Fact, Recorded, Source, Whose } from "./events.ts";
import { agentStrandId, controlSocket, sendKomux, Translator, type KomuxLine } from "./komux.ts";
import { apply, counts, recentHeard, replay, unseenMoves, yourMoves, type Braid, type Counts, type Model, type Strand } from "./model.ts";
import { komuxSessionsDir } from "./paths.ts";
import type { Store } from "./store.ts";

export type StrandView = Strand & { live: boolean; tab?: { session: string; number?: number; name: string } };
export type BraidView = Braid & { strands: StrandView[]; tabs: { session: string; number?: number; name: string }[] };
export type Snapshot = { now: number; counts: Counts; braids: BraidView[]; moves: StrandView[]; unseen: string[]; heard: Recorded[] };

export type Report = { braid?: string; dir?: string; session?: string; paneId?: number; strand?: string; whose: Whose | "done"; who?: string; reason: string };

export type KomuxSender = (session: string, request: unknown) => Promise<{ ok: boolean; error?: string }>;

export class Ponpoko {
  readonly model: Model;
  readonly translator = new Translator();
  private readonly listeners = new Set<() => void>();
  private readonly titleAsked = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly sendToKomux: KomuxSender = (session, request) => sendKomux(controlSocket(komuxSessionsDir(), session), request),
    private readonly lookupTitle: (braid: string) => Promise<{ kind: "story" | "epic"; title: string } | undefined> = shortcutTitle,
    private readonly now: () => number = Date.now,
  ) {
    this.model = replay(store.all());
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(source: Source, facts: Fact[]): void {
    if (facts.length === 0) return;
    for (const fact of facts) {
      const recorded = this.store.append(source, fact, this.now());
      apply(this.model, recorded);
      if (fact.type === "braid.made") this.askTitle(fact.braid);
    }
    for (const listener of this.listeners) listener();
  }

  heardKomux(line: KomuxLine): void {
    this.record("komux", this.translator.facts(line, this.model));
  }

  komuxGone(server: string): void {
    this.translator.disconnected(server);
    for (const listener of this.listeners) listener();
  }

  snapshot(): Snapshot {
    const now = this.now();
    const tabs = this.translator.liveTabs();
    const view = (strand: Strand): StrandView => {
      const live = this.translator.livePane(strand.place);
      const tab = live ? tabs.find((entry) => entry.server === live.server && entry.tab.id === live.tabId) : undefined;
      return { ...strand, live: live !== undefined, ...(tab ? { tab: { session: tab.session, number: tab.tab.number, name: tab.tab.name } } : {}) };
    };
    const braids = [...this.model.braids.values()].map((braid): BraidView => ({
      ...braid,
      strands: [...this.model.strands.values()].filter((strand) => strand.braid === braid.id).map(view).sort((a, b) => a.since - b.since),
      tabs: tabs.filter((entry) => braidForDir(entry.tab.dir, this.model.pointed).id === braid.id).map((entry) => ({ session: entry.session, number: entry.tab.number, name: entry.tab.name })),
    }));
    const shown = braids.filter((braid) => braid.strands.length > 0 || braid.tabs.length > 0 || braid.notes.length > 0);
    shown.sort((a, b) => firstMove(a, now) - firstMove(b, now) || a.name.localeCompare(b.name));
    return {
      now,
      counts: counts(this.model, now),
      braids: shown,
      moves: yourMoves(this.model, now).map(view),
      unseen: unseenMoves(this.model, now).map((strand) => strand.id),
      heard: recentHeard(this.model, 30),
    };
  }

  report(report: Report, source: Source = "agent"): string {
    const braid = this.reportBraid(report);
    const own = report.strand === undefined || report.strand === "self";
    const paneStrand = own && report.paneId !== undefined ? this.agentStrand(report.session, report.paneId) : undefined;
    if (own && !paneStrand) throw new Error("name the strand this report is about, such as \"PR #821 review\"; this agent's own pane isn't known to ponpoko");
    const id = paneStrand?.id ?? `report:${braid}:${slug(report.strand!)}`;
    if (report.whose === "done") {
      if (this.model.strands.has(id)) this.record(source, [{ type: "strand.ended", strand: id, why: report.reason }]);
      return id;
    }
    const facts: Fact[] = [];
    if (!this.model.braids.has(braid) && report.dir) {
      const ref = braidForDir(report.dir, this.model.pointed);
      facts.push({ type: "braid.made", braid, name: ref.name, kind: ref.kind, dir: report.dir });
    }
    facts.push({
      type: "strand.move",
      braid: paneStrand?.braid ?? braid,
      strand: id,
      label: paneStrand?.label ?? report.strand!,
      kind: paneStrand ? "agent" : "report",
      whose: report.whose,
      ...(report.who ? { who: report.who } : {}),
      why: report.reason,
    });
    this.record(source, facts);
    return id;
  }

  forget(strand: string): void {
    this.mustHave(strand);
    this.record("you", [{ type: "strand.forgotten", strand }]);
  }

  snooze(strand: string, until: number): void {
    this.mustHave(strand);
    this.record("you", [{ type: "strand.snoozed", strand, until }]);
  }

  note(braid: string, text: string): void {
    if (!this.model.braids.has(braid)) throw new Error(`no braid ${braid}`);
    this.record("you", [{ type: "braid.note", braid, text }]);
  }

  seen(braid: string): void {
    if (!this.model.braids.has(braid)) throw new Error(`no braid ${braid}`);
    this.record("you", [{ type: "braid.seen", braid }]);
  }

  point(dir: string, braid: string): void {
    const facts: Fact[] = [];
    if (!this.model.braids.has(braid)) facts.push({ type: "braid.made", braid, name: storyNumber(braid) ? braid.toUpperCase() : braid });
    facts.push({ type: "dir.pointed", dir, braid });
    this.record("you", facts);
  }

  changes(since: number): Recorded[] {
    return this.store.since(since);
  }

  async go(id: string): Promise<string> {
    const strand = this.mustHave(id);
    const live = this.translator.livePane(strand.place);
    let result: { ok: boolean; error?: string };
    if (live) result = await this.sendToKomux(live.session, { method: "pane.focus", params: { paneId: live.paneId } });
    else {
      const dir = strand.place?.dir ?? this.model.braids.get(strand.braid)?.dir;
      if (!dir) throw new Error("ponpoko doesn't know where this strand lives");
      const sessions = [...new Set(this.translator.liveTabs().map((entry) => entry.session))];
      const tab = this.translator.liveTabs().find((entry) => entry.tab.dir === dir);
      const session = tab?.session ?? (strand.place && sessions.includes(strand.place.session) ? strand.place.session : sessions[0]);
      if (!session) throw new Error("komux isn't running, or ponpoko can't hear it");
      result = await this.sendToKomux(session, { method: "project.open", params: { target: dir } });
    }
    if (!result.ok) throw new Error(result.error ?? "komux refused");
    if (strand.kind === "job") this.record("you", [{ type: "strand.ended", strand: id, why: "you went to it" }]);
    else if (strand.whose === "you" && !strand.seen) this.record("you", [{ type: "strand.seen", strand: id }]);
    return live ? "focused" : "opened";
  }

  private agentStrand(session: string | undefined, paneId: number): Strand | undefined {
    return [...this.model.strands.values()].find((strand) => strand.kind === "agent" && strand.place?.paneId === paneId && (session === undefined || strand.place.session === session) && this.translator.livePane(strand.place));
  }

  private reportBraid(report: Report): string {
    if (report.braid) return report.braid.toLowerCase().startsWith("sc-") ? report.braid.toLowerCase() : report.braid;
    if (report.paneId !== undefined) {
      const strand = this.agentStrand(report.session, report.paneId);
      if (strand) return strand.braid;
    }
    if (report.dir) return braidForDir(report.dir, this.model.pointed).id;
    throw new Error("say which braid this is about");
  }

  private mustHave(id: string): Strand {
    const strand = this.model.strands.get(id);
    if (!strand) throw new Error(`no strand ${id}`);
    return strand;
  }

  private askTitle(braid: string): void {
    if (storyNumber(braid) === undefined || this.titleAsked.has(braid) || this.model.braids.get(braid)?.title) return;
    this.titleAsked.add(braid);
    void this.lookupTitle(braid)
      .then((found) => {
        if (found) this.record("ponpoko", [{ type: "braid.titled", braid, ...found }]);
      })
      .catch(() => undefined);
  }
}

function firstMove(braid: BraidView, now: number): number {
  const yours = braid.strands.filter((strand) => strand.whose === "you" && !((strand.snoozedUntil ?? 0) > now));
  return yours.length > 0 ? yours[0]!.since : Number.MAX_SAFE_INTEGER;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9#]+/g, "-").replace(/^-|-$/g, "") || "strand";
}

export async function shortcutTitle(braid: string): Promise<{ kind: "story" | "epic"; title: string } | undefined> {
  const number = storyNumber(braid);
  const token = process.env.SHORTCUT_API_TOKEN;
  if (number === undefined || !token) return undefined;
  const headers = { "Shortcut-Token": token, "Content-Type": "application/json" };
  for (const kind of ["story", "epic"] as const) {
    const response = await fetch(`https://api.app.shortcut.com/api/v3/${kind === "story" ? "stories" : "epics"}/${number}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const body = (await response.json()) as { name?: string };
      if (body.name) return { kind, title: body.name };
    }
    if (response.status !== 404) return undefined;
  }
  return undefined;
}
