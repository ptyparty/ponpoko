import type { Knowledge, Space } from "../core.ts";
import type { Fact } from "../events.ts";
import type { Link, Move, Player, Strand } from "../model.ts";
import type { KomuxAgent, KomuxJob, KomuxLine, KomuxTab } from "./stream.ts";

export type KomuxPlace = {
  adapter: "komux";
  handle: string;
  session: string;
  server: string;
  tabId: number;
  paneId: number;
  dir: string;
  sessionId?: string;
  state?: string;
  asking?: boolean;
};

export type Known = { strands: Map<string, Strand>; closed: Map<string, Strand>; players: Map<string, Player>; open: Move[]; links: Link[]; on: Map<string, string>; resumed: Map<string, string>; spoke: Set<string> };
type Live = { session: string; server: string; tabs: Map<number, KomuxTab>; agents: Map<number, KomuxAgent>; jobs: Map<number, KomuxJob> };

const yourMoves: Record<string, string> = {
  waiting: "waiting on you",
  done: "turn ended",
  failed: "turn failed",
};
const asking = "asking you";
const ready = "ready for a prompt";

export function komuxTabHandle(server: string, tabId: number): string {
  return `komux:${server}:tab:${tabId}`;
}

export function readKomuxTabHandle(handle: string): { server: string; tabId: number } | undefined {
  const match = /^komux:([^:]+):tab:(\d+)$/.exec(handle);
  return match ? { server: match[1]!, tabId: Number(match[2]) } : undefined;
}

export function komuxHandle(server: string, paneId: number): string {
  return `komux:${server}:${paneId}`;
}

export function agentPlayerId(server: string, paneId: number): string {
  return `pane:${server}:${paneId}`;
}

export function jobPlayerId(server: string, jobId: number): string {
  return `job:${server}:${jobId}`;
}

export function known(knowledge: Knowledge): Known {
  return {
    strands: new Map(knowledge.strands.map((strand) => [strand.id, strand])),
    closed: new Map((knowledge.closed ?? []).map((strand) => [strand.id, strand])),
    players: new Map(knowledge.players.map((player) => [player.id, player])),
    open: [...knowledge.open],
    links: [...knowledge.links],
    on: new Map(Object.entries(knowledge.on)),
    resumed: new Map(Object.entries(knowledge.resumed ?? {})),
    spoke: new Set(knowledge.spoke),
  };
}

export class Translator {
  private live: Live | undefined;

