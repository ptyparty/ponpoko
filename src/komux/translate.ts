import { forAdapter, type Knowledge, type Space } from "../core.ts";
import type { Fact, ReplySaid, RequestSaid, Whose } from "../events.ts";
import type { Activity, Link, Move, Player, Request, Strand } from "../model.ts";
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

export type Known = {
  strands: Map<string, Strand>;
  closed: Map<string, Strand>;
  players: Map<string, Player>;
  open: Move[];
  links: Link[];
  on: Map<string, string>;
  resumed: Map<string, string>;
  spoke: Set<string>;
  requests: Request[];
  roles: Map<string, Record<string, string>>;
  activities: Map<string, Activity>;
  whose: Map<string, Whose>;
};
type Live = { session: string; server: string; tabs: Map<number, KomuxTab>; agents: Map<number, KomuxAgent>; jobs: Map<number, KomuxJob>; promptAware: boolean };

export const yourMoves: Record<string, string> = {
  waiting: "waiting on you",
  done: "turn ended",
  failed: "turn failed",
};
export const asking = "asking you";
export const ready = "ready for a prompt";
export const readReply = "read reply";

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
    requests: [...(knowledge.requests ?? [])],
    roles: new Map(Object.entries(knowledge.roles ?? {})),
    activities: new Map((knowledge.activities ?? []).map((activity) => [activity.player, activity])),
    whose: new Map(Object.entries(knowledge.whose ?? {})),
  };
}

export class Translator {
  private live: Live | undefined;

