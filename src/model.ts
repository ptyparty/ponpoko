import type { ActivityKind, Place, PlayerKind, Recorded, ReplyKind, To, Whose } from "./events.ts";

export type Strand = {
  id: string;
  name: string;
  parent?: string;
  kind?: string;
  title?: string;
  made: number;
  done?: number;
  seenAt: number;
  dismissedAt: number;
  snoozedUntil?: number;
  planned?: boolean;
  heldBy?: Record<string, number>;
  madeBy?: string;
  blockedOn: Record<string, number>;
  released?: Record<string, number>;
  notes: { at: number; text: string }[];
};
export type Player = { id: string; kind: PlayerKind; who: string; adapter?: string; place?: Place; resume?: string; joined: number; gone?: number };
export type Move = { id: string; strand: string; player: string; with?: string; what: string; kind?: string; from: number; until?: number; source: Recorded["source"]; described?: number };
export type Link = { id: string; strand?: string; move?: string; adapter: string; ref: string; label?: string; at: number };
export type Request = {
  id: string;
  strand: string;
  to: To;
  what: string;
  kind?: string;
  ref?: string;
  from?: string;
  at: number;
  source: Recorded["source"];
  handedTo?: string;
  progress?: { by?: string; at: number };
  closed?: { as: ReplyKind; at: number; what?: string };
};
export type Party = { id: string; kind: "person" | "group" | "service"; name: string; handles: Record<string, string>; members: string[]; mergedInto?: string };
export type Report = { player: string; what: string; at: number };
export type Activity = { player: string; strand: string; activity: Exclude<ActivityKind, "idle">; what?: string; for?: string; at: number; source?: string };
export type Model = {
  strands: Map<string, Strand>;
  players: Map<string, Player>;
  moves: Map<string, Move>;
  links: Map<string, Link>;
  requests: Map<string, Request>;
  roles: Map<string, Record<string, string>>;
  parties: Map<string, Party>;
  activities: Map<string, Activity>;
  reports: Map<string, Report[]>;
  spoken: Set<string>;
  names: Map<string, string>;
  forgotten: { name: string; parent?: string; by: string }[];
  heard: Recorded[];
  lastAt: number;
  version: number;
};

export const you = "you";
export const dormant = Number.MAX_SAFE_INTEGER;
const heardKept = 200;
const reportsKept = 12;

export function emptyModel(): Model {
  return {
    strands: new Map(),
    players: new Map([[you, { id: you, kind: "you", who: "you", joined: 0 }]]),
    moves: new Map(),
    links: new Map(),
    requests: new Map(),
    roles: new Map(),
    parties: new Map(),
    activities: new Map(),
    reports: new Map(),
    spoken: new Set(),
    names: new Map(),
    forgotten: [],
    heard: [],
    lastAt: 0,
    version: 0,
  };
}

export function replay(events: Recorded[]): Model {
  const model = emptyModel();
  for (const event of events) apply(model, event);
  return model;
}

export function apply(model: Model, event: Recorded): void {
  model.version++;
  applyFact(model, event);
  model.version++;
}

