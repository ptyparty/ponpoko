import type { Fact, PlayerKind, Recorded, ReplySaid, RequestSaid, Source, To, Whose } from "./events.ts";
import {
  activitiesOn,
  addresseeOf,
  agentStrandOf,
  ancestors,
  apply,
  blockers,
  children,
  counts,
  descendants,
  inboxRank,
  isBookkeeping,
  isLive,
  isUnseen,
  itemsOn,
  openMoves,
  openRequests,
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
  type Activity,
  type Item,
  type Player,
  type Request,
  type Standing,
  type Strand,
} from "./model.ts";
import type { Store } from "./store.ts";
import { epicChanges, epicFacts } from "./epics.ts";
import type { EpicStory } from "./shortcut.ts";

export type Space = { dir: string; strand?: string; handle?: string; label: string; short: string; players: string[] };
export type Presence = { adapter: string; scope: string; players: string[]; spaces: Space[] };
export type PlayerView = Player & { live: boolean; space?: string };
export type MoveView = Move & { by: PlayerView; answers?: PlayerView; links: Link[] };
export type RequestView = { id: string; to: string; toKind: string; what: string; kind?: string; from?: string; since: number; source: string; claimedBy?: string };
export type StandingView = Omit<Standing, "moves" | "items">;
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
  spaces: { label: string; short: string; handle?: string }[];
  dir?: string;
  agent?: PlayerView;
  requests: RequestView[];
};
export type Ended = Pick<Strand, "id" | "name" | "title" | "parent" | "kind" | "blockedOn" | "done">;
export type Snapshot = { now: number; counts: Counts; strands: StrandView[]; moves: StrandView[]; unseen: string[]; heard: Recorded[]; labels: Record<string, string>; ended?: Ended[] };
export type Knowledge = {
  strands: Strand[];
  closed: Strand[];
  players: Player[];
  open: Move[];
  links: Link[];
  on: Record<string, string>;
  resumed: Record<string, string>;
  spoke: string[];
  requests?: Request[];
  roles?: Record<string, Record<string, string>>;
  activities?: Activity[];
  whose?: Record<string, Whose>;
  forgotten?: { name: string; parent?: string; by: string }[];
};

export type Where = { self?: string; dir?: string; strand?: string };
export type LinkReport = { adapter: string; ref: string; label?: string };
export type StatusReport = Where & { text: string; page?: string; title?: string; link?: LinkReport };
export type Tour = { repo: string; name: string };
export type Named = string | { name: string; title?: string; tour?: Tour };
export type WaitReport = Where & { who?: string; kind?: "you" | "person" | "machine" | "group"; what?: string; over?: boolean };
export type BlockReport = Where & { on: string; over?: boolean };
export type ForReport = Where & { strand: string; player: string };
export const forAdapter = "player-for";

const presenceMs = 90_000;
const recentMoves = 12;

export class Ponpoko {
  readonly model: Model;
  private readonly listeners = new Set<() => void>();
  private readonly presences = new Map<string, Presence & { until: number }>();

