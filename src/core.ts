import type { Fact, PlayerKind, Recorded, Source } from "./events.ts";
import {
  ancestors,
  apply,
  children,
  counts,
  descendants,
  isLive,
  isUnseen,
  openMoves,
  own,
  path,
  recentHeard,
  replay,
  rolled,
  you,
  yourStrands,
  type Counts,
  type Link,
  type Model,
  type Move,
  type Player,
  type Standing,
  type Strand,
} from "./model.ts";
import type { Store } from "./store.ts";

export type Space = { dir: string; strand?: string; label: string; short: string; players: string[] };
export type Presence = { adapter: string; scope: string; players: string[]; spaces: Space[] };
export type PlayerView = Player & { live: boolean; space?: string };
export type MoveView = Move & { by: PlayerView; answers?: PlayerView; links: Link[] };
export type StandingView = Omit<Standing, "moves">;
export type StrandView = Strand & {
  path: string[];
  above: { name: string; title?: string; kind?: string }[];
  depth: number;
  own: StandingView;
  rolled: StandingView;
  open: MoveView[];
  recent: MoveView[];
  links: Link[];
  unseen: boolean;
  spaces: { label: string; short: string }[];
  dir?: string;
};
export type Snapshot = { now: number; counts: Counts; strands: StrandView[]; moves: StrandView[]; unseen: string[]; heard: Recorded[]; labels: Record<string, string> };
export type Knowledge = { strands: Strand[]; closed: Strand[]; players: Player[]; open: Move[]; links: Link[]; on: Record<string, string>; resumed: Record<string, string>; spoke: string[] };

export type Where = { self?: string; dir?: string; strand?: string };
export type StatusReport = Where & { text: string; page?: string };
export type WaitReport = Where & { who: string; kind: "you" | "person" | "machine"; what: string; over?: boolean };

const presenceMs = 90_000;
const recentMoves = 12;

export class Ponpoko {
  readonly model: Model;
  private readonly listeners = new Set<() => void>();
  private readonly titleAsked = new Set<string>();
  private readonly presences = new Map<string, Presence & { until: number }>();

