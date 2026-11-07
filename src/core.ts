import { braidRef, pointedBraid, storyNumber } from "./braids.ts";
import type { Fact, Recorded, Source, Whose } from "./events.ts";
import { apply, counts, recentHeard, replay, unseenMoves, yourMoves, type Braid, type Counts, type Model, type Strand } from "./model.ts";
import type { Store } from "./store.ts";

export type Space = { dir: string; braid?: string; label: string; short: string; strands: string[] };
export type Presence = { adapter: string; scope: string; strands: string[]; spaces: Space[] };
export type StrandView = Strand & { live: boolean; space?: string };
export type BraidView = Braid & { strands: StrandView[]; spaces: { label: string; short: string }[] };
export type Snapshot = { now: number; counts: Counts; braids: BraidView[]; loose: StrandView[]; moves: StrandView[]; unseen: string[]; heard: Recorded[]; labels: Record<string, string> };
export type Knowledge = { braids: string[]; pointed: [string, string][]; strands: Strand[] };

export type Report = { braid?: string; dir?: string; self?: string; strand?: string; whose: Whose | "done"; who?: string; reason: string };
export type Status = { braid?: string; dir?: string; self?: string; strand?: string; text: string; page?: string };

const presenceMs = 90_000;

export class Ponpoko {
  readonly model: Model;
  private readonly listeners = new Set<() => void>();
  private readonly titleAsked = new Set<string>();
  private readonly presences = new Map<string, Presence & { until: number }>();

  constructor(
    private readonly store: Store,
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
    this.changed();
  }

  present(presence: Presence): void {
    const key = `${presence.adapter}:${presence.scope}`;
    const before = this.presences.get(key);
    this.presences.set(key, { ...presence, until: this.now() + presenceMs });
    const lapsed = before !== undefined && before.until <= this.now();
    if (!before || lapsed || JSON.stringify([before.strands, before.spaces]) !== JSON.stringify([presence.strands, presence.spaces])) this.changed();
  }

  expire(): void {
    const now = this.now();
    const lapsed = [...this.presences].filter(([, presence]) => presence.until <= now);
    for (const [key] of lapsed) this.presences.delete(key);
    if (lapsed.length > 0) this.changed();
  }

  absent(adapter: string, scope: string): void {
    if (this.presences.delete(`${adapter}:${scope}`)) this.changed();
  }

  knowledge(): Knowledge {
    return { braids: [...this.model.braids.keys()], pointed: [...this.model.pointed], strands: [...this.model.strands.values()] };
  }

  snapshot(): Snapshot {
    const now = this.now();
    const present = [...this.presences.values()].filter((presence) => presence.until > now);
    const live = new Set(present.flatMap((presence) => presence.strands));
    const spaces = present.flatMap((presence) => presence.spaces);
    const view = (strand: Strand): StrandView => {
      const space = spaces.find((candidate) => candidate.strands.includes(strand.id))?.label;
      return { ...strand, live: live.has(strand.id), ...(space ? { space } : {}) };
    };
    const braids = [...this.model.braids.values()].map((braid): BraidView => ({
      ...braid,
      strands: [...this.model.strands.values()].filter((strand) => strand.braid === braid.id).map(view).sort((a, b) => a.since - b.since),
      spaces: spaces.filter((space) => space.braid === braid.id).map(({ label, short }) => ({ label, short })),
    }));
    const shown = braids.filter((braid) => braid.strands.length > 0 || braid.spaces.length > 0 || braid.notes.length > 0);
    shown.sort((a, b) => firstMove(a, now) - firstMove(b, now) || a.name.localeCompare(b.name));
    const heard = recentHeard(this.model, 30);
    return {
      now,
      counts: counts(this.model, now),
      braids: shown,
      loose: [...this.model.strands.values()].filter((strand) => strand.braid === undefined).map(view).sort((a, b) => a.since - b.since),
      moves: yourMoves(this.model, now).map(view),
      unseen: unseenMoves(this.model, now).map((strand) => strand.id),
      heard,
      labels: Object.fromEntries(
        heard.flatMap((event) => {
          if (!("strand" in event)) return [];
          const known = this.model.labels.get(event.strand);
          return known ? [[event.strand, `${(known.braid && this.model.braids.get(known.braid)?.name) || known.braid || "loose"} ${known.label}`]] : [];
        }),
      ),
    };
  }