function applyFact(model: Model, event: Recorded): void {
  model.heard.push(event);
  if (model.heard.length > heardKept * 2) model.heard.splice(0, model.heard.length - heardKept);
  model.lastAt = Math.max(model.lastAt, event.at);
  switch (event.type) {
    case "strand.made":
      if (model.strands.has(event.strand)) return;
      model.strands.set(event.strand, { id: event.strand, name: event.name, parent: event.parent, kind: event.kind, made: event.at, madeBy: event.source, seenAt: 0, dismissedAt: 0, blockedOn: {}, notes: [] });
      model.names.set(event.strand, path(model, event.strand).join(" › "));
      wake(model, ancestors(model, event.strand));
      return;
    case "strand.titled":
      withStrand(model, event.strand, (strand) => {
        if (event.kind) strand.kind = event.kind;
        if (event.title) strand.title = event.title;
        else delete strand.title;
      });
      return;
    case "strand.parented":
      withStrand(model, event.strand, (strand) => {
        if (event.parent !== undefined && (event.parent === strand.id || ancestors(model, event.parent).includes(strand.id))) return;
        strand.parent = event.parent;
        for (const id of [strand.id, ...descendants(model, strand.id)]) model.names.set(id, path(model, id).join(" › "));
        wake(model, ancestors(model, strand.id));
      });
      return;
    case "strand.renamed":
      withStrand(model, event.strand, (strand) => {
        strand.name = event.name;
        for (const id of [strand.id, ...descendants(model, strand.id)]) model.names.set(id, path(model, id).join(" › "));
      });
      return;
    case "strand.done":
      withStrand(model, event.strand, (strand) => {
        strand.done = event.at;
        if (strand.parent) wake(model, [strand.parent]);
        wake(model, [...model.strands.values()].filter((other) => strand.id in other.blockedOn).map((other) => other.id));
      });
      return;
    case "strand.reopened":
      withStrand(model, event.strand, (strand) => void (strand.done = undefined));
      wake(model, [event.strand]);
      return;
    case "strand.forgotten": {
      const strand = model.strands.get(event.strand);
      if (strand) model.forgotten.push({ name: strand.name, ...(strand.parent ? { parent: strand.parent } : {}), by: event.source });
      remove(model, event.strand, undefined);
      return;
    }
    case "strand.merged": {
      const into = model.strands.get(event.into);
      if (!into || event.into === event.strand || !model.strands.has(event.strand)) return;
      if (ancestors(model, event.into).includes(event.strand)) into.parent = model.strands.get(event.strand)!.parent;
      remove(model, event.strand, event.into);
      wake(model, [event.into]);
      return;
    }
    case "strand.note":
      withStrand(model, event.strand, (strand) => void strand.notes.push({ at: event.at, text: event.text }));
      return;
    case "strand.blocked":
      withStrand(model, event.strand, (strand) => {
        if (!model.strands.has(event.on) || event.on in strand.blockedOn || blockers(model, event.on).includes(strand.id)) return;
        strand.blockedOn[event.on] = event.at;
      });
      return;
    case "strand.held":
      withStrand(model, event.strand, (strand) => {
        const held = { ...strand.heldBy };
        if (event.held) held[event.by] = event.at;
        else delete held[event.by];
        if (Object.keys(held).length > 0) strand.heldBy = held;
        else delete strand.heldBy;
      });
      return;
    case "strand.planned":
      withStrand(model, event.strand, (strand) => {
        if (event.planned) strand.planned = true;
        else delete strand.planned;
      });
      return;
    case "strand.unblocked":
      withStrand(model, event.strand, (strand) => {
        if (!(event.on in strand.blockedOn)) return;
        delete strand.blockedOn[event.on];
        strand.released = { ...strand.released, [event.on]: event.at };
      });
      return;
    case "strand.seen":
      withStrand(model, event.strand, (strand) => void (strand.seenAt = event.at));
      return;
    case "strand.dismissed":
      withStrand(model, event.strand, (strand) => void (strand.dismissedAt = event.at));
      return;
    case "strand.snoozed":
      withStrand(model, event.strand, (strand) => void (strand.snoozedUntil = event.untilNeeded ? undefined : event.until));
      return;
    case "player.joined": {
      const old = model.players.get(event.player);
      model.players.set(event.player, {
        id: event.player,
        kind: event.kind,
        who: event.who,
        adapter: event.adapter ?? old?.adapter,
        place: event.place ?? old?.place,
        resume: event.resume ?? old?.resume,
        joined: old?.joined ?? event.at,
      });
      return;
    }
    case "player.gone": {
      const player = model.players.get(event.player);
      if (player && player.id !== you) player.gone = event.at;
      model.activities.delete(event.player);
      return;
    }
    case "move.opened":
      if (!model.strands.has(event.strand)) return;
      model.moves.set(event.move, { id: event.move, strand: event.strand, player: event.player, with: event.with, what: event.what, ...(event.kind ? { kind: event.kind } : {}), from: event.at, source: event.source });
      for (const id of [event.strand, ...ancestors(model, event.strand)]) delete model.strands.get(id)!.planned;
      wake(model, [event.strand]);
      return;
    case "move.described": {
      const move = model.moves.get(event.move);
      if (move) Object.assign(move, { what: event.what, described: event.at, ...(event.kind ? { kind: event.kind } : {}) });
      if (move) wake(model, [move.strand]);
      return;
    }
    case "move.closed": {
      const move = model.moves.get(event.move);
      if (move && move.until === undefined) move.until = event.at;
      return;
    }
    case "link.added":
      model.links.set(event.link, { id: event.link, strand: event.strand, move: event.move, adapter: event.adapter, ref: event.ref, label: event.label, at: event.at });
      return;
    case "link.removed":
      model.links.delete(event.link);
      return;
    case "party.known": {
      const old = model.parties.get(event.party);
      model.parties.set(event.party, { id: event.party, kind: event.kind, name: event.name, handles: { ...old?.handles, ...event.handles }, members: event.members ?? old?.members ?? [], ...(old?.mergedInto ? { mergedInto: old.mergedInto } : {}) });
      return;
    }
    case "party.merged": {
      const party = model.parties.get(event.party);
      if (party && event.into !== event.party) party.mergedInto = event.into;
      return;
    }
    case "strand.role":
      withStrand(model, event.strand, (strand) => {
        const roles = { ...model.roles.get(strand.id) };
        if (event.by) roles[event.role] = event.by;
        else delete roles[event.role];
        model.roles.set(strand.id, roles);
      });
      return;
    case "said":
      for (const asked of event.requests) {
        if (model.requests.has(asked.request) || !model.strands.has(asked.strand)) continue;
        model.requests.set(asked.request, { id: asked.request, strand: asked.strand, to: asked.to, what: asked.what, ...(asked.kind ? { kind: asked.kind } : {}), ...(asked.ref ? { ref: asked.ref } : {}), ...(asked.from ? { from: asked.from } : {}), at: event.at, source: event.source });
        start(model, asked.strand);
        wake(model, [asked.strand]);
        if (event.source === "agent") model.spoken.add(asked.strand);
      }
      for (const said of event.replies) {
        const request = model.requests.get(said.request);
        if (!request || request.closed) continue;
        if (said.as === "progress") request.progress = { ...(said.by ? { by: said.by } : {}), at: event.at };
        else if (said.as === "passed") {
          if (said.to) Object.assign(request, { to: said.to, at: event.at, progress: undefined, handedTo: undefined });
        } else request.closed = { as: said.as, at: event.at, ...(said.what ? { what: said.what } : {}) };
        wake(model, [request.strand]);
      }
      return;
    case "handed":
      for (const id of event.requests) {
        const request = model.requests.get(id);
        if (request && !request.closed) request.handedTo = event.player;
      }
      return;
    case "player.activity":
      if (event.activity === "idle" || !event.strand || !model.strands.has(event.strand)) {
        model.activities.delete(event.player);
        return;
      }
      model.activities.set(event.player, { player: event.player, strand: event.strand, activity: event.activity, ...(event.what ? { what: event.what } : {}), ...(event.for ? { for: event.for } : {}), at: event.at, source: event.source });
      start(model, event.strand);
      if (event.source === "agent") model.spoken.add(event.strand);
      if (event.source === "agent" && event.what) model.reports.set(event.strand, [...(model.reports.get(event.strand) ?? []), { player: event.player, what: event.what, at: event.at }].slice(-reportsKept));
      return;
  }
}

