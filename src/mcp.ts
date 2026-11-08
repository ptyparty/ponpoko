import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ask, state } from "./client.ts";
import { komuxSelf } from "./komux/self.ts";
import { splitPath, type Snapshot, type StrandView } from "./core.ts";
import type { Recorded } from "./events.ts";
import { age, cause, clock, describe, holder, pathText } from "./render.ts";
import type { Request } from "./server.ts";

const instructions = `ponpoko tracks the user's work as strands, lines of work that nest (a project holds stories, a story holds smaller strands), and whose move each one is. It already hears komux: while you work the move is yours, and when your turn ends it's the user's. Tell it what it can't see:

- You start on a piece of work, or move to another: call status with a line on what you're doing now, and the strand you're on as a path such as "ponpoko review findings › 4". Missing strands on the path are made. Leave the strand out to stay where you are. Call it again as you move between steps; each call is a move on the strand.
- You stop to wait on someone or something other than the user (a Copilot or human PR review, CI, a deploy, a person's answer): call wait with who, kind "machine" or "person", and what you're waiting for. When the wait ends, call wait again with over true.
- The user must do something komux can't see, such as a live test: call wait with kind "you".
- A strand can't go on until another strand lands, such as a story blocked on another story: call wait with on, the other strand's path. When it no longer waits, call wait with on and over true.
- A strand is finished: call done. A list of work to share out: call split with the names.

When the user asks what needs them or what to do next, call moves. Keep lines short, with no code, customer data or secrets.`;

export type Caller = { self?: string; dir: string };

export function callerFromEnv(env = process.env, cwd = process.cwd()): Caller {
  const self = komuxSelf(env);
  return { dir: cwd, ...(self ? { self } : {}) };
}

type Send = (request: Request) => Promise<unknown>;

