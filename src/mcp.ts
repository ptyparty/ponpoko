import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ask, state } from "./client.ts";
import { komuxSelf } from "./komux/self.ts";
import { splitPath, underOf, type Snapshot, type StrandView } from "./core.ts";
import { prName, prRef } from "./github.ts";
import type { Recorded } from "./events.ts";
import { age, cause, clock, describe, holder, pathText } from "./render.ts";
import type { Request } from "./server.ts";

const instructions = `ponpoko tracks the user's work as strands, lines of work that nest (a project holds stories, a story holds smaller strands), and what's asked of whom on each. It already hears komux: the user's prompts are requests to you, and your turn ends answer them; a reply that toasts in full asks the user to read it. Tell it what it can't see:

- You start on a piece of work, or move to another step: call status with text, a line on what you're doing now. Your strand is the one your tab is on; name a strand under it as a path, such as "review findings › 4", to work there. Missing strands on the path are made; give every strand you make for the user a title that says what it's about, such as "review merlin: consolidation toggle". Naming a strand outside yours is refused: that work needs a Claude of its own.
- You open a pull request for the strand, or push to one: call status with pr set to its URL. ponpoko then watches its reviews (Copilot, requested reviewers, the team), so don't report those yourself.
- You need something from someone ponpoko can't see (a person's answer in Slack, CI, a deploy): call ask with who, kind "machine", "person" or "group", and what you need. When it comes, call ask again with over true and the same who.
- The user must do something komux can't see, such as a live test: call ask with kind "you".
- A strand can't go on until another strand lands, such as a story blocked on another story: call ask with on, the other strand's path. When it no longer waits, call ask with on and over true.
- A build you start as a komux job is for another strand than yours: run it as ponpoko for "<strand path>" -- <command>.
- A strand is finished: call done. A list of work to share out: call split with names, each with a title.
- You prepared a remax tour for the user to review: call split under your strand with a name for the review and tour set to the repository and the tour's name. It asks the user to review it, and going to the strand opens the tour.

When the user asks what needs them or what to do next, call moves. To see everything open on a strand, call requests. Keep lines short, with no code, customer data or secrets.`;

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

  const titleParam = z.string().max(200).optional().describe("A longer title for the strand, such as \"Let agents title the strands they make\"; replaces any title it has");

  server.registerTool(
    "status",
    {
      title: "Say what you're doing now",
      description: "One line on what you're doing now, shown on your strand in ponpoko while you work. Name a strand under yours to work there; missing strands on the path are made. A strand outside yours is refused.",
      inputSchema: {
        text: z.string().min(1).max(120).describe("What you're doing now, such as \"making a pointed directory beat a label\""),
        page: z.string().max(200).optional().describe("Notebook page with the detail, as quoll show takes it, such as ponpoko/build-status.md"),
        title: titleParam,
        pr: z.string().max(300).optional().describe("The URL of the strand's pull request, such as https://github.com/acme/widgets/pull/821, so ponpoko watches its reviews"),
        strand: strandParam,
      },
      annotations: write,
    },
    async ({ pr, text, page, title, strand }) => {
      const report = { text, ...(page ? { page } : {}), ...(title ? { title } : {}), ...(strand ? { strand } : {}) };
      const ref = pr ? prRef(pr.trim()) : undefined;
      if (pr && !ref) return reply(`ponpoko: ${pr} isn't a GitHub pull request URL`, true);
      const link = ref ? { link: { adapter: "github", ref: `https://github.com/${ref.repo}/pull/${ref.number}`, label: prName(ref.repo, ref.number) } } : {};
      return attempt(async () => (await send({ method: "status", params: { ...caller, ...report, ...link } })) as { strand: string }, (result) => `Now on ${result.strand}${ref ? `, watching ${prName(ref.repo, ref.number)}` : ""}.`);
    },
  );

  server.registerTool(
    "ask",
    {
      title: "Ask someone for something",
      description: "Ask someone ponpoko can't see for something the strand needs: a machine such as CI, a person, a group, or the user for something komux can't see. Or, with on, say the strand waits on another strand. Call it with over true when the answer comes.",
      inputSchema: {
        who: z.string().min(1).max(80).optional().describe("CI, Sam, the team, or you for the user; leave out with on"),
        kind: z.enum(["machine", "person", "group", "you"]).optional().describe("Leave out with on"),
        what: z.string().min(1).max(200).optional().describe("Short, such as \"reviewing PR #821\"; leave out with on"),
        on: z.string().min(1).max(200).optional().describe("The strand this one waits on, as a path such as sc-1240; it shows as yours again when that strand is done"),
        over: z.boolean().optional().describe("true when the wait is over; who alone, or nothing but the strand, ends the matching waits"),
        strand: strandParam,
      },
      annotations: write,
    },
    async ({ who, kind, what, on, ...rest }) => {
      if (on && !rest.over && (who || kind || what)) return reply("ponpoko: ask either waits on a strand (on) or asks someone (who, kind and what), not both; make two calls", true);
      if (on) return attempt(async () => (await send({ method: "block-by", params: { ...caller, ...rest, on } })) as { strand: string }, (result) => `${result.strand} ${rest.over ? "no longer waits" : "waits"} on ${on}.`);
      if (!rest.over && (!who || !kind || !what)) return reply("ponpoko: name who, kind and what, or the strand it waits on with on", true);
      return attempt(async () => (await send({ method: "wait", params: { ...caller, ...rest, ...(who ? { who } : {}), ...(kind ? { kind } : {}), ...(what ? { what } : {}) } })) as { strand: string }, (result) => `${rest.over ? "Answered" : "Asked"} on ${result.strand}.`);
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
      description: "Add strands under a strand, one per name, such as the items of a list in a notebook page. Give a name with a title to title its strand, and with a tour to make it the user's move to review a remax tour you prepared; going to the strand in ponpoko opens the tour.",
      inputSchema: {
        names: z
          .array(
            z.union([
              z.string().min(1).max(120),
              z.object({
                name: z.string().min(1).max(120),
                title: titleParam,
                tour: z
                  .object({
                    repo: z.string().min(1).max(400).describe("The repository's checkout, as the -C path you gave remax tour begin"),
                    name: z.string().min(1).max(120).describe("The tour's name, as given to remax tour begin --name"),
                  })
                  .optional()
                  .describe("A remax tour waiting for the user's review"),
              }),
            ]),
          )
          .min(1)
          .max(50)
          .describe("The strands to make, each a name or { name, title, tour }"),
        strand: strandParam,
      },
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
    "requests",
    {
      title: "What's asked on a strand",
      description: "Every unanswered request on a strand and the strands under it: who it's for, who asked, what, and since when. Defaults to the strand you're on.",
      inputSchema: { strand: z.string().optional().describe("A path such as sc-1234 or ptyparty › ponpoko") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ strand }) => attempt(snapshot, (view) => requestsText(view, strand, caller)),
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

function strandFor(view: Snapshot, wanted: string | undefined, caller: Caller): StrandView | undefined {
  if (wanted) return findStrand(view, wanted);
  const mine = caller.self === undefined ? undefined : (view.strands.find((strand) => strand.open.some((move) => move.player !== "you" && move.by.place?.handle === caller.self)) ?? view.strands.find((strand) => strand.agent?.place?.handle === caller.self));
  return mine ?? view.strands.filter((strand) => strand.dir && (caller.dir === strand.dir || caller.dir.startsWith(`${strand.dir}/`))).at(-1);
}

export function requestsText(view: Snapshot, wanted: string | undefined, caller: Caller): string {
  const found = strandFor(view, wanted, caller);
  if (!found) return wanted ? `ponpoko has no strand ${wanted}.` : "ponpoko can't tell which strand you're on; name it.";
  const strands = [found, ...underOf(view.strands, found)];
  const lines = strands.flatMap((strand) =>
    strand.requests.map((request) => `- ${pathText(strand)}: for ${request.to}${request.claimedBy ? ` (claimed by ${request.claimedBy})` : ""}: ${request.what}${request.from ? `, asked by ${request.from}` : ""}${request.kind ? ` [${request.kind}]` : ""}, ${age(view.now - request.since)} (${request.id})`),
  );
  return lines.length === 0 ? `Nothing is asked on ${pathText(found)} or under it.` : [`${lines.length} unanswered on ${pathText(found)}:`, ...lines].join("\n");
}

export function strandText(view: Snapshot, wanted: string | undefined, caller: Caller): string {
  const found = strandFor(view, wanted, caller);
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
    ...(found.rolled.tally ? [`Asked here and under it: ${found.rolled.tally}`] : []),
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
