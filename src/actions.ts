import { ask } from "./client.ts";
import type { Knowledge } from "./core.ts";
import { epicChanges, epicFacts } from "./epics.ts";
import type { Request } from "./server.ts";
import { epicStories, type EpicLookup } from "./shortcut.ts";
import type { StrandView } from "./core.ts";
import { goInKomux, goTarget, pickup, pickUpInKomux, type Pickup } from "./komux/go.ts";
import { age } from "./render.ts";
import { dormant, type Link } from "./model.ts";
import { assignMe, markReady, prName, prRef, samePr, type Gh } from "./github.ts";
import { assignFacts, isBookkeeping, mentionLink, ownPrs, prAdapter, source as githubSource, type OwnPrView } from "./inbox.ts";
import { showTour, strandTour } from "./remax.ts";
import { parseWhen, whenLabel } from "./when.ts";

export type Actions = {
  go: (strand: StrandView, strands: StrandView[]) => Promise<unknown>;
  assign: (strand: StrandView) => Promise<unknown>;
  pickUp: (strand: StrandView, how: "resume" | "fresh") => Promise<unknown>;
  forget: (strand: string) => Promise<unknown>;
  snooze: (strand: string, until: number) => Promise<unknown>;
  note: (strand: string, text: string) => Promise<unknown>;
  point: (dir: string, to: string) => Promise<unknown>;
  seen: (strand: string) => Promise<unknown>;
  start: (strand: string) => Promise<unknown>;
  refreshEpic: (strand: string, epic: number) => Promise<string>;
  add: (parent: string | undefined, name: string) => Promise<unknown>;
  reparent: (strand: string, to: string) => Promise<unknown>;
  block: (strand: string, on: string) => Promise<unknown>;
  unblock: (strand: string, on?: string) => Promise<unknown>;
  rename: (strand: string, name: string) => Promise<unknown>;
  title: (strand: string, title: string) => Promise<unknown>;
  done: (strand: string) => Promise<unknown>;
  open: (link: Link) => Promise<unknown>;
  ready: (strand: StrandView, url: string) => Promise<string>;
};

export function draftsOf(strand: StrandView): OwnPrView[] {
  return ownPrs(strand).filter((pr) => pr.draft && pr.state !== "closed");
}

export async function readyDrafts(strand: StrandView, gh?: Gh, url?: string): Promise<string> {
  const drafts = draftsOf(strand).filter((pr) => url === undefined || samePr(pr.url, url));
  if (drafts.length === 0) throw new Error(`${strand.name} has no draft pull request`);
  for (const pr of drafts) await markReady(pr.url, gh);
  return `Marked ${drafts.map((pr) => prName(pr.repo, pr.number)).join(", ")} ready for review`;
}

const openable = new Set(["remax", prAdapter, "quoll", "shortcut"]);

export function openableLink(strand: StrandView): Link | undefined {
  const moveLinks = strand.recent.flatMap((move) => move.links);
  const prs = ownPrs(strand).filter((pr) => pr.state !== "closed");
  if (prs.length > 0) {
    const pr = [...moveLinks].sort((a, b) => a.at - b.at).reverse().find((link) => link.adapter === prAdapter && prs.some((own) => samePr(own.url, link.ref)));
    return pr ?? strand.links.find((link) => link.adapter === prAdapter && prs.some((own) => samePr(own.url, link.ref)));
  }
  return [...moveLinks, ...strand.links]
    .filter((candidate) => openable.has(candidate.adapter) && !isBookkeeping(candidate))
    .sort((a, b) => a.at - b.at)
    .at(-1);
}

