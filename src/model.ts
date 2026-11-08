import type { Place, PlayerKind, Recorded, Whose } from "./events.ts";

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
  blockedOn: Record<string, number>;
  notes: { at: number; text: string }[];
};
export type Player = { id: string; kind: PlayerKind; who: string; adapter?: string; place?: Place; resume?: string; joined: number; gone?: number };
export type Move = { id: string; strand: string; player: string; with?: string; what: string; from: number; until?: number; source: Recorded["source"]; described?: number };
export type Link = { id: string; strand?: string; move?: string; adapter: string; ref: string; label?: string; at: number };
export type Model = {
  strands: Map<string, Strand>;
  players: Map<string, Player>;
  moves: Map<string, Move>;
  links: Map<string, Link>;
  names: Map<string, string>;
  heard: Recorded[];
  lastAt: number;
  version: number;
};

export const you = "you";
export const dormant = Number.MAX_SAFE_INTEGER;
const heardKept = 200;

export function emptyModel(): Model {
  return {
    strands: new Map(),
    players: new Map([[you, { id: you, kind: "you", who: "you", joined: 0 }]]),
    moves: new Map(),
    links: new Map(),
    names: new Map(),
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
      model.strands.set(event.strand, { id: event.strand, name: event.name, parent: event.parent, kind: event.kind, made: event.at, seenAt: 0, dismissedAt: 0, blockedOn: {}, notes: [] });
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
    case "strand.forgotten":
      remove(model, event.strand, undefined);
      return;
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
    case "strand.unblocked":
      withStrand(model, event.strand, (strand) => void delete strand.blockedOn[event.on]);
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
      return;
    }
    case "move.opened":
      if (!model.strands.has(event.strand)) return;
      model.moves.set(event.move, { id: event.move, strand: event.strand, player: event.player, with: event.with, what: event.what, from: event.at, source: event.source });
      wake(model, [event.strand]);
      return;
    case "move.described": {
      const move = model.moves.get(event.move);
      if (move) Object.assign(move, { what: event.what, described: event.at });
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
  }
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

export type Standing = { whose?: Whose; since: number; why: string; moves: Move[]; waitsOn?: string; finished?: string };

export function pickWhose(whoses: Whose[]): Whose | undefined {
  return [...whoses].sort((a, b) => rank[a] - rank[b])[0];
}

type Index = { version: number; open: Map<string, Move[]>; last: Map<string, number>; kids: Map<string | undefined, Strand[]>; own: Map<string, Standing>; rolled: Map<string, Standing> };
const indexes = new WeakMap<Model, Index>();

function indexOf(model: Model): Index {
  const cached = indexes.get(model);
  if (cached?.version === model.version) return cached;
  const index: Index = { version: model.version, open: new Map(), last: new Map(), kids: new Map(), own: new Map(), rolled: new Map() };
  for (const move of [...model.moves.values()].sort((a, b) => a.from - b.from)) {
    if (move.until === undefined) index.open.set(move.strand, [...(index.open.get(move.strand) ?? []), move]);
    index.last.set(move.strand, Math.max(index.last.get(move.strand) ?? 0, move.until ?? move.from));
  }
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

export function moveWhose(model: Model, move: Move): Whose {
  return whoseOf(model.players.get(move.player)?.kind ?? "machine");
}

export function own(model: Model, strand: Strand): Standing {
  const index = indexOf(model);
  const cached = index.own.get(strand.id);
  if (cached) return cached;
  const open = openMoves(model, strand.id);
  const whose = pickWhose(open.map((move) => moveWhose(model, move)));
  let standing: Standing;
  if (whose) {
    const moves = open.filter((move) => moveWhose(model, move) === whose);
    standing = { whose, since: moves[0]!.from, why: moves[0]!.what, moves };
  } else {
    const kids = children(model, strand.id);
    const live = kids.filter((child) => child.done === undefined);
    const seen = Math.max(strand.seenAt, ...ancestors(model, strand.id).map((id) => model.strands.get(id)?.seenAt ?? 0));
    const quiet = Math.max(strand.made, seen, index.last.get(strand.id) ?? 0, ...live.map((child) => child.made));
    const blocking = Object.entries(strand.blockedOn).flatMap(([on, since]) => {
      const blocker = model.strands.get(on);
      return blocker ? [{ blocker, since, ended: endedAt(model, blocker) }] : [];
    });
    const finished = [
      ...kids.filter((child) => child.done !== undefined && child.done > quiet).map((child) => ({ strand: child, at: child.done! })),
      ...blocking.filter(({ since, ended }) => ended !== undefined && ended > since && ended > quiet).map(({ blocker, ended }) => ({ strand: blocker, at: ended! })),
    ].sort((a, b) => b.at - a.at)[0];
    const holding = finished ? undefined : blocking.filter(({ ended }) => ended === undefined).sort((a, b) => a.since - b.since)[0];
    const busiest = finished || holding ? undefined : live.map((child) => ({ child, standing: rolled(model, child) })).filter((entry) => entry.standing.whose !== undefined).sort((a, b) => rank[a.standing.whose!] - rank[b.standing.whose!] || a.standing.since - b.standing.since)[0];
    if (finished) standing = { whose: "you", since: finished.at, why: `${finished.strand.name} is done`, moves: [], finished: finished.strand.id };
    else if (holding) standing = { since: holding.since, why: `waiting on ${holding.blocker.name}`, moves: [], waitsOn: holding.blocker.id };
    else if (busiest) standing = { since: busiest.standing.since, why: `waiting on ${busiest.child.name}`, moves: [], waitsOn: busiest.child.id };
    else if (live.length > 0) standing = { since: strand.made, why: "", moves: [] };
    else standing = { whose: "you", since: Math.max(strand.made, index.last.get(strand.id) ?? 0), why: "no one on it", moves: [] };
  }
  index.own.set(strand.id, standing);
  return standing;
}

export function rolled(model: Model, strand: Strand): Standing {
  const index = indexOf(model);
  const cached = index.rolled.get(strand.id);
  if (cached) return cached;
  index.rolled.set(strand.id, { since: strand.made, why: "", moves: [] });
  const all = [own(model, strand), ...children(model, strand.id).filter((child) => child.done === undefined).map((child) => rolled(model, child))].filter((standing) => standing.whose !== undefined);
  const standing = all.sort((a, b) => rank[a.whose!] - rank[b.whose!] || a.since - b.since)[0] ?? { since: strand.made, why: "", moves: [] };
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
  const open = [...model.moves.values()].filter((move) => move.until === undefined && model.strands.has(move.strand) && isLive(model, model.strands.get(move.strand)!));
  return {
    yours: yours.length,
    agents: open.filter((move) => moveWhose(model, move) === "agent").length,
    snoozed: live.filter((strand) => own(model, strand).whose === "you" && snoozed(strand, now)).length,
    waiting: open.filter((move) => ["person", "machine"].includes(moveWhose(model, move))).length,
    oldest: yours[0] ? own(model, yours[0]).since : undefined,
  };
}
