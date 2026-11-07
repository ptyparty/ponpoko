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
};

export const you = "you";
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
  };
}

export function replay(events: Recorded[]): Model {
  const model = emptyModel();
  for (const event of events) apply(model, event);
  return model;
}

export function apply(model: Model, event: Recorded): void {
  model.heard.push(event);
  if (model.heard.length > heardKept * 2) model.heard.splice(0, model.heard.length - heardKept);
  model.lastAt = Math.max(model.lastAt, event.at);
  switch (event.type) {
    case "strand.made":
      if (model.strands.has(event.strand)) return;
      model.strands.set(event.strand, { id: event.strand, name: event.name, parent: event.parent, kind: event.kind, made: event.at, seenAt: 0, dismissedAt: 0, notes: [] });
      model.names.set(event.strand, path(model, event.strand).join(" › "));
      return;
    case "strand.titled":
      withStrand(model, event.strand, (strand) => {
        if (event.kind) strand.kind = event.kind;
        strand.title = event.title;
      });
      return;
    case "strand.parented":
      withStrand(model, event.strand, (strand) => {
        if (event.parent !== undefined && (event.parent === strand.id || ancestors(model, event.parent).includes(strand.id))) return;
        strand.parent = event.parent;
        for (const id of [strand.id, ...descendants(model, strand.id)]) model.names.set(id, path(model, id).join(" › "));
      });
      return;
    case "strand.done":
      withStrand(model, event.strand, (strand) => void (strand.done = event.at));
      return;
    case "strand.forgotten":
      remove(model, event.strand, undefined);
      return;
    case "strand.merged":
      if (model.strands.has(event.into) && event.into !== event.strand) remove(model, event.strand, event.into);
      return;
    case "strand.note":
      withStrand(model, event.strand, (strand) => void strand.notes.push({ at: event.at, text: event.text }));
      return;
    case "strand.seen":
      withStrand(model, event.strand, (strand) => void (strand.seenAt = event.at));
      return;
    case "strand.dismissed":
      withStrand(model, event.strand, (strand) => void (strand.dismissedAt = event.at));
      return;
    case "strand.snoozed":
      withStrand(model, event.strand, (strand) => void (strand.snoozedUntil = event.until));
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
      return;
    case "move.described": {
      const move = model.moves.get(event.move);
      if (move) Object.assign(move, { what: event.what, described: event.at });
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
  if (into) model.strands.get(into)!.notes.push(...strand.notes);
  model.strands.delete(id);
}

export function children(model: Model, id: string | undefined): Strand[] {
  return [...model.strands.values()].filter((strand) => strand.parent === id);
}

export function descendants(model: Model, id: string): string[] {
  return children(model, id).flatMap((child) => [child.id, ...descendants(model, child.id)]);
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

export type Standing = { whose?: Whose; since: number; why: string; moves: Move[] };

export function openMoves(model: Model, strand: string): Move[] {
  return [...model.moves.values()].filter((move) => move.strand === strand && move.until === undefined).sort((a, b) => a.from - b.from);
}

export function moveWhose(model: Model, move: Move): Whose {
  return whoseOf(model.players.get(move.player)?.kind ?? "machine");
}

export function own(model: Model, strand: Strand): Standing {
  const open = openMoves(model, strand.id);
  if (open.length > 0) {
    const whose = open.map((move) => moveWhose(model, move)).sort((a, b) => rank[a] - rank[b])[0]!;
    const moves = open.filter((move) => moveWhose(model, move) === whose);
    return { whose, since: moves[0]!.from, why: moves[0]!.what, moves };
  }
  if (children(model, strand.id).some((child) => child.done === undefined)) return { since: strand.made, why: "", moves: [] };
  const last = Math.max(strand.made, ...[...model.moves.values()].filter((move) => move.strand === strand.id).map((move) => move.until ?? move.from));
  return { whose: "you", since: last, why: "no one on it", moves: [] };
}

export function rolled(model: Model, strand: Strand): Standing {
  const all = [own(model, strand), ...children(model, strand.id).filter((child) => child.done === undefined).map((child) => rolled(model, child))].filter((standing) => standing.whose !== undefined);
  if (all.length === 0) return { since: strand.made, why: "", moves: [] };
  const best = all.sort((a, b) => rank[a.whose!] - rank[b.whose!] || a.since - b.since)[0]!;
  return best;
}

export function snoozed(strand: Strand, now: number): boolean {
  return (strand.snoozedUntil ?? 0) > now;
}

export function yourStrands(model: Model, now: number): Strand[] {
  return [...model.strands.values()]
    .filter((strand) => strand.done === undefined && own(model, strand).whose === "you" && !snoozed(strand, now))
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
  const live = [...model.strands.values()].filter((strand) => strand.done === undefined);
  const yours = yourStrands(model, now);
  const open = [...model.moves.values()].filter((move) => move.until === undefined && model.strands.get(move.strand)?.done === undefined);
  return {
    yours: yours.length,
    agents: open.filter((move) => moveWhose(model, move) === "agent").length,
    snoozed: live.filter((strand) => own(model, strand).whose === "you" && snoozed(strand, now)).length,
    waiting: open.filter((move) => ["person", "machine"].includes(moveWhose(model, move))).length,
    oldest: yours[0] ? own(model, yours[0]).since : undefined,
  };
}