function start(model: Model, strand: string): void {
  for (const id of [strand, ...ancestors(model, strand)]) delete model.strands.get(id)?.planned;
}

function wake(model: Model, ids: string[]): void {
  for (const id of ids) {
    const strand = model.strands.get(id);
    if (strand?.snoozedUntil === dormant) strand.snoozedUntil = undefined;
  }
}

function withStrand(model: Model, id: string, change: (strand: Strand) => void): void {
  const strand = model.strands.get(id);
  if (strand) change(strand);
}

function remove(model: Model, id: string, into: string | undefined): void {
  const strand = model.strands.get(id);
  if (!strand) return;
  for (const child of children(model, id)) {
    child.parent = into ?? strand.parent;
    for (const below of [child.id, ...descendants(model, child.id)]) model.names.set(below, path(model, below).join(" › "));
  }
  for (const move of model.moves.values()) {
    if (move.strand !== id) continue;
    if (into) move.strand = into;
    else model.moves.delete(move.id);
  }
  for (const link of model.links.values()) {
    if (link.strand !== id) continue;
    if (into) link.strand = into;
    else model.links.delete(link.id);
  }
  for (const request of model.requests.values()) {
    if (request.strand !== id) continue;
    if (into) request.strand = into;
    else model.requests.delete(request.id);
  }
  for (const activity of model.activities.values()) {
    if (activity.strand !== id) continue;
    if (into) activity.strand = into;
    else model.activities.delete(activity.player);
  }
  const roles = model.roles.get(id);
  if (roles && into) model.roles.set(into, { ...roles, ...model.roles.get(into) });
  model.roles.delete(id);
  const reports = model.reports.get(id);
  if (reports && into) model.reports.set(into, [...(model.reports.get(into) ?? []), ...reports].sort((a, b) => a.at - b.at).slice(-reportsKept));
  model.reports.delete(id);
  for (const other of model.strands.values()) {
    const since = other.blockedOn[id];
    if (since === undefined) continue;
    delete other.blockedOn[id];
    if (into && into !== other.id && !blockers(model, into).includes(other.id)) other.blockedOn[into] = Math.min(since, other.blockedOn[into] ?? since);
  }
  if (into) {
    const target = model.strands.get(into)!;
    target.notes.push(...strand.notes);
    for (const [on, since] of Object.entries(strand.blockedOn)) if (on !== into && !blockers(model, on).includes(into)) target.blockedOn[on] = Math.min(since, target.blockedOn[on] ?? since);
  }
  model.strands.delete(id);
}

