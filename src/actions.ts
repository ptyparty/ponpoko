import { ask } from "./client.ts";
import type { StrandView } from "./core.ts";
import { goInKomux, goTarget, pickup, pickUpInKomux, type Pickup } from "./komux/go.ts";
import { age } from "./render.ts";
import type { Link } from "./model.ts";
import { parseWhen, whenLabel } from "./when.ts";

export type Actions = {
  go: (strand: StrandView, strands: StrandView[]) => Promise<unknown>;
  pickUp: (strand: StrandView, how: "resume" | "fresh") => Promise<unknown>;
  forget: (strand: string) => Promise<unknown>;
  snooze: (strand: string, until: number) => Promise<unknown>;
  note: (strand: string, text: string) => Promise<unknown>;
  point: (dir: string, to: string) => Promise<unknown>;
  seen: (strand: string) => Promise<unknown>;
  add: (parent: string | undefined, name: string) => Promise<unknown>;
  reparent: (strand: string, to: string) => Promise<unknown>;
  block: (strand: string, on: string) => Promise<unknown>;
  unblock: (strand: string, on?: string) => Promise<unknown>;
  rename: (strand: string, name: string) => Promise<unknown>;
  done: (strand: string) => Promise<unknown>;
  open: (link: Link) => Promise<unknown>;
};

export const serviceActions: Actions = {
  go: async (strand, strands) => {
    await goInKomux(strand, strands);
    const target = goTarget(strand, strands);
    if (target?.player.kind === "job") await ask({ method: "close-move", params: { move: target.move.id } });
    else if (strand.unseen) await ask({ method: "seen", params: { strand: strand.id } });
  },
  pickUp: (strand, how) => pickUpInKomux(strand, how),
  forget: (strand) => ask({ method: "forget", params: { strand } }),
  snooze: (strand, until) => ask({ method: "snooze", params: { strand, until } }),
  note: (strand, text) => ask({ method: "note", params: { strand, text } }),
  point: (dir, to) => ask({ method: "point", params: { dir, to } }),
  seen: (strand) => ask({ method: "seen", params: { strand } }),
  add: (parent, name) => ask({ method: "add", params: { ...(parent ? { parent } : {}), name } }),
  reparent: (strand, to) => ask({ method: "reparent", params: { strand, to } }),
  block: (strand, on) => ask({ method: "block", params: { strand, on } }),
  unblock: (strand, on) => ask({ method: "unblock", params: { strand, ...(on ? { on } : {}) } }),
  rename: (strand, name) => ask({ method: "rename", params: { strand, name } }),
  done: (strand) => ask({ method: "done", params: { strand } }),
  open: async (link) => {
    if (link.adapter !== "quoll") throw new Error(`ponpoko can't open ${link.adapter} links yet`);
    const shown = Bun.spawnSync(["quoll", "show", link.ref], { stdout: "pipe", stderr: "pipe" });
    if (shown.exitCode !== 0) throw new Error(`quoll show: ${shown.stderr.toString().trim() || shown.stdout.toString().trim()}`);
  },
};

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
];

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
