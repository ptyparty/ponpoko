import { tabBraid } from "../braids.ts";
import type { Knowledge, Space } from "../core.ts";
import type { Fact, Whose } from "../events.ts";
import type { Strand } from "../model.ts";
import type { KomuxAgent, KomuxJob, KomuxLine, KomuxTab } from "./stream.ts";

export type KomuxPlace = { adapter: "komux"; handle: string; session: string; server: string; tabId: number; paneId: number; dir: string; sessionId?: string; state?: string; asking?: boolean };

type Known = { braids: Set<string>; pointed: Map<string, string>; strands: Map<string, Strand> };
type Live = { session: string; server: string; tabs: Map<number, KomuxTab>; agents: Map<number, KomuxAgent>; jobs: Map<number, KomuxJob> };

const agentMoves: Record<string, { whose: Whose; why: string }> = {
  working: { whose: "agent", why: "working" },
  waiting: { whose: "you", why: "waiting on you" },
  done: { whose: "you", why: "turn ended" },
  failed: { whose: "you", why: "turn failed" },
  idle: { whose: "nobody", why: "idle" },
};

const asking = { whose: "you" as const, why: "asking you" };

export function komuxHandle(server: string, paneId: number): string {
  return `komux:${server}:${paneId}`;
}

export function agentStrandId(server: string, paneId: number): string {
  return `pane:${server}:${paneId}`;
}

export function jobStrandId(server: string, jobId: number): string {
  return `job:${server}:${jobId}`;
}

export function known(knowledge: Knowledge): Known {
  return { braids: new Set(knowledge.braids), pointed: new Map(knowledge.pointed), strands: new Map(knowledge.strands.map((strand) => [strand.id, strand])) };
}

export class Translator {
  private live: Live | undefined;

  facts(line: KomuxLine, model: Known): Fact[] {
    const out: Fact[] = [];
    if (line.type === "snapshot" || !this.live || this.live.server !== line.server) this.live = { session: line.session, server: line.server, tabs: new Map(), agents: new Map(), jobs: new Map() };
    const live = this.live;
    switch (line.type) {
      case "snapshot": {
        live.tabs = new Map(line.tabs.map((entry) => [entry.id, entry]));
        for (const entry of line.tabs) this.makeBraid(entry, model, out);
        const agents = new Set(line.agents.map((entry) => entry.paneId));
        const failed = new Set(line.jobs.filter((entry) => entry.state === "failed").map((entry) => entry.id));
        for (const strand of model.strands.values()) {
          const place = komuxPlace(strand);
          if (!place || place.server !== line.server) continue;
          if (strand.kind === "agent" && !agents.has(place.paneId)) out.push({ type: "strand.ended", strand: strand.id, why: "agent gone" });
          if (strand.kind === "job" && !failed.has(place.paneId)) out.push({ type: "strand.ended", strand: strand.id, why: "job no longer failing" });
        }
        for (const entry of line.agents) this.agentState(live, entry, model, out);
        live.jobs = new Map(line.jobs.map((entry) => [entry.id, entry]));
        for (const entry of line.jobs) if (entry.state === "failed") this.jobFailed(live, entry, model, out);
        return out;
      }
      case "tab.opened":
      case "tab.changed":
        live.tabs.set(line.tab.id, line.tab);
        this.makeBraid(line.tab, model, out);
        for (const entry of live.agents.values()) if (entry.tabId === line.tab.id) this.agentState(live, entry, model, out);
        return out;
      case "tab.closed":
        live.tabs.delete(line.tabId);
        return out;
      case "focus": {
        const strand = model.strands.get(agentStrandId(line.server, line.paneId));
        if (strand && strand.whose === "you" && !strand.seen) out.push({ type: "strand.seen", strand: strand.id });
        return out;
      }
      case "agent.state":
        this.agentState(live, line.agent, model, out);
        return out;
      case "agent.gone": {
        live.agents.delete(line.paneId);
        const id = agentStrandId(line.server, line.paneId);
        if (model.strands.has(id)) out.push({ type: "strand.ended", strand: id, why: "agent gone" });
        return out;
      }
      case "job.started":
        live.jobs.set(line.job.id, line.job);
        return out;
      case "job.finished": {
        live.jobs.set(line.job.id, line.job);
        const id = jobStrandId(line.server, line.job.id);
        if (line.job.state === "failed") this.jobFailed(live, line.job, model, out);
        else if (model.strands.has(id)) out.push({ type: "strand.ended", strand: id, why: "passed" });
        return out;
      }
      case "job.closed": {
        live.jobs.delete(line.jobId);
        const id = jobStrandId(line.server, line.jobId);
        if (model.strands.has(id)) out.push({ type: "strand.ended", strand: id, why: "job closed" });
        return out;
      }
      case "toast.shown":
        return out;
      case "toast.dismissed": {
        const id = line.toast.kind === "job" ? jobStrandId(line.server, line.toast.id) : agentStrandId(line.server, line.toast.id);
        const strand = model.strands.get(id);
        if (strand && strand.whose === "you" && !strand.seen) out.push({ type: "strand.dismissed", strand: id });
        return out;
      }
    }
  }