export function createServer(caller: Caller = callerFromEnv(), send: Send = ask, snapshot: () => Promise<Snapshot> = state): McpServer {
  const server = new McpServer({ name: "ponpoko", version: "0.1.0" }, { instructions });

  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const strandParam = z.string().max(200).optional().describe("The strand as a path, such as \"ponpoko review findings › 4\"; leave out for the one you're on. A path that matches nothing is made under the strand you're on; start it with › to make it at the top");

  server.registerTool(
    "status",
    {
      title: "Say what you're doing now",
      description: "Make a move on a strand: one line on what you're doing now, shown on the strand in ponpoko and kept in its record of moves. Name the strand to start on it or switch to it; missing strands on the path are made.",
      inputSchema: {
        text: z.string().min(1).max(120).describe("What you're doing now, such as \"making a pointed directory beat a label\""),
        page: z.string().max(200).optional().describe("Notebook page with the detail, as quoll show takes it, such as ponpoko/build-status.md"),
        strand: strandParam,
      },
      annotations: write,
    },
    async (input) => attempt(async () => (await send({ method: "status", params: { ...caller, ...input } })) as { strand: string }, (result) => `Now on ${result.strand}.`),
  );

  server.registerTool(
    "wait",
    {
      title: "Hand a strand to someone",
      description: "Say a strand now waits on someone other than you: a machine such as Copilot or CI, a person, or the user for something komux can't see. Or, with on, say it waits on another strand. Call it with over true when the wait ends.",
      inputSchema: {
        who: z.string().min(1).max(80).optional().describe("Copilot, CI, Sam, or you for the user; leave out with on"),
        kind: z.enum(["machine", "person", "you"]).optional().describe("Leave out with on"),
        what: z.string().min(1).max(200).optional().describe("Short, such as \"reviewing PR #821\"; leave out with on"),
        on: z.string().min(1).max(200).optional().describe("The strand this one waits on, as a path such as sc-1240; it shows as yours again when that strand is done"),
        over: z.boolean().optional().describe("true when the wait is over"),
        strand: strandParam,
      },
      annotations: write,
    },
    async ({ who, kind, what, on, ...rest }) => {
      if (on && (who || kind || what)) return reply("ponpoko: a wait is either on a strand (on) or on someone (who, kind and what), not both; make two calls", true);
      if (on) return attempt(async () => (await send({ method: "block-by", params: { ...caller, ...rest, on } })) as { strand: string }, (result) => `${result.strand} ${rest.over ? "no longer waits" : "waits"} on ${on}.`);
      if (!who || !kind || !what) return reply("ponpoko: name who, kind and what, or the strand it waits on with on", true);
      return attempt(async () => (await send({ method: "wait", params: { ...caller, ...rest, who, kind, what } })) as { strand: string }, (result) => `${rest.over ? "Wait over" : "Waiting"} on ${result.strand}.`);
    },
  );

  server.registerTool(
    "done",
    {
      title: "Mark a strand done",
      description: "Mark a strand finished, so it leaves ponpoko's lists.",
      inputSchema: { strand: strandParam, why: z.string().max(200).optional() },
      annotations: write,
    },
    async (input) => attempt(async () => (await send({ method: "done-by", params: { ...caller, ...(input.strand ? { strand: input.strand } : {}), why: input.why || "done" } })) as { strand: string }, (result) => `${result.strand} is done.`),
  );

  server.registerTool(
    "split",
    {
      title: "Split a strand",
      description: "Add strands under a strand, one per name, such as the items of a list in a notebook page.",
      inputSchema: { names: z.array(z.string().min(1).max(120)).min(1).max(50), strand: strandParam },
      annotations: write,
    },
    async (input) => attempt(async () => (await send({ method: "split", params: { ...caller, ...input } })) as { strands: string[] }, (result) => `Made ${result.strands.join("; ")}.`),
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
    "strand",
    {
      title: "One strand",
      description: "A strand, the strands under it, whose move each is, and its latest moves. Defaults to the strand you're on.",
      inputSchema: { strand: z.string().optional().describe("A path such as sc-1234 or ptyparty › ponpoko") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ strand }) => attempt(snapshot, (view) => strandText(view, strand, caller)),
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
      return attempt(async () => (await send({ method: "changes", params: { since: at } })) as { events: Recorded[]; labels: Record<string, string> }, changesText);
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
  return [
    `${view.moves.length} strand${view.moves.length === 1 ? "" : "s"} waiting on the user, oldest first:`,
    ...view.moves.map((strand) => {
      const space = strand.open.map((move) => move.answers ?? move.by).find((player) => player.live && player.space)?.space;
      return `- ${pathText(strand)}${strand.title ? ` (${strand.title})` : ""}: ${cause(strand)}, ${age(view.now - strand.own.since)}${space ? ` (${space})` : ""}`;
    }),
  ].join("\n");
}

export function strandText(view: Snapshot, wanted: string | undefined, caller: Caller): string {
  const found = wanted ? findStrand(view, wanted) : ((caller.self === undefined ? undefined : view.strands.find((strand) => strand.open.some((move) => move.player !== "you" && move.by.place?.handle === caller.self))) ?? view.strands.filter((strand) => strand.dir && (caller.dir === strand.dir || caller.dir.startsWith(`${strand.dir}/`))).at(-1));
  if (!found) return wanted ? `ponpoko has no strand ${wanted}.` : "ponpoko can't tell which strand you're on; name it.";
  const at = view.strands.indexOf(found);
  const below = [];
  for (const strand of view.strands.slice(at + 1)) {
    if (strand.depth <= found.depth) break;
    below.push(strand);
  }
  const line = (strand: StrandView) => `${"  ".repeat(strand.depth - found.depth)}- ${strand.name}: ${holder(strand, view.now) || "nothing of its own"}${cause(strand) ? `, ${cause(strand)}` : ""}`;
  return [
    `${pathText(found)}${found.title ? `  ${found.title}` : ""}`,
    line(found),
    ...below.map(line),
    ...found.notes.map((note) => `- note ${clock(note.at)}: ${note.text}`),
    ...(found.recent.length > 0 ? ["Latest moves:", ...found.recent.map((move) => `- ${clock(move.from)}${move.until ? `–${clock(move.until)}` : ""} ${move.player === "you" ? "you" : move.by.who}: ${move.what}`)] : []),
  ].join("\n");
}

export function findStrand(view: Snapshot, wanted: string): StrandView | undefined {
  const segments = splitPath(wanted).map((segment) => segment.toLowerCase());
  const matches = (strand: StrandView) => {
    const names = strand.path.map((name) => name.toLowerCase());
    return segments.length <= names.length && segments.every((segment, index) => names[names.length - segments.length + index] === segment);
  };
  return view.strands.find((strand) => matches(strand) && strand.path.length === segments.length) ?? view.strands.find(matches);
}

function changesText({ events, labels }: { events: Recorded[]; labels: Record<string, string> }): string {
  if (events.length === 0) return "Nothing changed.";
  const shown = events.slice(-100);
  return [...(events.length > shown.length ? [`(${events.length - shown.length} earlier changes left out)`] : []), ...shown.map((event) => `- ${new Date(event.at).toISOString()} ${event.source}: ${describe(event, labels)}`)].join("\n");
}

export function parseSince(text: string, now: number): number | undefined {
  const span = /^(\d+)\s*([mhd])$/.exec(text.trim());
  if (span) return now - Number(span[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2] as "m"];
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}