  constructor(
    private readonly store: Store,
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
    for (const fact of facts) apply(this.model, this.store.append(source, fact, this.now()));
    const ended = facts.flatMap((fact) => (fact.type === "strand.done" ? [fact.strand] : []));
    for (const fact of ended.length > 0 ? this.followUps(ended) : []) apply(this.model, this.store.append("ponpoko", fact, this.now()));
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
    const live = (id: string) => {
      const strand = this.model.strands.get(id);
      return strand !== undefined && isLive(this.model, strand);
    };
    for (const move of [...moves].sort((a, b) => a.from - b.from)) {
      const player = move.with ?? move.player;
      if (this.model.players.get(move.player)?.kind !== "job") on[player] = move.strand;
      const resume = this.model.players.get(player)?.resume;
      if (resume && live(move.strand)) resumed[resume] = move.strand;
    }
    const roles: Record<string, Record<string, string>> = {};
    for (const [strand, filled] of this.model.roles) {
      if (!this.model.strands.has(strand)) continue;
      roles[strand] = filled;
      const agent = filled.agent;
      if (!agent || !live(strand)) continue;
      on[agent] = strand;
      const resume = this.model.players.get(agent)?.resume;
      if (resume) resumed[resume] = strand;
    }
    for (const activity of this.model.activities.values()) if (this.model.players.get(activity.player)?.kind === "job") on[activity.player] = activity.strand;
    return {
      strands: [...this.model.strands.values()].filter((strand) => isLive(this.model, strand)),
      closed: [...this.model.strands.values()].filter((strand) => strand.done !== undefined),
      players: [...this.model.players.values()].filter((player) => player.gone === undefined),
      open: moves.filter((move) => move.until === undefined),
      links: [...this.model.links.values()].filter((link) => link.adapter === "dir" || link.adapter === "komux" || link.adapter === forAdapter || link.adapter.startsWith("github") || link.adapter.startsWith("shortcut")),
      on,
      resumed,
      spoke: [...new Set([...this.model.spoken, ...moves.filter((move) => move.source === "agent" || (move.described !== undefined && move.player !== you)).map((move) => move.strand)])],
      requests: [...this.model.requests.values()].filter((request) => !request.closed),
      roles,
      activities: [...this.model.activities.values()],
      whose: Object.fromEntries([...this.model.strands.values()].flatMap((strand) => {
        const whose = isLive(this.model, strand) ? own(this.model, strand).whose : undefined;
        return whose ? [[strand.id, whose]] : [];
      })),
      forgotten: this.model.forgotten,
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
        const party = this.model.parties.get(id);
        const player = this.model.players.get(id) ?? { id, kind: (party && party.kind !== "service" ? "person" : "machine") as PlayerKind, who: party?.name ?? id, joined: 0 };
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
    const requestView = (request: Request, item?: Item): MoveView => {
      const addressee = item?.addressee ?? addresseeOf(this.model, request);
      const by = addressee.kind === "you" ? playerView(you) : this.model.players.has(addressee.id) ? playerView(addressee.id) : { id: addressee.id, kind: (addressee.kind === "group" ? "person" : addressee.kind) as PlayerKind, who: addressee.who, joined: 0, live: false };
      return {
        id: request.id,
        strand: request.strand,
        player: addressee.kind === "you" ? you : addressee.id,
        what: request.what,
        ...(request.kind ? { kind: request.kind } : {}),
        from: request.at,
        ...(request.closed ? { until: request.closed.at } : {}),
        source: request.source,
        ...(request.from ? { with: request.from, answers: playerView(request.from) } : {}),
        by,
        links: links.filter((link) => link.move === request.id),
      };
    };
    const activityView = (activity: Activity): MoveView => ({ id: `activity:${activity.player}`, strand: activity.strand, player: activity.player, what: activity.what ?? activity.activity, kind: activity.activity, from: activity.at, source: activity.source ?? "komux", by: playerView(activity.player), ...(activity.for ? { with: activity.for, answers: playerView(activity.for) } : {}), links: [] });
    const reportViews = (strand: string): MoveView[] => {
      const reports = this.model.reports.get(strand) ?? [];
      return reports.map((report, at) => ({ id: `report:${report.player}:${report.at}`, strand, player: report.player, what: report.what, kind: "report", from: report.at, ...(reports[at + 1] ? { until: reports[at + 1]!.at } : {}), source: "agent", by: playerView(report.player), links: [] }));
    };
    const itemView = (item: Item): MoveView => (item.request ? requestView(item.request, item) : item.move ? moveView(item.move) : activityView(item.activity!));
    const allMoves = [...this.model.moves.values()];
    const requestsBy = new Map<string, Request[]>();
    for (const request of this.model.requests.values()) requestsBy.set(request.strand, [...(requestsBy.get(request.strand) ?? []), request]);
    const view = (strand: Strand, depth: number): StrandView => {
      const { moves: _own, items: _ownItems, ...ownStanding } = own(this.model, strand);
      const { moves: _rolled, items: _rolledItems, ...rolledStanding } = rolled(this.model, strand);
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
        open: itemsOn(this.model, strand.id).map(itemView),
        recent: [...allMoves.filter((move) => move.strand === strand.id).map(moveView), ...(requestsBy.get(strand.id) ?? []).map((request) => requestView(request)), ...reportViews(strand.id)].sort((a, b) => a.from - b.from).slice(-recentMoves),
        links: strandLinks,
        unseen: ownStanding.whose === "you" && isUnseen(this.model, strand),
        spaces: spaces.filter((space) => space.strand === strand.id).map(({ label, short, handle }) => ({ label, short, ...(handle ? { handle } : {}) })),
        ...(dirs[0] ? { dir: dirs[0] } : {}),
        ...(this.model.roles.get(strand.id)?.agent && this.model.players.has(this.model.roles.get(strand.id)!.agent!) ? { agent: playerView(this.model.roles.get(strand.id)!.agent!) } : {}),
        requests: openRequests(this.model, strand.id).map((request): RequestView => {
          const to = addresseeOf(this.model, request);
          const claimed = request.progress ? (request.progress.by ? playerView(request.progress.by).who : "someone") : undefined;
          return { id: request.id, to: to.who, toKind: to.kind, what: request.what, ...(request.kind ? { kind: request.kind } : {}), ...(request.from ? { from: playerView(request.from).who } : {}), since: request.at, source: request.source, ...(claimed ? { claimedBy: claimed } : {}) };
        }),
      };
    };
    const tree: StrandView[] = [];
    const walk = (strand: Strand, depth: number) => {
      tree.push(view(strand, depth));
      const kids = children(this.model, strand.id).filter((candidate) => candidate.done === undefined);
      kids.sort(strand.kind === "inbox" ? (a, b) => inboxRank(this.model, a) - inboxRank(this.model, b) || a.made - b.made : (a, b) => a.made - b.made);
      for (const child of kids) walk(child, depth + 1);
    };
    const top = children(this.model, undefined).filter((strand) => strand.done === undefined);
    top.sort((a, b) => topOrder(this.model, a, now) - topOrder(this.model, b, now) || a.name.localeCompare(b.name));
    for (const strand of top) walk(strand, 0);
    const byId = new Map(tree.map((strand) => [strand.id, strand]));
    const moves = yourStrands(this.model, now).flatMap((strand) => byId.get(strand.id) ?? []);
    const heard = recentHeard(this.model, 100).filter((event) => event.type !== "link.removed" && !(event.type === "link.added" && isBookkeeping(event)));
    return {
      now,
      counts: counts(this.model, now),
      strands: tree,
      moves,
      unseen: moves.filter((strand) => strand.unseen).map((strand) => strand.id),
      heard,
      labels: this.labelsFor(heard),
      ended: [...this.model.strands.values()]
        .filter((strand) => strand.done !== undefined && strand.parent !== undefined && byId.get(strand.parent)?.kind === "epic")
        .map(({ id, name, title, parent, kind, blockedOn, done }) => ({ id, name, ...(title ? { title } : {}), ...(parent ? { parent } : {}), ...(kind ? { kind } : {}), blockedOn, ...(done !== undefined ? { done } : {}) })),
    };
  }