export function isBookkeeping(link: { adapter: string }): boolean {
  return link.adapter.endsWith("-state");
}

export function descendants(model: Model, id: string, seen = new Set<string>([id])): string[] {
  return children(model, id).flatMap((child) => {
    if (seen.has(child.id)) return [];
    seen.add(child.id);
    return [child.id, ...descendants(model, child.id, seen)];
  });
}

export function blockers(model: Model, id: string): string[] {
  const out = new Set<string>();
  const queue = [id];
  for (let next = 0; next < queue.length; next++) {
    for (const on of Object.keys(model.strands.get(queue[next]!)?.blockedOn ?? {})) {
      if (out.has(on) || on === id) continue;
      out.add(on);
      queue.push(on);
    }
  }
  return [...out];
}

function endedAt(model: Model, strand: Strand): number | undefined {
  return strand.done ?? ancestors(model, strand.id).map((id) => model.strands.get(id)?.done).find((done) => done !== undefined);
}

export function ancestors(model: Model, id: string): string[] {
  const out: string[] = [];
  let at = model.strands.get(id)?.parent;
  while (at !== undefined && !out.includes(at)) {
    out.push(at);
    at = model.strands.get(at)?.parent;
  }
  return out;
}

export function path(model: Model, id: string): string[] {
  return [...ancestors(model, id)].reverse().flatMap((ancestor) => model.strands.get(ancestor)?.name ?? []).concat(model.strands.get(id)?.name ?? id);
}

export function whoseOf(kind: PlayerKind): Whose {
  return kind === "job" ? "machine" : kind;
}

const rank: Record<Whose, number> = { you: 0, agent: 1, person: 2, machine: 2 };

export type Addressee = { id: string; kind: PlayerKind | "group"; who: string };
export type Item = { id: string; whose: Whose; since: number; why: string; addressee: Addressee; from?: string; request?: Request; move?: Move; activity?: Activity };
export type Standing = { whose?: Whose; since: number; why: string; moves: Move[]; items: Item[]; waitsOn?: string; tally?: string; quiet?: true; unstarted?: true };

export function pickWhose(whoses: Whose[]): Whose | undefined {
  return [...whoses].sort((a, b) => rank[a] - rank[b])[0];
}

type Tally = Map<string, { label: string; count: number; since: number; what: string; you: boolean }>;
type Index = { version: number; open: Map<string, Move[]>; asked: Map<string, Request[]>; busy: Map<string, Activity[]>; last: Map<string, number>; kids: Map<string | undefined, Strand[]>; own: Map<string, Standing>; rolled: Map<string, Standing>; tallies: Map<string, Tally> };
const indexes = new WeakMap<Model, Index>();