  constructor(private readonly newId: (prefix: string) => string = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`) {}

  facts(line: KomuxLine, model: Known): Fact[] {
    const out = new Facts(model, this.newId);
    if (line.type === "snapshot" || !this.live || this.live.server !== line.server) this.live = { session: line.session, server: line.server, tabs: new Map(), agents: new Map(), jobs: new Map(), promptAware: this.live?.server === line.server && this.live.promptAware };
    const live = this.live;
    switch (line.type) {
      case "snapshot": {
        live.tabs = new Map(line.tabs.map((entry) => [entry.id, entry]));
        if (line.features?.includes("turns") || line.agents.some((entry) => entry.prompt !== undefined || entry.turnEnd !== undefined)) live.promptAware = true;
        for (const entry of line.tabs) out.labelled(entry, false);
        out.retireMoves(line.server);
        const agents = new Set(line.agents.map((entry) => agentPlayerId(line.server, entry.paneId)));
        const failing = new Set(line.jobs.filter((entry) => (entry.state === "failed" && !entry.agent) || awaited(entry)).map((entry) => jobPlayerId(line.server, entry.id)));
        for (const player of model.players.values()) {
          const place = komuxPlace(player);
          if (!place || place.session !== line.session) continue;
          if (player.kind === "agent" && !agents.has(player.id)) out.leave(player.id, "its komux session ended", false);
          if (player.kind === "job" && !failing.has(player.id)) out.leave(player.id, "no longer failing", true);
        }
        live.jobs = new Map(line.jobs.map((entry) => [entry.id, entry]));
        for (const entry of line.agents) this.agentState(live, entry, out, false);
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
      case "focus":
        out.seenFrom(agentPlayerId(line.server, line.paneId), "strand.seen");
        return out.list;
      case "agent.state":
        this.agentState(live, line.agent, out, true);
        return out.list;
      case "agent.prompt": {
        live.promptAware = true;
        const entry = { ...(live.agents.get(line.paneId) ?? { paneId: line.paneId, state: "working" }), tabId: line.tabId, ...(line.sessionId ? { sessionId: line.sessionId } : {}) };
        live.agents.set(line.paneId, entry);
        const agent = this.join(live, entry, out, true);
        if (agent) this.prompted(agent, line.by, out);
        return out.list;
      }
      case "agent.turn": {
        live.promptAware = true;
        const entry = { ...(live.agents.get(line.paneId) ?? { paneId: line.paneId, state: "done" }), tabId: line.tabId, ...(line.sessionId ? { sessionId: line.sessionId } : {}) };
        live.agents.set(line.paneId, entry);
        const agent = this.join(live, entry, out, false);
        if (agent) this.turnEnded(agent, line.toast === "full", out);
        return out.list;
      }
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
        if (waiting) this.agentState(live, waiting, out, false);
        return out.list;
      }
      case "job.closed":
        live.jobs.delete(line.jobId);
        out.leave(jobPlayerId(line.server, line.jobId), "job closed", true);
        return out.list;
      case "toast.shown":
        return out.list;
      case "toast.dismissed":
        out.seenFrom(line.toast.kind === "job" ? jobPlayerId(line.server, line.toast.id) : agentPlayerId(line.server, line.toast.id), "strand.dismissed");
        return out.list;
    }
  }

  presence(model: Known): { scope: string; players: string[]; spaces: Space[] } | undefined {
    const live = this.live;
    if (!live) return undefined;
    const agents = [...live.agents.values()].map((entry) => ({ id: agentPlayerId(live.server, entry.paneId), tabId: entry.tabId }));
    const jobs = [...live.jobs.values()].filter((entry) => (entry.state === "failed" && !entry.agent) || awaited(entry)).map((entry) => ({ id: jobPlayerId(live.server, entry.id), tabId: entry.tabId }));
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
    return { type: "snapshot", session: live.session, server: live.server, tabs: [...live.tabs.values()], agents: [...live.agents.values()], jobs: [...live.jobs.values()], toasts: [], ...(live.promptAware ? { features: ["turns"] } : {}) };
  }

  private agentState(live: Live, entry: KomuxAgent, out: Facts, changed: boolean): void {
    const before = live.agents.get(entry.paneId);
    live.agents.set(entry.paneId, entry);
    const id = agentPlayerId(live.server, entry.paneId);
    const running = [...live.jobs.values()].filter((job) => job.startedBy === entry.paneId && job.state === "running");
    const asks = entry.asking === true || entry.state === "waiting";
    const background = asks || entry.state === "working" ? undefined : backgroundLine(entry.background, running.length);
    const busy = entry.state === "working" || background !== undefined || running.length > 0 || asks;
    const hadTurn = entry.state === "done" || entry.state === "failed";
    if (!out.model.players.has(id) && !busy && !hadTurn) return;
    const agent = this.join(live, entry, out, entry.state === "working" || asks);
    if (!agent) return;
    const fallback = changed && !live.promptAware;
    if (fallback && entry.state === "working" && before?.state !== "working") this.prompted(agent, "you", out);
    if (fallback && (entry.state === "done" || entry.state === "failed" || entry.state === "idle") && before?.state === "working") this.turnEnded(agent, true, out);
    out.activity(agent.id, agent.strand, entry.state === "working" && !asks ? "working" : background !== undefined ? "background" : "idle", background);
    for (const job of running) this.awaitJob(live, job, out.claimed(jobPlayerId(live.server, job.id)) ?? agent.strand, agent.id, out);
    const asked = out.requestsFrom(agent.id, "asking");
    if (asks && asked.length === 0) out.ask({ strand: agent.strand, to: { role: "owner", strand: agent.strand }, what: entry.asking ? asking : yourMoves.waiting!, kind: "asking", from: agent.id });
    if (!asks && asked.length > 0) out.reply(asked, "done");
  }

  private join(live: Live, entry: KomuxAgent, out: Facts, reopen: boolean): { id: string; strand: string } | undefined {
    const tab = live.tabs.get(entry.tabId);
    if (!tab) return undefined;
    const id = agentPlayerId(live.server, entry.paneId);
    const player = out.model.players.get(id);
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
      out.model.players.set(id, { id, kind: "agent", who: entry.name ?? "claude", adapter: "komux", place, ...(entry.sessionId ? { resume: entry.sessionId } : {}), joined: 0 });
    }
    const strand = out.agentStrand(id, tab, reopen, entry.sessionId, (holder) => holder !== id && [...live.agents.keys()].some((pane) => agentPlayerId(live.server, pane) === holder), `claude ${entry.paneId}`);
    return strand ? { id, strand } : undefined;
  }

  private prompted(agent: { id: string; strand: string }, by: string, out: Facts): void {
    if (by === "task") return;
    out.reply(out.requestsFrom(agent.id, "reply"), "done");
    const request = out.ask({ strand: agent.strand, to: { role: "agent", strand: agent.strand }, what: by === "sent" ? "a prompt from ponpoko" : "your prompt", kind: "prompt", ...(by === "you" ? { from: "you" } : {}) });
    out.push({ type: "handed", player: agent.id, requests: [request] });
    out.handed(request, agent.id);
  }

  private turnEnded(agent: { id: string; strand: string }, full: boolean, out: Facts): void {
    out.reply(out.handedTo(agent.id), "done");
    if (full && out.requestsFrom(agent.id, "reply").length === 0) out.ask({ strand: agent.strand, to: { role: "owner", strand: agent.strand }, what: readReply, kind: "reply", from: agent.id });
  }

  private awaitJob(live: Live, entry: KomuxJob, strand: string, agent: string, out: Facts): void {
    const id = jobPlayerId(live.server, entry.id);
    if (out.model.activities.get(id)?.strand === strand) return;
    const tab = live.tabs.get(entry.tabId);
    if (!out.model.players.has(id)) {
      const place: KomuxPlace = { adapter: "komux", handle: komuxHandle(live.server, entry.id), session: live.session, server: live.server, tabId: entry.tabId, paneId: entry.id, dir: tab?.dir ?? "" };
      out.push({ type: "player.joined", player: id, kind: "job", who: entry.name, adapter: "komux", place });
      out.model.players.set(id, { id, kind: "job", who: entry.name, adapter: "komux", place, joined: 0 });
    }
    out.activity(id, strand, "job", "running", agent);
  }

  private jobFailed(live: Live, entry: KomuxJob, out: Facts): void {
    if (entry.agent) return;
    const tab = live.tabs.get(entry.tabId);
    if (!tab) return;
    const id = jobPlayerId(live.server, entry.id);
    if (out.requestsFrom(id, "job-failed").length > 0 || out.yoursFor(id).length > 0) return;
    const place: KomuxPlace = { adapter: "komux", handle: komuxHandle(live.server, entry.id), session: live.session, server: live.server, tabId: entry.tabId, paneId: entry.id, dir: tab.dir };
    out.push({ type: "player.joined", player: id, kind: "job", who: entry.name, adapter: "komux", place });
    out.model.players.set(id, { id, kind: "job", who: entry.name, adapter: "komux", place, joined: 0 });
    const why = entry.code === null || entry.code === undefined ? `${entry.name} failed` : `${entry.name} failed (exit ${entry.code})`;
    const on = out.claimed(id) ?? out.strandFor(id, tab, true) ?? out.make(`${entry.name} in ${tab.name}`, "loose");
    out.ask({ strand: on, to: { role: "owner", strand: on }, what: why, kind: "job-failed", from: id });
  }
}

export function isFinishedTurn(move: { kind?: string; what: string }): boolean {
  return move.kind !== undefined ? move.kind === "ended" || move.kind === "ready" : move.what === yourMoves.done || move.what === ready;
}

export function backgroundLine(background: { agents: number; tasks: number } | undefined, jobs = 0): string | undefined {
  const agents = background?.agents ?? 0;
  const tasks = Math.max((background?.tasks ?? 0) - jobs, 0);
  const parts = [...(agents > 0 ? [`${agents} background ${agents === 1 ? "agent" : "agents"}`] : []), ...(tasks > 0 ? [`${tasks} background ${tasks === 1 ? "task" : "tasks"}`] : [])];
  return parts.length > 0 ? parts.join(" · ") : undefined;
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

  yoursFor(player: string): Move[] {
    return this.model.open.filter((move) => move.player === "you" && move.with === player);
  }

  requestsFrom(player: string, kind?: string): Request[] {
    return this.model.requests.filter((request) => request.from === player && (kind === undefined || request.kind === kind));
  }

  handedTo(player: string): Request[] {
    return this.model.requests.filter((request) => request.handedTo === player);
  }

  ask(asked: Omit<RequestSaid, "request">): string {
    const request = this.newId("r");
    this.push({ type: "said", requests: [{ request, ...asked }], replies: [] });
    this.model.requests.push({ id: request, ...asked, at: 0, source: "komux" });
    return request;
  }

  handed(request: string, player: string): void {
    const found = this.model.requests.find((candidate) => candidate.id === request);
    if (found) found.handedTo = player;
  }

  reply(requests: Request[], as: ReplySaid["as"]): void {
    if (requests.length === 0) return;
    const ids = new Set(requests.map((request) => request.id));
    this.push({ type: "said", requests: [], replies: [...ids].map((request) => ({ request, as })) });
    this.model.requests = this.model.requests.filter((request) => !ids.has(request.id));
  }

  activity(player: string, strand: string, activity: Activity["activity"] | "idle", what?: string, forPlayer?: string): void {
    const now = this.model.activities.get(player);
    if (activity === "idle" ? now === undefined : now?.strand === strand && now.activity === activity && (activity === "working" || now.what === what)) return;
    this.push({ type: "player.activity", player, ...(activity === "idle" ? {} : { strand }), activity, ...(what && activity !== "working" ? { what } : {}), ...(forPlayer ? { for: forPlayer } : {}) });
    if (activity === "idle") this.model.activities.delete(player);
    else this.model.activities.set(player, { player, strand, activity, ...(what ? { what } : {}), ...(forPlayer ? { for: forPlayer } : {}), at: 0 });
  }

  seenFrom(player: string, type: "strand.seen" | "strand.dismissed"): void {
    const asked = [...this.requestsFrom(player).map((request) => ({ strand: request.strand, at: request.at })), ...this.yoursFor(player).map((move) => ({ strand: move.strand, at: move.from }))];
    const done = new Set<string>();
    for (const { strand: id, at } of asked) {
      const strand = this.model.strands.get(id);
      if (!strand || done.has(id) || strand.seenAt >= at || (type === "strand.dismissed" && strand.dismissedAt >= at)) continue;
      done.add(id);
      this.push({ type, strand: id });
    }
  }

  agentStrand(player: string, tab: KomuxTab, reopen: boolean, resume: string | undefined, occupied: (holder: string) => boolean, ownName: string): string | undefined {
    const held = this.model.on.get(player);
    if (held && this.model.strands.has(held) && this.model.roles.get(held)?.agent === player) return held;
    const resumed = resume ? this.model.resumed.get(resume) : undefined;
    if (resumed && this.model.strands.has(resumed)) return this.fill(resumed, player);
    const tabbed = this.labelled(tab, reopen);
    if (!tabbed) return undefined;
    const holder = this.model.roles.get(tabbed)?.agent;
    if (holder === player) return tabbed;
    if (holder && occupied(holder)) {
      const mine = [...this.model.strands.values()].find((strand) => strand.parent === tabbed && strand.name === ownName);
      return this.fill(mine?.id ?? this.make(ownName, undefined, tabbed), player);
    }
    return this.fill(tabbed, player);
  }

  private fill(strand: string, player: string): string {
    if (this.model.roles.get(strand)?.agent === player) return strand;
    for (const [held, roles] of this.model.roles) {
      if (roles.agent !== player || held === strand) continue;
      this.push({ type: "strand.role", strand: held, role: "agent" });
      const { agent: _agent, ...rest } = roles;
      this.model.roles.set(held, rest);
    }
    this.push({ type: "strand.role", strand, role: "agent", by: player });
    this.model.roles.set(strand, { ...this.model.roles.get(strand), agent: player });
    this.model.on.set(player, strand);
    return strand;
  }

  strandFor(player: string, tab: KomuxTab, reopen: boolean): string | undefined {
    const on = this.model.on.get(player);
    if (on && this.model.strands.has(on)) return on;
    if (on && this.model.closed.has(on) && !reopen) return undefined;
    return this.labelled(tab, reopen);
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
    return undefined;
  }

  private rememberTab(strand: string, tab: KomuxTab): void {
    const ref = komuxTabRef({ dir: tab.dir, layout: tab.layout, args: tab.args });
    if (this.model.links.some((link) => link.strand === strand && link.adapter === "komux" && link.ref === ref)) return;
    const link = this.newId("l");
    this.push({ type: "link.added", link, strand, adapter: "komux", ref, label: tab.name });
    this.model.links.push({ id: link, strand, adapter: "komux", ref, label: tab.name, at: Date.now() });
  }

  claimed(player: string): string | undefined {
    return this.model.links
      .filter((link) => link.adapter === forAdapter && link.ref === player && link.strand !== undefined && this.model.strands.has(link.strand))
      .sort((a, b) => a.at - b.at)
      .at(-1)?.strand;
  }

  retireMoves(server: string): void {
    const ours = (player: string | undefined) => player !== undefined && (player.startsWith(`pane:${server}:`) || player.startsWith(`job:${server}:`));
    for (const move of this.model.open.filter((candidate) => candidate.source === "komux" && (ours(candidate.player) || ours(candidate.with)))) this.close(move);
  }

  close(move: Move): void {
    this.push({ type: "move.closed", move: move.id });
    this.model.open = this.model.open.filter((candidate) => candidate.id !== move.id);
  }

  leave(player: string, why: string, closedByYou: boolean): void {
    const known = this.model.players.get(player);
    if (!known) return;
    for (const move of [...this.model.open.filter((candidate) => candidate.player === player), ...this.yoursFor(player)]) this.close(move);
    this.reply(this.requestsFrom(player).filter((request) => request.source === "komux"), "done");
    this.reply(this.handedTo(player).filter((request) => request.kind === "prompt"), "withdrawn");
    this.push({ type: "player.gone", player, why });
    this.model.players.delete(player);
    this.model.activities.delete(player);
    const strand = this.model.strands.get(this.model.on.get(player) ?? "");
    const silent = known.kind === "job" || !this.model.spoke.has(strand?.id ?? "");
    const busy = this.model.open.some((move) => move.strand === strand?.id) || this.model.requests.some((request) => request.strand === strand?.id);
    if (strand?.kind === "loose" && closedByYou && silent && !busy) {
      this.push({ type: "strand.forgotten", strand: strand.id });
      this.model.strands.delete(strand.id);
    }
  }

  make(name: string, kind: string | undefined, parent?: string): string {
    const strand = this.newId("s");
    this.push({ type: "strand.made", strand, name, ...(kind ? { kind } : {}), ...(parent ? { parent } : {}) });
    this.model.strands.set(strand, { id: strand, name, ...(kind ? { kind } : {}), ...(parent ? { parent } : {}), made: 0, seenAt: 0, dismissedAt: 0, blockedOn: {}, notes: [] });
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