  status(report: StatusReport, source: Source = "agent"): string {
    const agent = this.agentOf(report.self);
    if (!agent) throw new Error("ponpoko doesn't see this agent in komux yet; try again once your turn is under way");
    const facts: Fact[] = [];
    const mine = this.homeOf(agent.id);
    const current = this.strandOf(agent.id);
    const target = report.strand ? this.resolve(report.strand, facts, current) : current;
    if (!target) throw new Error("name the strand you're working on, such as \"ponpoko review findings › 4\"");
    const loose = mine ? this.model.strands.get(mine) : undefined;
    const merging = loose?.kind === "loose" && loose.id !== target;
    const made = facts.some((fact) => fact.type === "strand.made" && fact.strand === target);
    if (mine && !merging && target !== mine && !this.isUnder(target, mine, facts)) {
      throw new Error(`${made ? report.strand : path(this.model, target).join(" › ")} isn't ${path(this.model, mine).join(" › ")} or under it, so it's another Claude's work: start a fresh Claude on it from ponpoko`);
    }
    this.titleFacts(target, report.title, facts);
    if (merging) facts.push({ type: "strand.merged", strand: loose!.id, into: target });
    if (!mine || merging) {
      for (const [strand, roles] of this.model.roles) if (roles.agent === agent.id && strand !== target) facts.push({ type: "strand.role", strand, role: "agent" });
      facts.push({ type: "strand.role", strand: target, role: "agent", by: agent.id });
    }
    for (const move of this.openMovesBy(agent.id)) facts.push({ type: "move.closed", move: move.id });
    facts.push({ type: "player.activity", player: agent.id, strand: target, activity: "working", what: report.text });
    if (report.page && ![...this.model.links.values()].some((link) => link.strand === target && link.adapter === "quoll" && link.ref === report.page)) facts.push({ type: "link.added", link: this.newId("l"), strand: target, adapter: "quoll", ref: report.page });
    if (report.link && ![...this.model.links.values()].some((link) => link.strand === target && link.adapter === report.link!.adapter && link.ref === report.link!.ref)) {
      facts.push({ type: "link.added", link: this.newId("l"), strand: target, adapter: report.link.adapter, ref: report.link.ref, ...(report.link.label ? { label: report.link.label } : {}) });
    }
    this.record(source, facts);
    return path(this.model, target).join(" › ");
  }

