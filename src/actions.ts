import { ask } from "./client.ts";

export type Actions = {
  go: (strand: string) => Promise<unknown>;
  forget: (strand: string) => Promise<unknown>;
  snooze: (strand: string, until: number) => Promise<unknown>;
  note: (braid: string, text: string) => Promise<unknown>;
  point: (dir: string, braid: string) => Promise<unknown>;
  seen: (braid: string) => Promise<unknown>;
};

export const serviceActions: Actions = {
  go: (strand) => ask({ method: "go", params: { strand } }),
  forget: (strand) => ask({ method: "forget", params: { strand } }),
  snooze: (strand, until) => ask({ method: "snooze", params: { strand, until } }),
  note: (braid, text) => ask({ method: "note", params: { braid, text } }),
  point: (dir, braid) => ask({ method: "point", params: { dir, braid } }),
  seen: (braid) => ask({ method: "seen", params: { braid } }),
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
