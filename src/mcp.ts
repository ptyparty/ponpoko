import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ask, state } from "./client.ts";
import type { Snapshot } from "./core.ts";
import type { Recorded } from "./events.ts";
import { age, braidTitle, cause, clock, describe, holder } from "./render.ts";
import type { Request } from "./server.ts";

const instructions = `ponpoko tracks whose move each piece of the user's work is. It already hears komux: while you work the move is yours, and when your turn ends it's the user's. Report only what it can't see:

- You stop to wait on someone or something other than the user (a Copilot or human PR review, CI, a deploy, another story, a person's answer): call report with a strand named for the wait, such as "PR #821 review", whose "machine" or "person", and who.
- The wait ends: report the same strand with whose "done".
- The user must do something komux can't see, such as a live test: report on your own strand (no strand name) with whose "you".
- You start a long stretch of work: call status with a line on what you're doing now, and the notebook page holding the detail if there is one. Update it as you move between steps.

When the user asks what needs them or what to do next, call moves. Keep reasons and status lines short, with no code, customer data or secrets.`;

export type Caller = { session?: string; paneId?: number; dir: string };

export function callerFromEnv(env = process.env, cwd = process.cwd()): Caller {
  const paneId = Number(env.KOMUX_PANE_ID);
  return { dir: cwd, ...(env.KOMUX_SESSION ? { session: env.KOMUX_SESSION } : {}), ...(Number.isInteger(paneId) && env.KOMUX_PANE_ID ? { paneId } : {}) };
}

type Send = (request: Request) => Promise<unknown>;