export const serviceActions: Actions = {
  go: async (strand, strands) => {
    const mention = mentionLink(strand);
    if (mention) {
      openUrl(mention.ref);
      if (strand.unseen) await ask({ method: "seen", params: { strand: strand.id } });
      return;
    }
    const landing = await goInKomux(strand, strands);
    const tour = strandTour(strand);
    if (tour) await showTour(tour, landing.tabDir);
    const target = goTarget(strand, strands);
    if (target?.player.kind === "job") await ask({ method: "close-move", params: { move: target.move.id } });
    else if (strand.unseen) await ask({ method: "seen", params: { strand: strand.id } });
  },
  assign: async (strand) => {
    const link = strand.links.find((candidate) => candidate.adapter === prAdapter && prRef(candidate.ref));
    if (!link) throw new Error("this strand doesn't link to a pull request");
    await assignMe(link.ref);
    await ask({ method: "record", params: { source: githubSource, facts: assignFacts(strand, (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`) } });
  },
  pickUp: (strand, how) => pickUpInKomux(strand, how),
  forget: (strand) => ask({ method: "forget", params: { strand } }),
  snooze: (strand, until) => ask({ method: "snooze", params: { strand, until } }),
  note: (strand, text) => ask({ method: "note", params: { strand, text } }),
  point: (dir, to) => ask({ method: "point", params: { dir, to } }),
  seen: (strand) => ask({ method: "seen", params: { strand } }),
  start: (strand) => ask({ method: "start", params: { strand } }),
  refreshEpic: (strand, epic) => refreshEpic(strand, epic),
  add: (parent, name) => ask({ method: "add", params: { ...(parent ? { parent } : {}), name } }),
  reparent: (strand, to) => ask({ method: "reparent", params: { strand, to } }),
  block: (strand, on) => ask({ method: "block", params: { strand, on } }),
  unblock: (strand, on) => ask({ method: "unblock", params: { strand, ...(on ? { on } : {}) } }),
  rename: (strand, name) => ask({ method: "rename", params: { strand, name } }),
  title: (strand, title) => ask({ method: "title", params: { strand, title } }),
  done: (strand) => ask({ method: "done", params: { strand } }),
  ready: (strand, url) => readyDrafts(strand, undefined, url),
  open: async (link) => {
    if (link.adapter === "remax") return showTour(link, process.env.KOMUX_TAB_DIR);
    if (link.adapter === prAdapter || link.adapter === "shortcut") return openUrl(link.ref);
    if (link.adapter !== "quoll") throw new Error(`ponpoko can't open ${link.adapter} links yet`);
    const shown = Bun.spawnSync(["quoll", "show", link.ref], { stdout: "pipe", stderr: "pipe" });
    if (shown.exitCode !== 0) throw new Error(`quoll show: ${shown.stderr.toString().trim() || shown.stdout.toString().trim()}`);
  },
};

export async function refreshEpic(strand: string, epic: number, lookup: EpicLookup = epicStories, send: (request: Request) => Promise<unknown> = ask): Promise<string> {
  const stories = await lookup(epic);
  const facts = epicFacts((await send({ method: "knowledge" })) as Knowledge, strand, epic, stories, (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`);
  await send({ method: "record", params: { source: "shortcut", facts } });
  return `From Shortcut: ${epicChanges(facts)}`;
}

export function openUrl(url: string): void {
  if (!/^https:\/\//.test(url)) throw new Error(`ponpoko only opens https links, not ${url}`);
  Bun.spawn(["xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
}

export type SnoozeChoice = { key: string; label: string; until: (now: number) => number };

export const snoozeChoices: SnoozeChoice[] = [
  { key: "1", label: "15m", until: (now) => now + 15 * 60_000 },
  { key: "2", label: "1h", until: (now) => now + 60 * 60_000 },
  { key: "3", label: "4h", until: (now) => now + 4 * 60 * 60_000 },
  {
    key: "4",
    label: "tomorrow 9:00",
    until: (now) => {
      const date = new Date(now);
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
      return date.getTime();
    },
  },
  { key: "0", label: "till woken", until: () => dormant },
];

export function readyLine(drafts: OwnPrView[]): string {
  return `mark ready  ${drafts.slice(0, 9).map((pr, at) => `${at + 1} ${prName(pr.repo, pr.number)}`).join("  ")}  esc`;
}

export function readyChoice(drafts: OwnPrView[], key: string): OwnPrView | undefined {
  return /^[1-9]$/.test(key) ? drafts[Number(key) - 1] : undefined;
}

export function snoozeLine(): string {
  return `snooze  ${snoozeChoices.map((choice) => `${choice.key} ${choice.label}`).join("  ")}  t a time  esc`;
}

export function timeLine(typed: string, now: number): string {
  const until = parseWhen(typed, now);
  const reading = until !== undefined ? `→ ${whenLabel(until, now)}` : typed.trim() === "" ? "such as 14:30, mon 9, 2h, nov 12" : "→ ?";
  return `snooze until: ${typed}▏  ${reading}   ⏎ snooze   esc cancel`;
}

export { pickup };

export function pickupLine(options: Pickup, now: number): string {
  if (!options.resume) return "⏎ start a fresh Claude on it   esc cancel";
  const ago = age(now - options.resume.at);
  return `⏎ resume ${options.resume.who} from ${ago === "now" ? "just now" : `${ago} ago`}   f start a fresh Claude   esc cancel`;
}

export function pickupChoice(options: Pickup, key: string): "resume" | "fresh" | undefined {
  if (key === "return" || key === "r") return options.resume ? "resume" : "fresh";
  if (key === "f") return "fresh";
  return undefined;
}