  constructor(
    private readonly store: Store,
    private readonly lookupTitle: (name: string) => Promise<{ kind: "story" | "epic"; title: string } | undefined> = shortcutTitle,
    private readonly now: () => number = Date.now,
    private readonly newId: (prefix: string) => string = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`,
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
      if (fact.type === "strand.made" && fact.parent === undefined) this.askTitle(fact.strand);
    }
    this.changed();
  }

  present(presence: Presence): void {
    const key = `${presence.adapter}:${presence.scope}`;
    const before = this.presences.get(key);
    this.presences.set(key, { ...presence, until: this.now() + presenceMs });
    const lapsed = before !== undefined && before.until <= this.now();
    if (!before || lapsed || JSON.stringify([before.players, before.spaces]) !== JSON.stringify([presence.players, presence.spaces])) this.changed();
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
    const moves = [...this.model.moves.values()];
    const on: Record<string, string> = {};
    const resumed: Record<string, string> = {};
    for (const move of [...moves].sort((a, b) => a.from - b.from)) {
      const player = move.with ?? move.player;
      on[player] = move.strand;
      const resume = this.model.players.get(player)?.resume;
      const strand = this.model.strands.get(move.strand);
      if (resume && strand && isLive(this.model, strand)) resumed[resume] = move.strand;
    }
    return {
      strands: [...this.model.strands.values()].filter((strand) => isLive(this.model, strand)),
      closed: [...this.model.strands.values()].filter((strand) => strand.done !== undefined),
      players: [...this.model.players.values()].filter((player) => player.gone === undefined),
      open: moves.filter((move) => move.until === undefined),
      links: [...this.model.links.values()].filter((link) => link.adapter === "dir" || link.adapter === "komux"),
      on,
      resumed,
      spoke: [...new Set(moves.filter((move) => move.source === "agent" || (move.described !== undefined && move.player !== you)).map((move) => move.strand))],
    };
  }

  snapshot(): Snapshot {
    const now = this.now();
    const present = [...this.presences.values()].filter((presence) => presence.until > now);
    const live = new Set(present.flatMap((presence) => presence.players));
    const spaces = present.flatMap((presence) => presence.spaces);
    const players = new Map<string, PlayerView>();
    const playerView = (id: string): PlayerView => {
      let view = players.get(id);
      if (!view) {
        const player = this.model.players.get(id) ?? { id, kind: "machine" as PlayerKind, who: id, joined: 0 };
        const space = spaces.find((candidate) => candidate.players.includes(id))?.label;
        view = { ...player, live: id === you || live.has(id), ...(space ? { space } : {}) };
        players.set(id, view);
      }
      return view;
    };
    const links = [...this.model.links.values()];
    const moveView = (move: Move): MoveView => ({
      ...move,
      by: playerView(move.player),
      ...(move.with ? { answers: playerView(move.with) } : {}),
      links: links.filter((link) => link.move === move.id),
    });
    const allMoves = [...this.model.moves.values()];
    const view = (strand: Strand, depth: number): StrandView => {
      const { moves: _own, ...ownStanding } = own(this.model, strand);
      const { moves: _rolled, ...rolledStanding } = rolled(this.model, strand);
      const strandLinks = links.filter((link) => link.strand === strand.id);
      const dirs = [strand.id, ...ancestors(this.model, strand.id)].flatMap((id) => links.filter((link) => link.strand === id && link.adapter === "dir").map((link) => link.ref));
      return {
        ...strand,
        path: path(this.model, strand.id),
        above: ancestors(this.model, strand.id).flatMap((id) => {
          const above = this.model.strands.get(id);
          return above ? [{ name: above.name, ...(above.title ? { title: above.title } : {}), ...(above.kind ? { kind: above.kind } : {}) }] : [];
        }),
        depth,
        own: ownStanding,
        rolled: rolledStanding,
        open: openMoves(this.model, strand.id).map(moveView),
        recent: allMoves.filter((move) => move.strand === strand.id).sort((a, b) => a.from - b.from).slice(-recentMoves).map(moveView),
        links: strandLinks,
        unseen: ownStanding.whose === "you" && isUnseen(this.model, strand),
        spaces: spaces.filter((space) => space.strand === strand.id).map(({ label, short }) => ({ label, short })),
        ...(dirs[0] ? { dir: dirs[0] } : {}),
      };
    };
    const tree: StrandView[] = [];
    const walk = (strand: Strand, depth: number) => {
      tree.push(view(strand, depth));
      for (const child of children(this.model, strand.id).filter((candidate) => candidate.done === undefined).sort((a, b) => a.made - b.made)) walk(child, depth + 1);
    };
    const top = children(this.model, undefined).filter((strand) => strand.done === undefined);
    top.sort((a, b) => topOrder(this.model, a, now) - topOrder(this.model, b, now) || a.name.localeCompare(b.name));
    for (const strand of top) walk(strand, 0);
    const byId = new Map(tree.map((strand) => [strand.id, strand]));
    const moves = yourStrands(this.model, now).flatMap((strand) => byId.get(strand.id) ?? []);
    const heard = recentHeard(this.model, 30);
    return {
      now,
      counts: counts(this.model, now),
      strands: tree,
      moves,
      unseen: moves.filter((strand) => strand.unseen).map((strand) => strand.id),
      heard,
      labels: this.labelsFor(heard),
    };
  }

  status(report: StatusReport, source: Source = "agent"): string {
    const agent = this.agentOf(report.self);
    if (!agent) throw new Error("ponpoko doesn't see this agent in komux yet; try again once your turn is under way");
    const current = this.openMovesBy(agent.id).at(-1);
    const facts: Fact[] = [];
    const target = report.strand ? this.resolve(report.strand, facts, this.strandOf(agent.id)) : this.strandOf(agent.id);
    if (!target) throw new Error("name the strand you're working on, such as \"ponpoko review findings › 4\"");
    const loose = current ? this.model.strands.get(current.strand) : undefined;
    const merging = loose?.kind === "loose" && loose.id !== target;
    if (merging) facts.push({ type: "strand.merged", strand: loose!.id, into: target });
    let move: string;
    if (current && (current.strand === target || merging) && current.described === undefined && current.source !== "agent") {
      move = current.id;
      facts.push({ type: "move.described", move, what: report.text });
    } else {
      if (current) facts.push({ type: "move.closed", move: current.id });
      move = this.newId("m");
      facts.push({ type: "move.opened", move, strand: target, player: agent.id, what: report.text });
    }
    if (report.page) facts.push({ type: "link.added", link: this.newId("l"), move, adapter: "quoll", ref: report.page });
    this.record(source, facts);
    return path(this.model, target).join(" › ");
  }

  wait(report: WaitReport, source: Source = "agent"): string {
    const agent = this.agentOf(report.self);
    const facts: Fact[] = [];
    const strand = report.strand ? this.resolve(report.strand, facts, agent ? this.strandOf(agent.id) : undefined) : this.whereIs(report, agent);
    if (!strand) throw new Error("name the strand this wait is on, such as \"sc-1234\"");
    const player = report.kind === "you" ? you : `${report.kind}:${slug(report.who)}`;
    const open = [...this.model.moves.values()].filter((move) => move.player === player && move.strand === strand && move.until === undefined && (player !== you || move.with === agent?.id));
    if (report.over) {
      for (const move of open) facts.push({ type: "move.closed", move: move.id });
      const elsewhere = [...this.model.moves.values()].some((move) => move.player === player && move.strand !== strand && move.until === undefined);
      if (player !== you && !elsewhere) facts.push({ type: "player.gone", player, why: "wait over" });
    } else {
      if (player !== you && (!this.model.players.has(player) || this.model.players.get(player)!.gone !== undefined)) facts.push({ type: "player.joined", player, kind: report.kind, who: report.who });
      for (const move of open) facts.push({ type: "move.closed", move: move.id });
      facts.push({ type: "move.opened", move: this.newId("m"), strand, player, ...(agent ? { with: agent.id } : {}), what: report.what });
    }
    this.record(source, facts);
    return path(this.model, strand).join(" › ");
  }

  doneBy(where: Where, why: string, source: Source = "agent"): string {
    const agent = this.agentOf(where.self);
    const facts: Fact[] = [];
    const strand = where.strand ? this.find(where.strand, agent ? this.strandOf(agent.id) : undefined) : this.whereIs(where, agent);
    if (!strand) throw new Error(where.strand ? `no strand ${where.strand}` : "name the strand that's done");
    this.finish(strand, why, facts);
    const name = path(this.model, strand).join(" › ");
    this.record(source, facts);
    return name;
  }

  split(where: Where, names: string[], source: Source = "agent"): string[] {
    const agent = this.agentOf(where.self);
    const facts: Fact[] = [];
    const parent = where.strand ? this.resolve(where.strand, facts, agent ? this.strandOf(agent.id) : undefined) : this.whereIs(where, agent);
    if (!parent) throw new Error("name the strand to split, such as \"ponpoko review findings\"");
    const made = names.map((name) => this.resolveUnder(parent, [name.trim()], facts));
    this.record(source, facts);
    return made.map((id) => path(this.model, id).join(" › "));
  }

  add(parent: string | undefined, name: string): string {
    const facts: Fact[] = [];
    const id = parent ? this.resolveUnder(this.mustHave(parent).id, splitPath(name), facts) : this.resolve(name, facts, undefined);
    this.record("you", facts);
    return id;
  }

  reparent(strand: string, to: string): string {
    const moving = this.mustHave(strand);
    const facts: Fact[] = [];
    if (to.trim() === "") {
      facts.push({ type: "strand.parented", strand });
      this.record("you", facts);
      return strand;
    }
    const target = this.resolve(to, facts, undefined);
    if (target === strand || ancestors(this.model, target).includes(strand)) throw new Error("a strand can't go under itself");
    facts.push(moving.kind === "loose" ? { type: "strand.merged", strand, into: target } : { type: "strand.parented", strand, parent: target });
    this.record("you", facts);
    return target;
  }

  done(strand: string, why = "you marked it done"): void {
    this.mustHave(strand);
    const facts: Fact[] = [];
    this.finish(strand, why, facts);
    this.record("you", facts);
  }

  closeMove(move: string): void {
    const found = this.model.moves.get(move);
    if (!found) throw new Error(`no move ${move}`);
    const facts: Fact[] = [];
    if (found.until === undefined) facts.push({ type: "move.closed", move });
    const answers = found.with ? this.model.players.get(found.with) : undefined;
    if (answers?.kind === "job" && answers.gone === undefined) facts.push({ type: "player.gone", player: answers.id, why: "you went to it" });
    const strand = this.model.strands.get(found.strand);
    if (answers?.kind === "job" && strand?.kind === "loose") facts.push({ type: "strand.forgotten", strand: strand.id });
    this.record("you", facts);
  }

  seen(strand: string): void {
    this.mustHave(strand);
    this.record("you", [{ type: "strand.seen", strand }]);
  }

  forget(strand: string): void {
    this.mustHave(strand);
    this.record("you", [{ type: "strand.forgotten", strand }]);
  }

  snooze(strand: string, until: number): void {
    this.mustHave(strand);
    this.record("you", [{ type: "strand.snoozed", strand, until }]);
  }

  note(strand: string, text: string): void {
    this.mustHave(strand);
    this.record("you", [{ type: "strand.note", strand, text }]);
  }

  point(dir: string, to: string): string {
    const facts: Fact[] = [];
    const target = this.resolve(to, facts, undefined);
    facts.push({ type: "link.added", link: this.newId("l"), strand: target, adapter: "dir", ref: dir });
    const on = this.knowledge().on;
    for (const player of this.model.players.values()) {
      const at = player.place?.dir;
      const strand = on[player.id] ? this.model.strands.get(on[player.id]!) : undefined;
      if (!strand || strand.kind !== "loose" || typeof at !== "string" || (at !== dir && !at.startsWith(`${dir}/`))) continue;
      if (!facts.some((fact) => fact.type === "strand.merged" && fact.strand === strand.id)) facts.push({ type: "strand.merged", strand: strand.id, into: target });
    }
    this.record("you", facts);
    return target;
  }

  changes(since: number): { events: Recorded[]; labels: Record<string, string> } {
    const events = this.store.since(since);
    return { events, labels: this.labelsFor(events) };
  }

  private finish(strand: string, why: string, facts: Fact[]): void {
    const all = [strand, ...descendants(this.model, strand)].filter((id) => this.model.strands.get(id)?.done === undefined);
    for (const id of all) for (const move of openMoves(this.model, id)) facts.push({ type: "move.closed", move: move.id });
    for (const id of all.reverse()) facts.push({ type: "strand.done", strand: id, why });
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  labelsFor(heard: Recorded[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const event of heard) {
      for (const key of ["strand", "into", "parent"] as const) {
        const id = (event as Record<string, unknown>)[key];
        if (typeof id === "string") out[id] = this.model.names.get(id) ?? id;
      }
      for (const key of ["player", "with"] as const) {
        const id = (event as Record<string, unknown>)[key];
        if (typeof id === "string") out[id] = this.model.players.get(id)?.who ?? id;
      }
      if ("move" in event && typeof event.move === "string") {
        const move = this.model.moves.get(event.move);
        if (move) out[event.move] = `${this.model.players.get(move.player)?.who ?? move.player} on ${this.model.names.get(move.strand) ?? move.strand}`;
      }
    }
    return out;
  }

  private agentOf(self: string | undefined): Player | undefined {
    if (!self) return undefined;
    const now = this.now();
    const live = new Set([...this.presences.values()].filter((presence) => presence.until > now).flatMap((presence) => presence.players));
    const candidates = [...this.model.players.values()].filter((player) => player.kind === "agent" && player.gone === undefined && player.place?.handle === self);
    return candidates.find((player) => live.has(player.id)) ?? candidates[0];
  }

  private openMovesBy(player: string): Move[] {
    return [...this.model.moves.values()].filter((move) => move.player === player && move.until === undefined && this.model.strands.has(move.strand)).sort((a, b) => a.from - b.from);
  }

  private strandOf(player: string): string | undefined {
    const moves = [...this.model.moves.values()].filter((move) => (move.with ?? move.player) === player && this.model.strands.has(move.strand) && isLive(this.model, this.model.strands.get(move.strand)!)).sort((a, b) => a.from - b.from);
    return moves.at(-1)?.strand;
  }

  private whereIs(where: Where, agent: Player | undefined): string | undefined {
    const on = agent ? this.strandOf(agent.id) : undefined;
    if (on) return on;
    if (!where.dir) return undefined;
    let best: { length: number; strand: string } | undefined;
    for (const link of this.model.links.values()) {
      if (link.adapter !== "dir" || !link.strand || !this.model.strands.has(link.strand)) continue;
      if ((where.dir === link.ref || where.dir.startsWith(`${link.ref}/`)) && (!best || link.ref.length > best.length)) best = { length: link.ref.length, strand: link.strand };
    }
    return best?.strand;
  }

  private find(text: string, near: string | undefined): string | undefined {
    const segments = splitPath(text);
    for (const root of this.roots(near)) {
      const found = this.walk(root, segments);
      if (found.matched === segments.length) return found.at;
    }
    return undefined;
  }

  private resolve(text: string, facts: Fact[], near: string | undefined): string {
    const segments = splitPath(text);
    if (segments.length === 0) throw new Error("name a strand");
    if (/^\s*[›>]/.test(text)) return this.resolveUnder(undefined, segments, facts);
    let best: { root: string | undefined; matched: number; at: string | undefined } = { root: undefined, matched: 0, at: undefined };
    for (const root of this.roots(near)) {
      const found = this.walk(root, segments);
      if (found.matched === segments.length) return found.at!;
      if (found.matched > best.matched) best = { root, ...found };
    }
    const home = near && this.model.strands.get(near)?.kind !== "loose" ? near : undefined;
    const base = best.matched > 0 ? best.at : home;
    return this.resolveUnder(base, segments.slice(best.matched), facts);
  }

  private resolveUnder(parent: string | undefined, segments: string[], facts: Fact[]): string {
    let at = parent;
    for (const name of segments) {
      const existing = this.childNamed(at, name, facts);
      if (existing) {
        at = existing;
        continue;
      }
      const id = this.newId("s");
      facts.push({ type: "strand.made", strand: id, name, ...(at ? { parent: at } : {}) });
      at = id;
    }
    return at!;
  }

  private childNamed(parent: string | undefined, name: string, pending: Fact[] = []): string | undefined {
    const wanted = name.toLowerCase();
    const found = children(this.model, parent).find((strand) => strand.done === undefined && strand.name.toLowerCase() === wanted);
    if (found) return found.id;
    const made = pending.find((fact) => fact.type === "strand.made" && fact.parent === parent && fact.name.toLowerCase() === wanted);
    return made?.type === "strand.made" ? made.strand : undefined;
  }

  private roots(near: string | undefined): (string | undefined)[] {
    const chain = near && this.model.strands.has(near) ? [near, ...ancestors(this.model, near)] : [];
    return [...chain, undefined];
  }

  private walk(root: string | undefined, segments: string[]): { matched: number; at: string | undefined } {
    let at = root;
    let matched = 0;
    for (const name of segments) {
      const next = this.childNamed(at, name);
      if (!next) break;
      at = next;
      matched++;
    }
    return { matched, at };
  }

  private mustHave(id: string): Strand {
    const strand = this.model.strands.get(id);
    if (!strand) throw new Error(`no strand ${id}`);
    return strand;
  }

  private askTitle(strand: string): void {
    const name = this.model.strands.get(strand)?.name;
    if (!name || storyNumber(name) === undefined || this.titleAsked.has(strand) || this.model.strands.get(strand)?.title) return;
    this.titleAsked.add(strand);
    void this.lookupTitle(name)
      .then((found) => {
        if (found && this.model.strands.has(strand)) this.record("ponpoko", [{ type: "strand.titled", strand, ...found }]);
      })
      .catch(() => undefined);
  }
}

function topOrder(model: Model, strand: Strand, now: number): number {
  const standing = rolled(model, strand);
  return standing.whose === "you" && !((strand.snoozedUntil ?? 0) > now) ? standing.since : Number.MAX_SAFE_INTEGER;
}

export function aboveOf(strands: StrandView[], strand: StrandView): StrandView[] {
  const byId = new Map(strands.map((candidate) => [candidate.id, candidate]));
  const out: StrandView[] = [];
  for (let at = strand.parent ? byId.get(strand.parent) : undefined; at && !out.includes(at); at = at.parent ? byId.get(at.parent) : undefined) out.push(at);
  return out;
}

export function splitPath(text: string): string[] {
  return text
    .split(/\s*[›>]\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9#]+/g, "-").replace(/^-|-$/g, "") || "someone";
}

export function storyNumber(name: string): number | undefined {
  const match = /^sc-(\d+)$/i.exec(name);
  return match ? Number(match[1]) : undefined;
}

export async function shortcutTitle(name: string): Promise<{ kind: "story" | "epic"; title: string } | undefined> {
  const number = storyNumber(name);
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
