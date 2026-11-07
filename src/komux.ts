import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { braidForDir } from "./braids.ts";
import type { Fact, Place, Whose } from "./events.ts";
import type { Model } from "./model.ts";

const tab = z.object({ id: z.number(), number: z.number().optional(), name: z.string(), dir: z.string() });
const agent = z.object({ paneId: z.number(), tabId: z.number(), state: z.string(), name: z.string().optional(), sessionId: z.string().optional() });
const job = z.object({ id: z.number(), tabId: z.number(), name: z.string(), state: z.string(), code: z.number().nullable().optional(), agent: z.boolean().optional() });
const toast = z.object({ kind: z.string(), id: z.number(), tabId: z.number() });
const envelope = { session: z.string(), server: z.string().default("unknown"), at: z.number().optional() };

export const komuxLine = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("snapshot"), tabs: z.array(tab), agents: z.array(agent), jobs: z.array(job), toasts: z.array(toast).default([]) }),
  z.object({ ...envelope, type: z.literal("tab.opened"), tab }),
  z.object({ ...envelope, type: z.literal("tab.changed"), tab }),
  z.object({ ...envelope, type: z.literal("tab.closed"), tabId: z.number() }),
  z.object({ ...envelope, type: z.literal("focus"), tabId: z.number(), paneId: z.number() }),
  z.object({ ...envelope, type: z.literal("agent.state"), agent }),
  z.object({ ...envelope, type: z.literal("agent.gone"), paneId: z.number(), tabId: z.number() }),
  z.object({ ...envelope, type: z.literal("job.started"), job }),
  z.object({ ...envelope, type: z.literal("job.finished"), job }),
  z.object({ ...envelope, type: z.literal("job.closed"), jobId: z.number(), tabId: z.number() }),
  z.object({ ...envelope, type: z.literal("toast.shown"), toast }),
  z.object({ ...envelope, type: z.literal("toast.dismissed"), toast }),
]);

export type KomuxLine = z.infer<typeof komuxLine>;
type Tab = z.infer<typeof tab>;
type Agent = z.infer<typeof agent>;
type Job = z.infer<typeof job>;
type Live = { session: string; tabs: Map<number, Tab>; agents: Map<number, Agent>; jobs: Map<number, Job> };

export type LivePane = { session: string; server: string; tabId: number; paneId: number };

const agentMoves: Record<string, { whose: Whose; why: string }> = {
  working: { whose: "agent", why: "working" },
  waiting: { whose: "you", why: "waiting on you" },
  done: { whose: "you", why: "turn ended" },
  failed: { whose: "you", why: "turn failed" },
  idle: { whose: "nobody", why: "idle" },
};

export function agentStrandId(server: string, paneId: number): string {
  return `pane:${server}:${paneId}`;
}

export function jobStrandId(server: string, jobId: number): string {
  return `job:${server}:${jobId}`;
}

export class Translator {
  private readonly servers = new Map<string, Live>();