  private isUnder(strand: string, above: string, pending: Fact[]): boolean {
    const parents = new Map(pending.flatMap((fact) => (fact.type === "strand.made" ? [[fact.strand, fact.parent] as const] : [])));
    for (let at: string | undefined = strand, hops = 0; at !== undefined && hops < 100; hops++) {
      if (at === above) return true;
      at = parents.has(at) ? parents.get(at) : this.model.strands.get(at)?.parent;
    }
    return false;
  }

  wait(report: WaitReport, source: Source = "agent"): string {
    const agent = this.agentOf(report.self);
    const facts: Fact[] = [];
    const near = agent ? this.strandOf(agent.id) : undefined;
    const strand = report.strand ? (report.over ? this.named(report.strand, near) : this.resolve(report.strand, facts, near)) : this.whereIs(report, agent);
    if (!strand) throw new Error("name the strand this wait is on, such as \"sc-1234\"");
    if (report.over) return this.endWait(strand, report, agent, source);
    if (!report.who || !report.kind || !report.what) throw new Error("name who, kind and what, or the strand it waits on with on");
    const to = this.partyFacts(report.who, report.kind, facts);
    const key = JSON.stringify(to);
    for (const request of openRequests(this.model, strand)) if (JSON.stringify(request.to) === key && request.from === agent?.id && request.source === source) facts.push(said([], [{ request: request.id, as: "withdrawn" }]));
    facts.push(said([{ request: this.newId("r"), strand, to, what: report.what, kind: "ask", ...(agent ? { from: agent.id } : {}) }]));
    this.record(source, facts);
    return path(this.model, strand).join(" › ");
  }

  private partyFacts(who: string, kind: NonNullable<WaitReport["kind"]>, facts: Fact[]): To {
    if (kind === "you" || slug(who) === "you") return { person: you };
    const party = `${kind === "machine" ? "service" : kind}:${slug(who)}`;
    if (!this.model.parties.has(party)) facts.push({ type: "party.known", party, kind: kind === "machine" ? "service" : kind, name: who });
    return kind === "machine" ? { service: party } : kind === "group" ? { group: party } : { person: party };
  }

