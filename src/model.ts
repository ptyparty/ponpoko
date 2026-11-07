import type { BraidKind, Place, Recorded, StrandKind, Whose } from "./events.ts";

export type Braid = { id: string; name: string; kind?: BraidKind; title?: string; dir?: string; notes: { at: number; text: string }[]; seenAt: number; made: number };
export type Strand = {
  id: string;
  braid: string;
  label: string;
  kind: StrandKind;
  whose: Whose;
  who?: string;
  why: string;
  since: number;
  updated: number;
  source: Recorded["source"];
  place?: Place;
  seen: boolean;
  dismissed: boolean;
  snoozedUntil?: number;
  doing?: { text: string; page?: string; at: number };
};
export type Model = { braids: Map<string, Braid>; strands: Map<string, Strand>; pointed: Map<string, string>; heard: Recorded[]; lastAt: number };

const heardKept = 200;

export function emptyModel(): Model {
  return { braids: new Map(), strands: new Map(), pointed: new Map(), heard: [], lastAt: 0 };
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
    case "braid.made":
      if (!model.braids.has(event.braid)) model.braids.set(event.braid, { id: event.braid, name: event.name, kind: event.kind, dir: event.dir, notes: [], seenAt: 0, made: event.at });
      return;
    case "braid.titled": {
      const braid = ensureBraid(model, event.braid, event.at);
      braid.kind = event.kind;
      braid.title = event.title;
      return;
    }
    case "braid.note":
      ensureBraid(model, event.braid, event.at).notes.push({ at: event.at, text: event.text });
      return;
    case "braid.seen":
      ensureBraid(model, event.braid, event.at).seenAt = event.at;
      return;
    case "dir.pointed":
      model.pointed.set(event.dir, event.braid);
      ensureBraid(model, event.braid, event.at);
      return;
    case "strand.move": {
      ensureBraid(model, event.braid, event.at);
      const old = model.strands.get(event.strand);
      const changed = !old || old.whose !== event.whose;
      model.strands.set(event.strand, {
        id: event.strand,
        braid: event.braid,
        label: event.label,
        kind: event.kind,
        whose: event.whose,
        who: event.who,
        why: event.why,
        since: changed ? event.at : old.since,
        updated: event.at,
        source: event.source,
        place: event.place ?? old?.place,
        seen: changed ? event.whose !== "you" : old.seen,
        dismissed: changed ? false : old.dismissed,
        snoozedUntil: changed ? undefined : old.snoozedUntil,
        doing: old?.doing,
      });
      return;
    }
    case "strand.ended":
    case "strand.forgotten":
      model.strands.delete(event.strand);
      return;
    case "strand.status": {
      const strand = model.strands.get(event.strand);
      if (strand) strand.doing = event.text === "" ? undefined : { text: event.text, page: event.page, at: event.at };
      return;
    }
    case "strand.dismissed": {
      const strand = model.strands.get(event.strand);
      if (strand) strand.dismissed = true;
      return;
    }
    case "strand.seen": {
      const strand = model.strands.get(event.strand);
      if (strand) strand.seen = true;
      return;
    }
    case "strand.snoozed": {
      const strand = model.strands.get(event.strand);
      if (strand) strand.snoozedUntil = event.until;
      return;
    }
  }
}

function ensureBraid(model: Model, id: string, at: number): Braid {
  let braid = model.braids.get(id);
  if (!braid) {
    braid = { id, name: id.toUpperCase(), notes: [], seenAt: 0, made: at };
    model.braids.set(id, braid);
  }
  return braid;
}

export function recentHeard(model: Model, count: number): Recorded[] {
  return model.heard.slice(-count).reverse();
}

export function yourMoves(model: Model, now: number): Strand[] {
  return [...model.strands.values()].filter((strand) => strand.whose === "you" && !((strand.snoozedUntil ?? 0) > now)).sort((a, b) => a.since - b.since);
}

export function unseenMoves(model: Model, now: number): Strand[] {
  return yourMoves(model, now).filter((strand) => strand.since > (model.braids.get(strand.braid)?.seenAt ?? 0));
}

export type Counts = { yours: number; agents: number; snoozed: number; waiting: number; oldest?: number };

export function counts(model: Model, now: number): Counts {
  const strands = [...model.strands.values()];
  const yours = yourMoves(model, now);
  return {
    yours: yours.length,
    agents: strands.filter((strand) => strand.whose === "agent").length,
    snoozed: strands.filter((strand) => strand.whose === "you" && (strand.snoozedUntil ?? 0) > now).length,
    waiting: strands.filter((strand) => strand.whose === "machine" || strand.whose === "person").length,
    oldest: yours[0]?.since,
  };
}