export function createServer(caller: Caller = callerFromEnv(), send: Send = ask, snapshot: () => Promise<Snapshot> = state): McpServer {
  const server = new McpServer({ name: "ponpoko", version: "0.1.0" }, { instructions });

  server.registerTool(
    "report",
    {
      title: "Report whose move it is",
      description: "Say who holds a strand's move now and why. Name the strand for what you wait on (\"PR #821 review\", \"CI on PR #821\", \"blocked on SC-1240\"); leave it out to report on your own strand. whose \"done\" ends the strand.",
      inputSchema: {
        whose: z.enum(["you", "agent", "machine", "person", "nobody", "done"]).describe("you = the user; machine = CI, Copilot, a deploy, another story; person = someone other than the user"),
        reason: z.string().min(1).max(200).describe("Short, such as \"waiting on Copilot review of PR #821\""),
        who: z.string().max(80).optional().describe("Who or what holds it, such as Copilot, CI, SC-1240 or Sam"),
        strand: z.string().max(80).optional().describe("The strand's name; leave out for your own"),
        braid: z.string().optional().describe("Story or braid, such as sc-1234; defaults to where you're running"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => attempt(async () => (await send({ method: "report", params: { ...caller, ...input } })) as { strand: string }, (result) => `Recorded on ${result.strand}.`),
  );

  server.registerTool(
    "status",
    {
      title: "Say what you're doing now",
      description: "Set a one-line status on your strand, shown under it in ponpoko's command tab, optionally with the notebook page holding the detail. Send an empty text to clear it.",
      inputSchema: {
        text: z.string().max(120).describe("What you're on now, such as \"step 3 of 10: the command tab\""),
        page: z.string().max(200).optional().describe("Notebook page with the detail, as quoll show takes it, such as ponpoko/build-status.md"),
        strand: z.string().max(80).optional().describe("A strand you reported by name; leave out for your own"),
        braid: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => attempt(async () => (await send({ method: "status", params: { ...caller, ...input } })) as { strand: string }, (result) => `Status set on ${result.strand}.`),
  );

  server.registerTool(
    "moves",
    {
      title: "Moves waiting on the user",
      description: "The moves waiting on the user, oldest first, across every story and piece of side work. Use it to answer \"what should I be doing?\".",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => attempt(snapshot, movesText),
  );

  server.registerTool(
    "braid",
    {
      title: "One braid's strands",
      description: "One story's or piece of side work's strands, whose move each is, and its recent events. Defaults to where you're running.",
      inputSchema: { braid: z.string().optional().describe("Such as sc-1234, or a side-work name like ptyparty") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ braid }) => attempt(snapshot, (view) => braidText(view, braid, caller)),
  );

  server.registerTool(
    "changes",
    {
      title: "What changed",
      description: "What ponpoko heard since a time, oldest first.",
      inputSchema: { since: z.string().describe("An ISO time, or a span back from now such as 90m, 3h or 2d") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ since }) => {
      const at = parseSince(since, Date.now());
      if (at === undefined) return reply(`Can't read ${JSON.stringify(since)} as a time; use ISO or a span like 3h.`, true);
      return attempt(
        async () => ({ events: (await send({ method: "changes", params: { since: at } })) as Recorded[], view: await snapshot() }),
        ({ events, view }) => changesText(events, view),
      );
    },
  );

  return server;
}

export async function runMcp(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

async function attempt<T>(work: () => Promise<T>, text: (result: T) => string): Promise<CallToolResult> {
  try {
    return reply(text(await work()));
  } catch (error) {
    return reply(`ponpoko: ${(error as Error).message}`, true);
  }
}

function reply(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

export function movesText(view: Snapshot): string {
  if (view.moves.length === 0) return "Nothing is waiting on the user.";
  const name = (id: string) => {
    const braid = view.braids.find((candidate) => candidate.id === id);
    return braid ? braidTitle(braid) : id;
  };
  return [
    `${view.moves.length} move${view.moves.length === 1 ? "" : "s"} waiting on the user, oldest first:`,
    ...view.moves.map((strand) => `- ${name(strand.braid)}: ${strand.label}, ${cause(strand)}, ${age(view.now - strand.since)}${strand.live ? strand.tab ? ` (tab ${strand.tab.number} ${strand.tab.name})` : "" : " (its pane is gone)"}`),
  ].join("\n");
}

export function braidText(view: Snapshot, wanted: string | undefined, caller: Caller): string {
  const braid = wanted
    ? view.braids.find((candidate) => candidate.id === wanted.toLowerCase() || candidate.id === wanted || candidate.name.toLowerCase() === wanted.toLowerCase())
    : view.braids.find((candidate) => candidate.strands.some((strand) => strand.place?.paneId === caller.paneId && strand.place?.session === caller.session)) ??
      view.braids.find((candidate) => candidate.dir !== undefined && (caller.dir === candidate.dir || caller.dir.startsWith(`${candidate.dir}/`)));
  if (!braid) return wanted ? `ponpoko has no braid ${wanted}.` : "ponpoko can't tell which braid you're in; name it.";
  const labels = { braids: new Map(view.braids.map((entry) => [entry.id, entry.name])), strands: new Map(braid.strands.map((strand) => [strand.id, strand.label])) };
  const events = view.heard.filter((event) => ("braid" in event && event.braid === braid.id) || ("strand" in event && labels.strands.has(event.strand)));
  return [
    braidTitle(braid),
    ...(braid.strands.length === 0 ? ["No strands."] : braid.strands.map((strand) => `- ${strand.label}: ${holder(strand, view.now)}, ${cause(strand)}${strand.doing ? `; now: ${strand.doing.text}` : ""}`)),
    ...braid.notes.map((note) => `- note ${clock(note.at)}: ${note.text}`),
    ...(events.length > 0 ? ["Recent:", ...events.slice(0, 10).map((event) => `- ${clock(event.at)} ${describe(event, labels)}`)] : []),
  ].join("\n");
}

function changesText(events: Recorded[], view: Snapshot): string {
  if (events.length === 0) return "Nothing changed.";
  const labels = {
    braids: new Map(view.braids.map((braid) => [braid.id, braid.name])),
    strands: new Map(view.braids.flatMap((braid) => braid.strands.map((strand) => [strand.id, `${braid.name} ${strand.label}`] as const))),
  };
  const shown = events.slice(-100);
  return [...(events.length > shown.length ? [`(${events.length - shown.length} earlier changes left out)`] : []), ...shown.map((event) => `- ${new Date(event.at).toISOString()} ${event.source}: ${describe(event, labels)}`)].join("\n");
}

export function parseSince(text: string, now: number): number | undefined {
  const span = /^(\d+)\s*([mhd])$/.exec(text.trim());
  if (span) return now - Number(span[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2] as "m"];
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}