  private endWait(strand: string, report: WaitReport, agent: Player | undefined, source: Source): string {
    const facts: Fact[] = [];
    const named = report.who ? slug(report.who) : undefined;
    const parties = named === undefined ? undefined : named === "you" || report.kind === "you" ? [you] : report.kind ? [`${report.kind === "machine" ? "service" : report.kind}:${named}`] : ["person", "service", "group"].map((kind) => `${kind}:${named}`);
    const target = (to: To) => ("person" in to ? to.person : "service" in to ? to.service : "group" in to ? to.group : undefined);
    const requests = openRequests(this.model, strand).filter((request) => {
      if (request.source === "github" || request.source === "komux") return false;
      const id = target(request.to);
      if (id === undefined) return false;
      const mine = request.from === agent?.id;
      if (id === you && !mine) return false;
      if (parties) return parties.includes(id);
      const kind = id === you ? "you" : "service" in request.to ? "machine" : "group" in request.to ? "group" : "person";
      return mine && (report.kind === undefined || report.kind === kind);
    });
    const legacy = openMoves(this.model, strand).filter((move) => {
      if (move.source === "github" || move.source === "komux") return false;
      const kind = move.player === you ? "you" : this.model.players.get(move.player)?.kind;
      if (kind !== "you" && kind !== "person" && kind !== "machine") return false;
      const mine = move.with === agent?.id;
      if (move.player === you && !mine) return false;
      if (named !== undefined) return named === "you" ? move.player === you : (report.kind === "person" || report.kind === "machine" ? [`${report.kind}:${named}`] : [`person:${named}`, `machine:${named}`]).includes(move.player);
      return mine && (report.kind === undefined || report.kind === kind);
    });
    if (requests.length === 0 && legacy.length === 0) throw new Error(`no such wait: ${path(this.model, strand).join(" › ")} has no open wait${report.who ? ` on ${report.who}` : report.kind ? ` of kind ${report.kind}` : ""}`);
    if (requests.length > 0) facts.push(said([], requests.map((request) => ({ request: request.id, as: "done" as const }))));
    for (const move of legacy) facts.push({ type: "move.closed", move: move.id });
    this.record(source, facts);
    return path(this.model, strand).join(" › ");
  }

  workFor(report: ForReport, source: Source = "agent"): string {
    const agent = this.agentOf(report.self);
    const near = agent ? this.strandOf(agent.id) : this.whereIs({ dir: report.dir }, undefined);
    const strand = this.named(report.strand, near);
    const facts: Fact[] = [];
    if (![...this.model.links.values()].some((link) => link.strand === strand && link.adapter === forAdapter && link.ref === report.player)) {
      facts.push({ type: "link.added", link: this.newId("l"), strand, adapter: forAdapter, ref: report.player });
    }
    const activity = this.model.activities.get(report.player);
    if (activity && activity.strand !== strand) facts.push({ type: "player.activity", player: report.player, strand, activity: activity.activity, ...(activity.what ? { what: activity.what } : {}), ...(activity.for ? { for: activity.for } : {}) });
    this.record(source, facts);
    return path(this.model, strand).join(" › ");
  }

  blockBy(report: BlockReport, source: Source = "agent"): string {
    const agent = this.agentOf(report.self);
    const facts: Fact[] = [];
    const strand = report.strand ? this.resolve(report.strand, facts, agent ? this.strandOf(agent.id) : undefined) : this.whereIs(report, agent);
    if (!strand) throw new Error("name the strand that waits, such as \"sc-1234\"");
    if (report.over) {
      const on = this.named(report.on, strand);
      if (!(on in (this.model.strands.get(strand)?.blockedOn ?? {}))) throw new Error(`${path(this.model, strand).join(" › ")} doesn't wait on ${report.on}`);
      facts.push({ type: "strand.unblocked", strand, on });
    } else {
      this.blockFacts(strand, report.on, facts);
    }
    this.record(source, facts);
    return path(this.model, strand).join(" › ");
  }

  block(strand: string, on: string): string {
    this.mustHave(strand);
    const facts: Fact[] = [];
    const blocker = this.blockFacts(strand, on, facts);
    for (const move of openMoves(this.model, strand)) if (move.player === you) facts.push({ type: "move.closed", move: move.id });
    const yours = openRequests(this.model, strand).filter((request) => addresseeOf(this.model, request).kind === "you");
    if (yours.length > 0) facts.push(said([], yours.map((request) => ({ request: request.id, as: "done" as const }))));
    this.record("you", facts);
    return blocker;
  }

  unblock(strand: string, on?: string): void {
    const waiting = Object.keys(this.mustHave(strand).blockedOn).filter((id) => on === undefined || id === on);
    this.record("you", waiting.map((id) => ({ type: "strand.unblocked", strand, on: id })));
  }

  private blockFacts(strand: string, on: string, facts: Fact[]): string {
    const blocker = this.named(on, strand);
    if (blocker === strand) throw new Error("a strand can't wait on itself");
    if (blockers(this.model, blocker).includes(strand)) throw new Error("those strands would wait on each other");
    facts.push({ type: "strand.blocked", strand, on: blocker });
    return blocker;
  }