  facts(line: KomuxLine, model: Model): Fact[] {
    const out: Fact[] = [];
    const live = this.live(line.session, line.server, line.type === "snapshot");
    switch (line.type) {
      case "snapshot": {
        live.tabs = new Map(line.tabs.map((entry) => [entry.id, entry]));
        for (const entry of line.tabs) this.makeBraid(entry, model, out);
        const agents = new Map(line.agents.map((entry) => [entry.paneId, entry]));
        const jobs = new Map(line.jobs.map((entry) => [entry.id, entry]));
        for (const strand of model.strands.values()) {
          if (strand.place?.server !== line.server) continue;
          const gone = strand.kind === "agent" ? !agents.has(strand.place.paneId ?? -1) : strand.kind === "job" ? jobs.get(strand.place.paneId ?? -1)?.state !== "failed" : false;
          if (gone) out.push({ type: "strand.ended", strand: strand.id, why: strand.kind === "agent" ? "pane closed" : "job no longer failing" });
        }
        live.agents = new Map();
        for (const entry of line.agents) this.agentState(live, line.server, entry, model, out);
        live.jobs = jobs;
        for (const entry of line.jobs) if (entry.state === "failed") this.jobFailed(live, line.server, entry, model, out);
        return out;
      }
      case "tab.opened":
      case "tab.changed": {
        live.tabs.set(line.tab.id, line.tab);
        this.makeBraid(line.tab, model, out);
        for (const entry of live.agents.values()) if (entry.tabId === line.tab.id) this.agentState(live, line.server, entry, model, out);
        return out;
      }
      case "tab.closed":
        live.tabs.delete(line.tabId);
        return out;
      case "focus": {
        const strand = model.strands.get(agentStrandId(line.server, line.paneId));
        if (strand && strand.whose === "you" && !strand.seen) out.push({ type: "strand.seen", strand: strand.id });
        return out;
      }
      case "agent.state":
        this.agentState(live, line.server, line.agent, model, out);
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
      case "job.finished":
        live.jobs.set(line.job.id, line.job);
        if (line.job.state === "failed") this.jobFailed(live, line.server, line.job, model, out);
        else if (model.strands.has(jobStrandId(line.server, line.job.id))) out.push({ type: "strand.ended", strand: jobStrandId(line.server, line.job.id), why: "passed" });
        return out;
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

  livePane(strandPlace: Place | undefined): LivePane | undefined {
    if (!strandPlace || strandPlace.paneId === undefined) return undefined;
    const live = this.servers.get(strandPlace.server);
    if (!live) return undefined;
    if (!live.agents.has(strandPlace.paneId) && !live.jobs.has(strandPlace.paneId)) return undefined;
    const tabId = live.agents.get(strandPlace.paneId)?.tabId ?? live.jobs.get(strandPlace.paneId)!.tabId;
    return { session: live.session, server: strandPlace.server, tabId, paneId: strandPlace.paneId };
  }

  liveTabs(): { session: string; server: string; tab: Tab }[] {
    return [...this.servers].flatMap(([server, live]) => [...live.tabs.values()].map((entry) => ({ session: live.session, server, tab: entry })));
  }

  disconnected(server: string): void {
    this.servers.delete(server);
  }

  private live(session: string, server: string, fresh: boolean): Live {
    let live = this.servers.get(server);
    if (!live || fresh) {
      for (const [other, entry] of this.servers) if (entry.session === session && other !== server) this.servers.delete(other);
      live = live ?? { session, tabs: new Map(), agents: new Map(), jobs: new Map() };
      this.servers.set(server, live);
    }
    return live;
  }

  private makeBraid(entry: Tab, model: Model, out: Fact[]): void {
    const braid = braidForDir(entry.dir, model.pointed);
    if (model.braids.has(braid.id) || out.some((fact) => fact.type === "braid.made" && fact.braid === braid.id)) return;
    out.push({ type: "braid.made", braid: braid.id, name: braid.name, kind: braid.kind, dir: entry.dir });
  }

  private agentState(live: Live, server: string, entry: Agent, model: Model, out: Fact[]): void {
    const before = live.agents.get(entry.paneId);
    live.agents.set(entry.paneId, entry);
    const tabEntry = live.tabs.get(entry.tabId);
    if (!tabEntry) return;
    const braid = braidForDir(tabEntry.dir, model.pointed).id;
    const id = agentStrandId(server, entry.paneId);
    const strand = model.strands.get(id);
    const stateChanged = (before?.state ?? strand?.place?.state) !== entry.state;
    const placeChanged = !strand || strand.braid !== braid || strand.place?.tabId !== entry.tabId || strand.place?.sessionId !== entry.sessionId;
    if (!stateChanged && !placeChanged) return;
    if (!strand && entry.sessionId) {
      for (const old of model.strands.values()) {
        if (old.kind === "agent" && old.place?.sessionId === entry.sessionId && old.id !== id) out.push({ type: "strand.ended", strand: old.id, why: "moved to a new pane" });
      }
    }
    const move = stateChanged || !strand ? (agentMoves[entry.state] ?? { whose: "nobody" as const, why: entry.state }) : { whose: strand.whose, why: strand.why, who: strand.who };
    out.push({
      type: "strand.move",
      braid,
      strand: id,
      label: `agent ${entry.name ?? `pane ${entry.paneId}`}`,
      kind: "agent",
      ...move,
      place: { session: live.session, server, tabId: entry.tabId, paneId: entry.paneId, dir: tabEntry.dir, state: entry.state, ...(entry.sessionId ? { sessionId: entry.sessionId } : {}) },
    });
  }

  private jobFailed(live: Live, server: string, entry: Job, model: Model, out: Fact[]): void {
    if (entry.agent) return;
    const tabEntry = live.tabs.get(entry.tabId);
    if (!tabEntry) return;
    const id = jobStrandId(server, entry.id);
    if (model.strands.get(id)?.whose === "you") return;
    out.push({
      type: "strand.move",
      braid: braidForDir(tabEntry.dir, model.pointed).id,
      strand: id,
      label: `job ${entry.name}`,
      kind: "job",
      whose: "you",
      why: entry.code === null || entry.code === undefined ? "failed" : `failed (exit ${entry.code})`,
      place: { session: live.session, server, tabId: entry.tabId, paneId: entry.id, dir: tabEntry.dir },
    });
  }
}

export function eventSockets(dir: string): { session: string; path: string }[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".events.sock"))
      .map((file) => ({ session: file.slice(0, -".events.sock".length), path: join(dir, file) }));
  } catch {
    return [];
  }
}

export function controlSocket(dir: string, session: string): string {
  return join(dir, `${session}.control.sock`);
}

export function subscribe(path: string, onLine: (line: KomuxLine) => void, onClose: () => void): Promise<{ close: () => void }> {
  let buffer = "";
  return Bun.connect({
    unix: path,
    socket: {
      data(_socket, data) {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const text of lines) {
          if (text.trim() === "") continue;
          try {
            const parsed = komuxLine.safeParse(JSON.parse(text));
            if (parsed.success) onLine(parsed.data);
          } catch {}
        }
      },
      close: () => onClose(),
      error: () => onClose(),
    },
  }).then((socket) => ({ close: () => socket.end() }));
}

export async function sendKomux(path: string, request: unknown, timeoutMs = 3000): Promise<{ ok: boolean; error?: string; result?: unknown }> {
  return new Promise((resolve) => {
    let received = "";
    const timer = setTimeout(() => resolve({ ok: false, error: "komux did not answer" }), timeoutMs);
    Bun.connect({
      unix: path,
      socket: {
        open: (socket) => void socket.write(`${JSON.stringify(request)}\n`),
        data(socket, data) {
          received += data.toString();
          const newline = received.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timer);
          socket.end();
          resolve(JSON.parse(received.slice(0, newline)));
        },
        error(_socket, error) {
          clearTimeout(timer);
          resolve({ ok: false, error: error.message });
        },
      },
    }).catch((error: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
  });
}