function indexOf(model: Model): Index {
  const cached = indexes.get(model);
  if (cached?.version === model.version) return cached;
  const index: Index = { version: model.version, open: new Map(), asked: new Map(), busy: new Map(), last: new Map(), kids: new Map(), own: new Map(), rolled: new Map(), tallies: new Map() };
  for (const move of [...model.moves.values()].sort((a, b) => a.from - b.from)) {
    if (move.until === undefined) index.open.set(move.strand, [...(index.open.get(move.strand) ?? []), move]);
    index.last.set(move.strand, Math.max(index.last.get(move.strand) ?? 0, move.until ?? move.from));
  }
  for (const request of [...model.requests.values()].sort((a, b) => a.at - b.at)) {
    if (!request.closed) index.asked.set(request.strand, [...(index.asked.get(request.strand) ?? []), request]);
    index.last.set(request.strand, Math.max(index.last.get(request.strand) ?? 0, request.closed?.at ?? request.at));
  }
  for (const activity of model.activities.values()) index.busy.set(activity.strand, [...(index.busy.get(activity.strand) ?? []), activity]);
  for (const strand of model.strands.values()) index.kids.set(strand.parent, [...(index.kids.get(strand.parent) ?? []), strand]);
  indexes.set(model, index);
  return index;
}

export function children(model: Model, id: string | undefined): Strand[] {
  return indexOf(model).kids.get(id) ?? [];
}

export function isLive(model: Model, strand: Strand): boolean {
  return strand.done === undefined && ancestors(model, strand.id).every((id) => model.strands.get(id)?.done === undefined);
}

export function openMoves(model: Model, strand: string): Move[] {
  return indexOf(model).open.get(strand) ?? [];
}

export function openRequests(model: Model, strand: string): Request[] {
  return indexOf(model).asked.get(strand) ?? [];
}

export function activitiesOn(model: Model, strand: string): Activity[] {
  return indexOf(model).busy.get(strand) ?? [];
}

export function moveWhose(model: Model, move: Move): Whose {
  return whoseOf(model.players.get(move.player)?.kind ?? "machine");
}

export function roleOf(model: Model, strand: string, role: string): string | undefined {
  for (const id of [strand, ...ancestors(model, strand)]) {
    const by = model.roles.get(id)?.[role];
    if (by) return by;
  }
  return undefined;
}

export function agentStrandOf(model: Model, player: string): string | undefined {
  return [...model.roles].find(([id, roles]) => roles.agent === player && model.strands.has(id) && isLive(model, model.strands.get(id)!))?.[0];
}

function partyOf(model: Model, id: string): Party | undefined {
  let party = model.parties.get(id);
  for (let hops = 0; party?.mergedInto && hops < 10; hops++) party = model.parties.get(party.mergedInto) ?? party;
  return party;
}

function filler(model: Model, id: string): Addressee {
  if (id === you) return { id: you, kind: "you", who: "you" };
  const player = model.players.get(id);
  if (player) return { id, kind: player.kind, who: player.who };
  const party = partyOf(model, id);
  if (party?.id === you) return { id: you, kind: "you", who: "you" };
  if (party) return { id: party.id, kind: party.kind === "service" ? "machine" : party.kind, who: party.name };
  return { id, kind: "person", who: id };
}

export function addresseeOf(model: Model, request: Request): Addressee {
  const to = request.to;
  if ("person" in to) return filler(model, to.person);
  if ("service" in to) {
    const party = partyOf(model, to.service);
    return { id: party?.id ?? to.service, kind: "machine", who: party?.name ?? to.service };
  }
  if ("group" in to) {
    if (request.progress?.by) return filler(model, request.progress.by);
    const party = partyOf(model, to.group);
    if (party?.members.includes(you)) return { id: you, kind: "you", who: "you" };
    return { id: party?.id ?? to.group, kind: "group", who: party?.name ?? to.group };
  }
  const by = roleOf(model, to.strand, to.role);
  if (by) return filler(model, by);
  if (to.role === "owner") return { id: you, kind: "you", who: "you" };
  return { id: `role:${to.role}`, kind: to.role === "agent" ? "agent" : "person", who: to.role };
}