  doneBy(where: Where, why: string, source: Source = "agent"): string {
    const agent = this.agentOf(where.self);
    const facts: Fact[] = [];
    const near = agent ? this.strandOf(agent.id) : undefined;
    const strand = where.strand ? this.find(where.strand, near) : this.whereIs(where, agent);
    if (!strand) throw new Error(where.strand ? this.unknown(where.strand, near) : "name the strand that's done");
    this.finish(strand, why, facts);
    const name = path(this.model, strand).join(" › ");
    this.record(source, facts);
    return name;
  }

  split(where: Where, names: Named[], source: Source = "agent"): string[] {
    const agent = this.agentOf(where.self);
    const facts: Fact[] = [];
    const parent = where.strand ? this.resolve(where.strand, facts, agent ? this.strandOf(agent.id) : undefined) : this.whereIs(where, agent);
    if (!parent) throw new Error("name the strand to split, such as \"ponpoko review findings\"");
    const made = names.map((named) => {
      const { name, title, tour } = typeof named === "string" ? { name: named, title: undefined, tour: undefined } : named;
      const id = this.resolveUnder(parent, [name.trim()], facts);
      this.titleFacts(id, title, facts);
      if (tour) this.tourFacts(id, tour, facts);
      return id;
    });
    this.record(source, facts);
    return made.map((id) => path(this.model, id).join(" › "));
  }

  private tourFacts(strand: string, tour: Tour, facts: Fact[]): void {
    const ref = tourRef(tour);
    const linked = [...this.model.links.values()].some((link) => link.strand === strand && link.adapter === "remax" && link.ref === ref);
    if (!linked) facts.push({ type: "link.added", link: this.newId("l"), strand, adapter: "remax", ref, label: tour.name });
    const what = `review the ${tour.name} tour in remax`;
    const asked = openRequests(this.model, strand).some((request) => request.kind === "tour" && request.what === what);
    if (!asked) facts.push(said([{ request: this.newId("r"), strand, to: { person: you }, what, kind: "tour" }]));
  }

  add(parent: string | undefined, name: string): string {
    const facts: Fact[] = [];
    const id = parent ? this.resolveUnder(this.mustHave(parent).id, splitPath(name), facts) : this.resolve(name, facts, undefined);
    this.record("you", facts);
    return id;
  }

  rename(strand: string, name: string): void {
    this.mustHave(strand);
    const trimmed = name.trim();
    if (trimmed === "" || splitPath(trimmed).length !== 1) throw new Error("name the strand with a single name, without ›");
    this.record("you", [{ type: "strand.renamed", strand, name: trimmed }]);
  }

  title(strand: string, title: string): void {
    const trimmed = title.trim();
    if (trimmed !== (this.mustHave(strand).title ?? "")) this.record("you", [{ type: "strand.titled", strand, title: trimmed }]);
  }