  report(report: Report, source: Source = "agent"): string {
    const own = report.strand === undefined || report.strand === "self";
    const mine = own ? this.ownStrand(report.self) : undefined;
    if (own && !mine) throw new Error("name the strand this report is about, such as \"PR #821 review\"; ponpoko doesn't know this agent's own strand");
    const braid = report.braid ? braidRef(report.braid).id : mine ? mine.braid : this.reportBraid(report);
    const id = mine?.id ?? `report:${braid ?? "loose"}:${slug(report.strand!)}`;
    if (report.whose === "done") {
      if (this.model.strands.has(id)) this.record(source, [{ type: "strand.ended", strand: id, why: report.reason }]);
      return id;
    }
    const facts: Fact[] = [];
    if (braid && !this.model.braids.has(braid)) facts.push({ type: "braid.made", braid, name: braidRef(braid).name, ...(report.dir ? { dir: report.dir } : {}) });
    facts.push({
      type: "strand.move",
      ...(braid ? { braid } : {}),
      strand: id,
      label: mine?.label ?? report.strand!,
      kind: mine ? mine.kind : "report",
      whose: report.whose,
      ...(report.who ? { who: report.who } : {}),
      why: report.reason,
    });
    this.record(source, facts);
    return id;
  }

  status(status: Status): string {
    const own = status.strand === undefined || status.strand === "self";
    const mine = own ? this.ownStrand(status.self) : undefined;
    if (own && !mine) throw new Error("ponpoko doesn't know this agent's own strand; name the strand instead");
    const id = mine?.id ?? `report:${this.reportBraid(status) ?? "loose"}:${slug(status.strand!)}`;
    if (!this.model.strands.has(id)) throw new Error(`no strand ${status.strand}; report it first`);
    this.record("agent", [{ type: "strand.status", strand: id, text: status.text, ...(status.page ? { page: status.page } : {}) }]);
    return id;
  }

  end(strand: string, why: string): void {
    this.mustHave(strand);
    this.record("you", [{ type: "strand.ended", strand, why }]);
  }

  seenStrand(strand: string): void {
    if (this.mustHave(strand).whose === "you") this.record("you", [{ type: "strand.seen", strand }]);
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

  point(dir: string, wanted: string): void {
    const braid = braidRef(wanted).id;
    const facts: Fact[] = [];
    if (!this.model.braids.has(braid)) facts.push({ type: "braid.made", braid, name: braidRef(braid).name });
    facts.push({ type: "dir.pointed", dir, braid });
    for (const strand of this.model.strands.values()) {
      const at = strand.place?.dir;
      if (strand.braid !== undefined || typeof at !== "string" || (at !== dir && !at.startsWith(`${dir}/`))) continue;
      facts.push({ type: "strand.move", braid, strand: strand.id, label: strand.label, kind: strand.kind, whose: strand.whose, ...(strand.who ? { who: strand.who } : {}), why: strand.why });
    }
    this.record("you", facts);
  }

  changes(since: number): Recorded[] {
    return this.store.since(since);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private ownStrand(self: string | undefined): Strand | undefined {
    if (!self) return undefined;
    const now = this.now();
    const live = new Set([...this.presences.values()].filter((presence) => presence.until > now).flatMap((presence) => presence.strands));
    return [...this.model.strands.values()].find((strand) => strand.kind === "agent" && strand.place?.handle === self && live.has(strand.id));
  }

  private reportBraid(report: { braid?: string; dir?: string; self?: string }): string | undefined {
    if (report.braid) return braidRef(report.braid).id;
    if (this.ownStrand(report.self)?.braid) return this.ownStrand(report.self)!.braid;
    if (!report.dir) return undefined;
    const braidDirs = new Map([...this.model.braids.values()].flatMap((braid) => (braid.dir && braid.kind !== "side" ? [[braid.dir, braid.id] as const] : [])));
    return pointedBraid(report.dir, this.model.pointed) ?? pointedBraid(report.dir, braidDirs);
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