function whoseOfAddressee(addressee: Addressee): Whose {
  if (addressee.kind === "group") return "person";
  return whoseOf(addressee.kind);
}

export function itemsOn(model: Model, strand: string): Item[] {
  const requests = openRequests(model, strand).map((request): Item => {
    const addressee = addresseeOf(model, request);
    return { id: request.id, whose: whoseOfAddressee(addressee), since: request.at, why: request.what, addressee, ...(request.from ? { from: request.from } : {}), request };
  });
  const moves = openMoves(model, strand).map((move): Item => {
    const player = model.players.get(move.player);
    return { id: move.id, whose: moveWhose(model, move), since: move.from, why: move.what, addressee: { id: move.player, kind: player?.kind ?? "machine", who: player?.who ?? move.player }, ...(move.with ? { from: move.with } : {}), move };
  });
  const busy = activitiesOn(model, strand).map((activity): Item => {
    const player = model.players.get(activity.player);
    return { id: `activity:${activity.player}`, whose: player?.kind === "agent" ? "agent" : "machine", since: activity.at, why: activity.what ?? activity.activity, addressee: { id: activity.player, kind: player?.kind ?? "machine", who: player?.who ?? activity.player }, ...(activity.for ? { from: activity.for } : {}), activity };
  });
  return [...requests, ...moves, ...busy].sort((a, b) => a.since - b.since);
}

function standingFrom(items: Item[]): Pick<Standing, "whose" | "since" | "why" | "moves" | "items"> | undefined {
  const whose = pickWhose(items.map((item) => item.whose));
  if (!whose) return undefined;
  const mine = items.filter((item) => item.whose === whose);
  return { whose, since: mine[0]!.since, why: mine[0]!.why, moves: mine.flatMap((item) => item.move ?? []), items: mine };
}

export function own(model: Model, strand: Strand): Standing {
  const index = indexOf(model);
  const cached = index.own.get(strand.id);
  if (cached) return cached;
  const items = itemsOn(model, strand.id);
  const found = standingFrom(items);
  let standing: Standing;
  if (found) standing = found;
  else {
    const live = children(model, strand.id).filter((child) => child.done === undefined);
    const holding = Object.entries(strand.blockedOn)
      .flatMap(([on, since]) => {
        const blocker = model.strands.get(on);
        return blocker && endedAt(model, blocker) === undefined ? [{ blocker, since }] : [];
      })
      .sort((a, b) => a.since - b.since)[0];
    const quiet = { moves: [], items: [] };
    if (strand.kind === "inbox" && live.length > 0) standing = { ...quiet, since: Math.max(...live.map((child) => child.made)), why: inboxSummary(model, live) };
    else if (holding) standing = { ...quiet, since: holding.since, why: `waiting on ${holding.blocker.name}`, waitsOn: holding.blocker.id };
    else if (strand.heldBy) standing = { ...quiet, since: Math.max(...Object.values(strand.heldBy)), why: `waiting on ${Object.keys(strand.heldBy).join(", ")} (not ready yet)` };
    else if (live.length > 0) standing = { ...quiet, since: strand.made, why: tallyOf(model, live) ?? "" };
    else if (strand.planned) standing = { ...quiet, since: strand.made, why: "ready to start", unstarted: true };
    else if (!index.last.has(strand.id) && !model.reports.has(strand.id)) standing = { ...quiet, since: strand.made, why: "not started", quiet: true, unstarted: true };
    else standing = { ...quiet, since: Math.max(strand.made, index.last.get(strand.id) ?? 0), why: "quiet", quiet: true };
  }
  index.own.set(strand.id, standing);
  return standing;
}

export function tallyOf(model: Model, strands: Strand[]): string | undefined {
  const groups: Tally = new Map();
  for (const strand of strands) {
    for (const group of subtreeTally(model, strand).values()) {
      const into = groups.get(group.label);
      if (into) groups.set(group.label, { ...into, count: into.count + group.count, since: Math.min(into.since, group.since), what: into.since <= group.since ? into.what : group.what });
      else groups.set(group.label, { ...group });
    }
  }
  if (groups.size === 0) return undefined;
  return [...groups.values()]
    .sort((a, b) => a.since - b.since)
    .map((group) => `${group.count} for ${group.label}${group.you && group.count === 1 ? ` (${group.what})` : ""}`)
    .join(" · ");
}