  reparent(strand: string, to: string): string {
    const moving = this.mustHave(strand);
    const facts: Fact[] = [];
    if (to.trim() === "") {
      facts.push({ type: "strand.parented", strand });
      this.record("you", facts);
      return strand;
    }
    const target = this.model.strands.has(to) ? to : this.resolve(to, facts, undefined);
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
    const request = this.model.requests.get(move);
    if (request) {
      const facts: Fact[] = request.closed ? [] : [said([], [{ request: move, as: "done" }])];
      const job = request.from ? this.model.players.get(request.from) : undefined;
      if (job?.kind === "job" && job.gone === undefined) facts.push({ type: "player.gone", player: job.id, why: "you went to it" });
      if (job?.kind === "job" && this.model.strands.get(request.strand)?.kind === "loose") facts.push({ type: "strand.forgotten", strand: request.strand });
      this.record("you", facts);
      return;
    }
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

  importEpic(strand: string, epic: number, stories: EpicStory[]): string {
    this.mustHave(strand);
    const facts = epicFacts(this.knowledge(), strand, epic, stories, this.newId);
    this.record("shortcut", facts);
    return epicChanges(facts);
  }

  start(strand: string): void {
    if (this.mustHave(strand).planned) this.record("you", [{ type: "strand.planned", strand, planned: false }]);
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
    const answered = all.flatMap((id) => openRequests(this.model, id)).map((request): ReplySaid => ({ request: request.id, as: "done" }));
    if (answered.length > 0) facts.push(said([], answered));
    for (const id of all) for (const move of openMoves(this.model, id)) facts.push({ type: "move.closed", move: move.id });
    for (const id of all) for (const activity of activitiesOn(this.model, id)) facts.push({ type: "player.activity", player: activity.player, activity: "idle" });
    for (const id of [...all].reverse()) facts.push({ type: "strand.done", strand: id, why });
  }

  private followUps(finished: string[]): Fact[] {
    const asks: RequestSaid[] = [];
    const finishing = new Set(finished);
    const names = (ids: string[]) => ids.map((id) => this.model.strands.get(id)?.name ?? id).join(", ");
    const settled = (id: string) => openRequests(this.model, id).some((request) => request.kind === "close" || request.kind === "unblocked");
    const parents = new Set(finished.flatMap((id) => this.model.strands.get(id)?.parent ?? []).filter((id) => !finishing.has(id)));
    for (const id of parents) {
      const parent = this.model.strands.get(id);
      if (!parent || parent.done !== undefined || parent.kind === "inbox" || settled(id) || !children(this.model, id).every((child) => child.done !== undefined)) continue;
      asks.push({ request: this.newId("r"), strand: id, to: { role: "owner", strand: id }, what: "parts done: close it?", kind: "close" });
    }
    for (const other of this.model.strands.values()) {
      const ended = Object.keys(other.blockedOn).filter((on) => finishing.has(on));
      if (other.done !== undefined || ended.length === 0 || settled(other.id)) continue;
      const still = Object.keys(other.blockedOn).filter((on) => this.model.strands.get(on)?.done === undefined);
      const quiet = openRequests(this.model, other.id).length === 0 && openMoves(this.model, other.id).length === 0 && activitiesOn(this.model, other.id).length === 0;
      if (still.length === 0 && !other.planned && quiet) asks.push({ request: this.newId("r"), strand: other.id, to: { role: "owner", strand: other.id }, what: `${names(ended)} ${ended.length === 1 ? "is" : "are"} done`, kind: "unblocked" });
    }
    return asks.length > 0 ? [said(asks)] : [];
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  labelsFor(heard: Recorded[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const event of heard) {
      for (const key of ["strand", "into", "parent", "on"] as const) {
        const id = (event as Record<string, unknown>)[key];
        if (typeof id === "string") out[id] = this.model.names.get(id) ?? id;
      }
      for (const key of ["player", "with"] as const) {
        const id = (event as Record<string, unknown>)[key];
        if (typeof id === "string") out[id] = this.model.players.get(id)?.who ?? id;
      }
      if (event.type === "said") {
        for (const asked of event.requests) out[asked.request] = `${asked.what} on ${this.model.names.get(asked.strand) ?? asked.strand}`;
        for (const reply of event.replies) {
          const request = this.model.requests.get(reply.request);
          if (request) out[reply.request] = `${request.what} on ${this.model.names.get(request.strand) ?? request.strand}`;
        }
        for (const to of [...event.requests.map((asked) => asked.to), ...event.replies.flatMap((reply) => reply.to ?? [])]) for (const id of Object.values(to)) out[id] ??= this.model.names.get(id) ?? this.model.parties.get(id)?.name ?? this.model.players.get(id)?.who ?? id;
      }
      if (event.type === "handed") for (const id of event.requests) out[id] = this.model.requests.get(id)?.what ?? id;
      if (event.type === "strand.role" && event.by) out[event.by] = this.model.players.get(event.by)?.who ?? this.model.parties.get(event.by)?.name ?? event.by;
      if (event.type === "party.merged") for (const id of [event.party, event.into]) out[id] = this.model.parties.get(id)?.name ?? id;
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
    const home = this.homeOf(player);
    const working = this.model.activities.get(player)?.strand;
    const live = working !== undefined && this.model.strands.has(working) && isLive(this.model, this.model.strands.get(working)!);
    return live && (home === undefined || this.isUnder(working, home, [])) ? working : home;
  }

  private homeOf(player: string): string | undefined {
    const role = agentStrandOf(this.model, player);
    if (role) return role;
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

  private named(text: string, near: string | undefined): string {
    if (this.model.strands.has(text)) return text;
    const found = this.find(text, near);
    if (found) return found;
    const wanted = splitPath(text).map((name) => name.toLowerCase());
    const ending = [...this.model.strands.values()].filter((strand) => {
      const names = path(this.model, strand.id).slice(-wanted.length).map((name) => name.toLowerCase());
      return isLive(this.model, strand) && names.length === wanted.length && names.every((name, at) => name === wanted[at]);
    });
    if (ending.length === 1) return ending[0]!.id;
    throw new Error(ending.length === 0 ? this.unknown(text, near) : `${text} could be ${ending.length} strands; give more of its path`);
  }

  private unknown(text: string, near: string | undefined): string {
    const nearest = this.nearest(text, near);
    return `ponpoko knows of no strand ${text}${nearest ? `; the nearest is ${path(this.model, nearest).join(" › ")}` : ""}`;
  }

  nearest(text: string, near: string | undefined): string | undefined {
    const wanted = splitPath(text).map((name) => name.toLowerCase());
    const last = wanted.at(-1);
    if (!last) return undefined;
    const close = new Set(near && this.model.strands.has(near) ? [near, ...ancestors(this.model, near), ...descendants(this.model, near)] : []);
    const scored = [...this.model.strands.values()].filter((strand) => isLive(this.model, strand)).flatMap((strand) => {
      const name = strand.name.toLowerCase();
      const title = strand.title?.toLowerCase() ?? "";
      const above = path(this.model, strand.id).slice(0, -1).map((segment) => segment.toLowerCase());
      const base = name === last ? 0 : name.includes(last) || last.includes(name) || (title !== "" && title.includes(last)) ? 1 : distance(name, last) <= Math.max(2, Math.floor(last.length / 4)) ? 2 : undefined;
      if (base === undefined) return [];
      const shared = wanted.slice(0, -1).filter((segment) => above.includes(segment)).length;
      return [{ strand: strand.id, score: base * 10 - shared * 3 - (close.has(strand.id) ? 2 : 0) }];
    });
    return scored.sort((a, b) => a.score - b.score)[0]?.strand;
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

  private titleFacts(strand: string, title: string | undefined, facts: Fact[]): void {
    const trimmed = title?.trim();
    if (trimmed && trimmed !== this.model.strands.get(strand)?.title) facts.push({ type: "strand.titled", strand, title: trimmed });
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
}

function topOrder(model: Model, strand: Strand, now: number): number {
  const standing = rolled(model, strand);
  return standing.whose === "you" && !((strand.snoozedUntil ?? 0) > now) ? standing.since : Number.MAX_SAFE_INTEGER;
}

export function underOf(strands: StrandView[], strand: StrandView): StrandView[] {
  const at = strands.findIndex((candidate) => candidate.id === strand.id);
  if (at < 0) return [];
  const end = strands.findIndex((candidate, index) => index > at && candidate.depth <= strand.depth);
  return strands.slice(at + 1, end < 0 ? undefined : end);
}

export function aboveOf(strands: StrandView[], strand: StrandView): StrandView[] {
  const byId = new Map(strands.map((candidate) => [candidate.id, candidate]));
  const out: StrandView[] = [];
  for (let at = strand.parent ? byId.get(strand.parent) : undefined; at && !out.includes(at); at = at.parent ? byId.get(at.parent) : undefined) out.push(at);
  return out;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
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

export function tourRef(tour: Tour): string {
  return JSON.stringify({ repo: tour.repo, name: tour.name });
}

export function readTourRef(ref: string): Tour | undefined {
  try {
    const parsed = JSON.parse(ref) as Partial<Tour>;
    return typeof parsed.repo === "string" && typeof parsed.name === "string" ? { repo: parsed.repo, name: parsed.name } : undefined;
  } catch {
    return undefined;
  }
}

function said(requests: RequestSaid[], replies: ReplySaid[] = []): Fact {
  return { type: "said", requests, replies };
}