  constructor(private readonly newId: (prefix: string) => string = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`) {}

  facts(line: KomuxLine, model: Known): Fact[] {
    const out = new Facts(model, this.newId);
    if (line.type === "snapshot" || !this.live || this.live.server !== line.server) this.live = { session: line.session, server: line.server, tabs: new Map(), agents: new Map(), jobs: new Map() };
    const live = this.live;
    switch (line.type) {
      case "snapshot": {
        live.tabs = new Map(line.tabs.map((entry) => [entry.id, entry]));
        for (const entry of line.tabs) out.labelled(entry, false);
        const agents = new Set(line.agents.map((entry) => agentPlayerId(line.server, entry.paneId)));
        const failing = new Set(line.jobs.filter((entry) => (entry.state === "failed" && !entry.agent) || awaited(entry)).map((entry) => jobPlayerId(line.server, entry.id)));
        for (const player of model.players.values()) {
          const place = komuxPlace(player);
          if (!place || place.session !== line.session) continue;
          if (player.kind === "agent" && !agents.has(player.id)) out.leave(player.id, "its komux session ended", false);
          if (player.kind === "job" && !failing.has(player.id)) out.leave(player.id, "no longer failing", true);
        }
        live.jobs = new Map(line.jobs.map((entry) => [entry.id, entry]));
        for (const entry of line.agents) this.agentState(live, entry, out);
        for (const entry of line.jobs) if (entry.state === "failed" && entry.startedBy === undefined) this.jobFailed(live, entry, out);
        return out.list;
      }
      case "tab.opened":
      case "tab.changed":
        live.tabs.set(line.tab.id, line.tab);
        out.labelled(line.tab, line.type === "tab.opened");
        return out.list;
      case "tab.closed":
        live.tabs.delete(line.tabId);
        return out.list;
      case "focus": {
        for (const move of out.yoursFor(agentPlayerId(line.server, line.paneId))) {
          const strand = model.strands.get(move.strand);
          if (strand && strand.seenAt < move.from) out.push({ type: "strand.seen", strand: strand.id });
        }
        return out.list;
      }
      case "agent.state":
        this.agentState(live, line.agent, out);
        return out.list;
      case "agent.gone":
        live.agents.delete(line.paneId);
        out.leave(agentPlayerId(line.server, line.paneId), "pane closed", true);
        return out.list;
      case "job.started":
        live.jobs.set(line.job.id, line.job);
        return out.list;
      case "job.finished": {
        live.jobs.set(line.job.id, line.job);
        const waiting = line.job.startedBy === undefined ? undefined : live.agents.get(line.job.startedBy);
        if (line.job.startedBy !== undefined) out.leave(jobPlayerId(line.server, line.job.id), line.job.state === "failed" ? "failed" : "passed", false);
        else if (line.job.state === "failed") this.jobFailed(live, line.job, out);
        else out.leave(jobPlayerId(line.server, line.job.id), "passed", true);
        if (waiting) this.agentState(live, waiting, out);
        return out.list;
      }
      case "job.closed":
        live.jobs.delete(line.jobId);
        out.leave(jobPlayerId(line.server, line.jobId), "job closed", true);
        return out.list;
      case "toast.shown":
        return out.list;
      case "toast.dismissed": {
        const player = line.toast.kind === "job" ? jobPlayerId(line.server, line.toast.id) : agentPlayerId(line.server, line.toast.id);
        for (const move of out.yoursFor(player)) {
          const strand = model.strands.get(move.strand);
          if (strand && strand.dismissedAt < move.from && strand.seenAt < move.from) out.push({ type: "strand.dismissed", strand: strand.id });
        }
        return out.list;
      }
    }
  }

  presence(model: Known): { scope: string; players: string[]; spaces: Space[] } | undefined {
    const live = this.live;
    if (!live) return undefined;
    const agents = [...live.agents.values()].map((entry) => ({ id: agentPlayerId(live.server, entry.paneId), tabId: entry.tabId }));
    const jobs = [...live.jobs.values()].filter((entry) => entry.state === "failed" && !entry.agent).map((entry) => ({ id: jobPlayerId(live.server, entry.id), tabId: entry.tabId }));
    const players = [...agents, ...jobs].filter((player) => model.players.has(player.id));
    return {
      scope: `${live.session}/${live.server}`,
      players: players.map((player) => player.id),
      spaces: [...live.tabs.values()].map((entry) => {
        const strand = tabStrand(entry, model);
        return {
          dir: entry.dir,
          ...(strand?.id ? { strand: strand.id } : {}),
          handle: komuxTabHandle(live.server, entry.id),
          label: `tab ${entry.number ?? "?"} ${entry.name}`,
          short: entry.number === undefined ? entry.name : `tab ${entry.number}`,
          players: players.filter((player) => player.tabId === entry.id).map((player) => player.id),
        };
      }),
    };
  }

  server(): string | undefined {
    return this.live?.server;
  }

  tabs(): KomuxTab[] {
    return [...(this.live?.tabs.values() ?? [])];
  }

  resnapshot(): KomuxLine | undefined {
    const live = this.live;
    if (!live) return undefined;
    return { type: "snapshot", session: live.session, server: live.server, tabs: [...live.tabs.values()], agents: [...live.agents.values()], jobs: [...live.jobs.values()], toasts: [] };
  }

  private agentState(live: Live, entry: KomuxAgent, out: Facts): void {
    live.agents.set(entry.paneId, entry);
    const tab = live.tabs.get(entry.tabId);
    if (!tab) return;
    const id = agentPlayerId(live.server, entry.paneId);
    const player = out.model.players.get(id);
    const mine = out.openBy(id);
    const yours = out.yoursFor(id);
    const wanted = entry.asking ? asking : entry.state === "working" ? undefined : (yourMoves[entry.state] ?? (player ? ready : null));
    if (wanted === null) return;
    const place: KomuxPlace = {
      adapter: "komux",
      handle: komuxHandle(live.server, entry.paneId),
      session: live.session,
      server: live.server,
      tabId: entry.tabId,
      paneId: entry.paneId,
      dir: tab.dir,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    };
    const old = player ? komuxPlace(player) : undefined;
    if (!player || old?.tabId !== place.tabId || old?.dir !== place.dir || old?.sessionId !== place.sessionId) {
      out.push({ type: "player.joined", player: id, kind: "agent", who: entry.name ?? "claude", adapter: "komux", place, ...(entry.sessionId ? { resume: entry.sessionId } : {}) });
    }
    const strand = (reopen: boolean) => out.strandFor(id, tab, entry.name ?? "claude", reopen, entry.sessionId);
    const running = [...live.jobs.values()].filter((job) => job.startedBy === entry.paneId && job.state === "running");
    if (wanted !== undefined && wanted !== asking && running.length > 0) {
      for (const move of [...mine, ...yours]) out.close(move);
      const on = strand(false);
      if (on) for (const job of running) this.awaitJob(live, job, on, id, out);
      return;
    }
    if (wanted === yourMoves.done) {
      const on = out.model.on.get(id);
      if (on && reportedWait(on, out.model)) {
        for (const move of [...mine, ...yours]) out.close(move);
        return;
      }
    }
    if (wanted === ready && yours.length > 0) return;
    if (wanted === undefined) {
      for (const move of yours) out.push({ type: "move.closed", move: move.id });
      const on = mine.length === 0 ? strand(true) : undefined;
      if (on) out.open(on, id, "working");
      return;
    }
    for (const move of mine) out.push({ type: "move.closed", move: move.id });
    const current = yours.at(-1);
    if (current) {
      if (current.what !== wanted) out.push({ type: "move.described", move: current.id, what: wanted });
      return;
    }
    const on = strand(false);
    if (on) out.open(on, "you", wanted, id);
  }

  private awaitJob(live: Live, entry: KomuxJob, strand: string, agent: string, out: Facts): void {
    const id = jobPlayerId(live.server, entry.id);
    if (out.openBy(id).length > 0) return;
    const tab = live.tabs.get(entry.tabId);
    if (!out.model.players.has(id)) {
      const place: KomuxPlace = { adapter: "komux", handle: komuxHandle(live.server, entry.id), session: live.session, server: live.server, tabId: entry.tabId, paneId: entry.id, dir: tab?.dir ?? "" };
      out.push({ type: "player.joined", player: id, kind: "job", who: entry.name, adapter: "komux", place });
    }
    out.open(strand, id, "running", agent);
  }

  private jobFailed(live: Live, entry: KomuxJob, out: Facts): void {
    if (entry.agent) return;
    const tab = live.tabs.get(entry.tabId);
    if (!tab) return;
    const id = jobPlayerId(live.server, entry.id);
    if (out.yoursFor(id).length > 0) return;
    const place: KomuxPlace = { adapter: "komux", handle: komuxHandle(live.server, entry.id), session: live.session, server: live.server, tabId: entry.tabId, paneId: entry.id, dir: tab.dir };
    out.push({ type: "player.joined", player: id, kind: "job", who: entry.name, adapter: "komux", place });
    const why = entry.code === null || entry.code === undefined ? `${entry.name} failed` : `${entry.name} failed (exit ${entry.code})`;
    const on = out.strandFor(id, tab, entry.name, true);
    if (on) out.open(on, "you", why, id);
  }
}

function reportedWait(strand: string, model: Known): boolean {
  const waitsOnStrand = Object.keys(model.strands.get(strand)?.blockedOn ?? {}).some((on) => model.strands.has(on));
  const waitsOnSomeone = model.open.some((move) => move.strand === strand && ["person", "machine"].includes(model.players.get(move.player)?.kind ?? ""));
  return waitsOnStrand || waitsOnSomeone;
}

class Facts {
  readonly list: Fact[] = [];

  constructor(
    readonly model: Known,
    private readonly newId: (prefix: string) => string,
  ) {}

  push(fact: Fact): void {
    this.list.push(fact);
  }

  openBy(player: string): Move[] {
    return this.model.open.filter((move) => move.player === player);
  }

  yoursFor(player: string): Move[] {
    return this.model.open.filter((move) => move.player === "you" && move.with === player);
  }

  open(strand: string, player: string, what: string, answers?: string): void {
    const move = this.newId("m");
    this.push({ type: "move.opened", move, strand, player, what, ...(answers ? { with: answers } : {}) });
    this.model.open.push({ id: move, strand, player, what, from: 0, source: "komux", ...(answers ? { with: answers } : {}) });
    this.model.on.set(answers ?? player, strand);
  }

  strandFor(player: string, tab: KomuxTab, who: string, reopen: boolean, resume?: string): string | undefined {
    const on = this.model.on.get(player) ?? (resume ? this.model.resumed.get(resume) : undefined);
    if (on && this.model.strands.has(on)) return on;
    if (on && this.model.closed.has(on) && !reopen) return undefined;
    return this.labelled(tab, reopen) ?? this.make(`${who} in ${tab.name}`, "loose");
  }

  labelled(tab: KomuxTab, reopen: boolean): string | undefined {
    const strand = this.labelledStrand(tab, reopen);
    if (strand && tab.layout) this.rememberTab(strand, tab);
    return strand;
  }

  private labelledStrand(tab: KomuxTab, reopen: boolean): string | undefined {
    const found = tabStrand(tab, this.model);
    if (!found) return undefined;
    if (found.id) return found.id;
    if (found.closed) {
      if (!reopen) return undefined;
      this.push({ type: "strand.reopened", strand: found.closed });
      const strand = this.model.closed.get(found.closed)!;
      this.model.closed.delete(found.closed);
      this.model.strands.set(strand.id, { ...strand, done: undefined });
      return strand.id;
    }
    return this.make(found.name, undefined);
  }

  private rememberTab(strand: string, tab: KomuxTab): void {
    const ref = komuxTabRef({ dir: tab.dir, layout: tab.layout, args: tab.args });
    if (this.model.links.some((link) => link.strand === strand && link.adapter === "komux" && link.ref === ref)) return;
    const link = this.newId("l");
    this.push({ type: "link.added", link, strand, adapter: "komux", ref, label: tab.name });
    this.model.links.push({ id: link, strand, adapter: "komux", ref, label: tab.name, at: Date.now() });
  }

  close(move: Move): void {
    this.push({ type: "move.closed", move: move.id });
    this.model.open = this.model.open.filter((candidate) => candidate.id !== move.id);
  }

  leave(player: string, why: string, closedByYou: boolean): void {
    const known = this.model.players.get(player);
    if (!known) return;
    for (const move of [...this.openBy(player), ...this.yoursFor(player)]) {
      this.push({ type: "move.closed", move: move.id });
      this.model.open = this.model.open.filter((candidate) => candidate.id !== move.id);
    }
    this.push({ type: "player.gone", player, why });
    this.model.players.delete(player);
    const strand = this.model.strands.get(this.model.on.get(player) ?? "");
    const silent = known.kind === "job" || !this.model.spoke.has(strand?.id ?? "");
    if (strand?.kind === "loose" && closedByYou && silent && !this.model.open.some((move) => move.strand === strand.id)) {
      this.push({ type: "strand.forgotten", strand: strand.id });
      this.model.strands.delete(strand.id);
    }
  }

  private make(name: string, kind: string | undefined): string {
    const strand = this.newId("s");
    this.push({ type: "strand.made", strand, name, ...(kind ? { kind } : {}) });
    this.model.strands.set(strand, { id: strand, name, ...(kind ? { kind } : {}), made: 0, seenAt: 0, dismissedAt: 0, blockedOn: {}, notes: [] });
    return strand;
  }
}

function awaited(job: KomuxJob): boolean {
  return job.state === "running" && job.startedBy !== undefined;
}

export function tabStrand(tab: KomuxTab, model: Pick<Known, "strands" | "links"> & Partial<Pick<Known, "closed">>): { id?: string; closed?: string; name: string } | undefined {
  const label = tab.labels?.strand;
  if (label && !/\{[\w-]+\}/.test(label)) {
    const wanted = label.toLowerCase();
    const parts = wanted.split("›").map((part) => part.trim()).filter((part) => part !== "");
    const all = parts.length > 1 ? new Map([...(model.closed?.values() ?? []), ...model.strands.values()].map((strand) => [strand.id, strand])) : new Map<string, Strand>();
    const pathOf = (strand: Strand) => {
      const names = [strand.name.toLowerCase()];
      for (let at = strand.parent ? all.get(strand.parent) : undefined; at && names.length <= parts.length; at = at.parent ? all.get(at.parent) : undefined) names.unshift(at.name.toLowerCase());
      return names;
    };
    const matches = (strand: Strand) => (parts.length > 1 ? pathOf(strand).join(" › ") === parts.join(" › ") : strand.name.toLowerCase() === wanted);
    const pick = (strands: Iterable<Strand>) => {
      const named = [...strands].filter(matches);
      return named.find((strand) => strand.parent === undefined) ?? (named.length === 1 ? named[0] : undefined);
    };
    const found = pick([...model.strands.values()].filter((strand) => strand.done === undefined));
    if (found) return { id: found.id, name: found.name };
    const closed = pick(model.closed?.values() ?? []);
    if (closed) return { closed: closed.id, name: closed.name };
    if (parts.length === 1) return { name: label.toLowerCase() };
  }
  let best: Link | undefined;
  for (const link of model.links) {
    if (link.adapter !== "dir" || !link.strand || !model.strands.has(link.strand)) continue;
    if ((tab.dir === link.ref || tab.dir.startsWith(`${link.ref}/`)) && (!best || link.ref.length > best.ref.length)) best = link;
  }
  return best ? { id: best.strand!, name: model.strands.get(best.strand!)!.name } : undefined;
}

export type KomuxTabRef = { dir: string; layout?: string; args?: Record<string, string> };

export function komuxTabRef(tab: KomuxTabRef): string {
  return JSON.stringify({ dir: tab.dir, ...(tab.layout ? { layout: tab.layout } : {}), ...(tab.args && Object.keys(tab.args).length > 0 ? { args: tab.args } : {}) });
}

export function readKomuxTabRef(ref: string): KomuxTabRef | undefined {
  try {
    const parsed = JSON.parse(ref) as Partial<KomuxTabRef>;
    return typeof parsed.dir === "string" ? { dir: parsed.dir, ...(typeof parsed.layout === "string" ? { layout: parsed.layout } : {}), ...(parsed.args && typeof parsed.args === "object" ? { args: parsed.args } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

export function komuxPlace(player: { adapter?: string; place?: unknown }): KomuxPlace | undefined {
  const place = player.place as Partial<KomuxPlace> | undefined;
  return player.adapter === "komux" && place && typeof place.server === "string" && typeof place.paneId === "number" ? ({ adapter: "komux", ...place } as KomuxPlace) : undefined;
}