  presence(pointed: Map<string, string>): { scope: string; strands: string[]; spaces: Space[] } | undefined {
    const live = this.live;
    if (!live) return undefined;
    const agents = [...live.agents.values()].map((entry) => ({ id: agentStrandId(live.server, entry.paneId), tabId: entry.tabId }));
    const jobs = [...live.jobs.values()].filter((entry) => entry.state === "failed" && !entry.agent).map((entry) => ({ id: jobStrandId(live.server, entry.id), tabId: entry.tabId }));
    const strands = [...agents, ...jobs];
    return {
      scope: `${live.session}/${live.server}`,
      strands: strands.map((strand) => strand.id),
      spaces: [...live.tabs.values()].map((entry) => ({
        dir: entry.dir,
        ...optionalBraid(this.braidOf(entry, pointed)),
        label: `tab ${entry.number ?? "?"} ${entry.name}`,
        short: entry.number === undefined ? entry.name : `tab ${entry.number}`,
        strands: strands.filter((strand) => strand.tabId === entry.id).map((strand) => strand.id),
      })),
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

  private braidOf(entry: KomuxTab, pointed: Map<string, string>): string | undefined {
    return tabBraid(entry, pointed)?.id;
  }

  private makeBraid(entry: KomuxTab, model: Known, out: Fact[]): void {
    const braid = tabBraid(entry, model.pointed);
    if (!braid || model.braids.has(braid.id) || out.some((fact) => fact.type === "braid.made" && fact.braid === braid.id)) return;
    out.push({ type: "braid.made", braid: braid.id, name: braid.name, dir: entry.dir });
  }

  private agentState(live: Live, entry: KomuxAgent, model: Known, out: Fact[]): void {
    const before = live.agents.get(entry.paneId);
    live.agents.set(entry.paneId, entry);
    const tabEntry = live.tabs.get(entry.tabId);
    if (!tabEntry) return;
    const id = agentStrandId(live.server, entry.paneId);
    const strand = model.strands.get(id);
    const braid = this.braidOf(tabEntry, model.pointed) ?? reportedBraid(strand);
    const place = strand ? komuxPlace(strand) : undefined;
    const isAsking = entry.asking === true;
    const stateChanged = (before?.state ?? place?.state) !== entry.state || (before?.asking ?? place?.asking ?? false) !== isAsking;
    const placeChanged = !strand || strand.braid !== braid || place?.tabId !== entry.tabId || place?.sessionId !== entry.sessionId;
    if (!stateChanged && !placeChanged) return;
    if (!strand && entry.sessionId) {
      for (const old of model.strands.values()) {
        if (old.kind === "agent" && komuxPlace(old)?.sessionId === entry.sessionId && old.id !== id) out.push({ type: "strand.ended", strand: old.id, why: "moved to a new pane" });
      }
    }
    const fresh = isAsking ? asking : (agentMoves[entry.state] ?? { whose: "nobody" as const, why: entry.state });
    const keeps = strand && (!stateChanged || (entry.state === "idle" && !isAsking && strand.whose === "you" && strand.why !== asking.why));
    const move = keeps ? { whose: strand.whose, why: strand.why, ...(strand.who ? { who: strand.who } : {}) } : fresh;
    const newPlace: KomuxPlace = {
      adapter: "komux",
      handle: komuxHandle(live.server, entry.paneId),
      session: live.session,
      server: live.server,
      tabId: entry.tabId,
      paneId: entry.paneId,
      dir: tabEntry.dir,
      state: entry.state,
      ...(isAsking ? { asking: true } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    };
    out.push({ type: "strand.move", ...optionalBraid(braid), strand: id, label: `agent ${entry.name ?? `pane ${entry.paneId}`}`, kind: "agent", ...move, place: newPlace });
  }

  private jobFailed(live: Live, entry: KomuxJob, model: Known, out: Fact[]): void {
    if (entry.agent) return;
    const tabEntry = live.tabs.get(entry.tabId);
    if (!tabEntry) return;
    const id = jobStrandId(live.server, entry.id);
    const braid = this.braidOf(tabEntry, model.pointed);
    const strand = model.strands.get(id);
    if (strand?.whose === "you" && strand.braid === braid) return;
    const place: KomuxPlace = { adapter: "komux", handle: komuxHandle(live.server, entry.id), session: live.session, server: live.server, tabId: entry.tabId, paneId: entry.id, dir: tabEntry.dir };
    out.push({
      type: "strand.move",
      ...optionalBraid(braid),
      strand: id,
      label: `job ${entry.name}`,
      kind: "job",
      whose: "you",
      why: entry.code === null || entry.code === undefined ? "failed" : `failed (exit ${entry.code})`,
      place,
    });
  }
}

function optionalBraid(braid: string | undefined): { braid?: string } {
  return braid ? { braid } : {};
}

function reportedBraid(strand: Strand | undefined): string | undefined {
  return strand?.braid?.startsWith("side:") ? undefined : strand?.braid;
}

export function komuxPlace(strand: { place?: unknown }): KomuxPlace | undefined {
  const place = strand.place as Partial<KomuxPlace> | undefined;
  return place?.adapter === "komux" && typeof place.server === "string" && typeof place.paneId === "number" ? (place as KomuxPlace) : undefined;
}
