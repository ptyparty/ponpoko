import { ask } from "./client.ts";
import type { StrandView } from "./core.ts";
import { goInKomux, goTarget } from "./komux/go.ts";
import type { Link } from "./model.ts";

export type Actions = {
  go: (strand: StrandView) => Promise<unknown>;
  forget: (strand: string) => Promise<unknown>;
  snooze: (strand: string, until: number) => Promise<unknown>;
  note: (strand: string, text: string) => Promise<unknown>;
  point: (dir: string, to: string) => Promise<unknown>;
  seen: (strand: string) => Promise<unknown>;
  add: (parent: string | undefined, name: string) => Promise<unknown>;
  reparent: (strand: string, to: string) => Promise<unknown>;
  done: (strand: string) => Promise<unknown>;
  open: (link: Link) => Promise<unknown>;
};

export const serviceActions: Actions = {
  go: async (strand) => {
    await goInKomux(strand);
    const target = goTarget(strand);
    if (target?.player.kind === "job") await ask({ method: "close-move", params: { move: target.move.id } });
    else if (strand.unseen) await ask({ method: "seen", params: { strand: strand.id } });
  },
  forget: (strand) => ask({ method: "forget", params: { strand } }),
  snooze: (strand, until) => ask({ method: "snooze", params: { strand, until } }),
  note: (strand, text) => ask({ method: "note", params: { strand, text } }),
  point: (dir, to) => ask({ method: "point", params: { dir, to } }),
  seen: (strand) => ask({ method: "seen", params: { strand } }),
  add: (parent, name) => ask({ method: "add", params: { ...(parent ? { parent } : {}), name } }),
  reparent: (strand, to) => ask({ method: "reparent", params: { strand, to } }),
  done: (strand) => ask({ method: "done", params: { strand } }),
  open: async (link) => {
    if (link.adapter !== "quoll") throw new Error(`ponpoko can't open ${link.adapter} links yet`);
    const shown = Bun.spawnSync(["quoll", "show", link.ref], { stdout: "pipe", stderr: "pipe" });
    if (shown.exitCode !== 0) throw new Error(`quoll show: ${shown.stderr.toString().trim() || shown.stdout.toString().trim()}`);
  },
};

export type SnoozeChoice = { key: string; label: string; until: (now: number) => number };

export const snoozeChoices: SnoozeChoice[] = [
  { key: "1", label: "15 minutes", until: (now) => now + 15 * 60_000 },
  { key: "2", label: "1 hour", until: (now) => now + 60 * 60_000 },
  { key: "3", label: "4 hours", until: (now) => now + 4 * 60 * 60_000 },
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
  return `snooze for  ${snoozeChoices.map((choice) => `${choice.key} ${choice.label}`).join("   ")}   esc cancel`;
}