function subtreeTally(model: Model, strand: Strand, seen = new Set<string>()): Tally {
  const index = indexOf(model);
  const cached = index.tallies.get(strand.id);
  if (cached) return cached;
  const groups: Tally = new Map();
  const add = (label: string, since: number, what: string, you: boolean, count = 1) => {
    const into = groups.get(label);
    if (into) groups.set(label, { ...into, count: into.count + count, since: Math.min(into.since, since), what: into.since <= since ? into.what : what });
    else groups.set(label, { label, count, since, what, you });
  };
  for (const item of itemsOn(model, strand.id)) if (!item.activity) add(item.addressee.kind === "you" ? "you" : item.addressee.who, item.since, item.why, item.addressee.kind === "you");
  seen.add(strand.id);
  for (const child of children(model, strand.id)) {
    if (child.done !== undefined || seen.has(child.id)) continue;
    for (const group of subtreeTally(model, child, seen).values()) add(group.label, group.since, group.what, group.you, group.count);
  }
  index.tallies.set(strand.id, groups);
  return groups;
}

function inboxSummary(model: Model, kids: Strand[]): string {
  const tally = new Map<string, number>();
  for (const kid of kids) {
    const whose = rolled(model, kid).whose;
    const label = whose === "you" ? "yours" : whose === "agent" ? "with agents" : whose === undefined ? "quiet" : "waiting";
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  return ["yours", "with agents", "waiting", "quiet"].flatMap((label) => (tally.has(label) ? [`${tally.get(label)} ${label}`] : [])).join(" · ");
}

export function inboxRank(model: Model, strand: Strand): number {
  const whose = rolled(model, strand).whose;
  return whose === undefined ? 4 : rank[whose] + (whose === "machine" ? 1 : 0);
}

export function rolled(model: Model, strand: Strand): Standing {
  const index = indexOf(model);
  const cached = index.rolled.get(strand.id);
  if (cached) return cached;
  index.rolled.set(strand.id, { since: strand.made, why: "", moves: [], items: [] });
  const all = [own(model, strand), ...children(model, strand.id).filter((child) => child.done === undefined).map((child) => rolled(model, child))].filter((standing) => standing.whose !== undefined);
  const picked = all.sort((a, b) => rank[a.whose!] - rank[b.whose!] || a.since - b.since)[0];
  const tally = tallyOf(model, [strand]);
  const standing: Standing = picked ? { ...picked, ...(tally ? { tally } : {}) } : { since: strand.made, why: "", moves: [], items: [] };
  index.rolled.set(strand.id, standing);
  return standing;
}

export function snoozed(strand: Strand, now: number): boolean {
  return (strand.snoozedUntil ?? 0) > now;
}

export function yourStrands(model: Model, now: number): Strand[] {
  return [...model.strands.values()]
    .filter((strand) => isLive(model, strand) && own(model, strand).whose === "you" && !snoozed(strand, now))
    .sort((a, b) => own(model, a).since - own(model, b).since);
}

export function isUnseen(model: Model, strand: Strand): boolean {
  const seen = Math.max(strand.seenAt, ...ancestors(model, strand.id).map((id) => model.strands.get(id)?.seenAt ?? 0));
  return own(model, strand).since > seen;
}

export function recentHeard(model: Model, count: number): Recorded[] {
  return model.heard.slice(-count).reverse();
}

export type Counts = { yours: number; agents: number; snoozed: number; waiting: number; oldest?: number };

export function counts(model: Model, now: number): Counts {
  const live = [...model.strands.values()].filter((strand) => isLive(model, strand));
  const yours = yourStrands(model, now);
  const items = live.flatMap((strand) => itemsOn(model, strand.id));
  return {
    yours: yours.length,
    agents: new Set(items.filter((item) => item.whose === "agent").map((item) => item.addressee.id)).size,
    snoozed: live.filter((strand) => own(model, strand).whose === "you" && snoozed(strand, now)).length,
    waiting: items.filter((item) => item.whose === "person" || item.whose === "machine").length,
    oldest: yours[0] ? own(model, yours[0]).since : undefined,
  };
}
