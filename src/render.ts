import type { BraidView, Snapshot, StrandView } from "./core.ts";
import type { Recorded } from "./events.ts";

export type Row = { text: string; strand?: StrandView; braid?: BraidView; tone?: Tone };
export type Tone = "you" | "agent" | "waiting" | "quiet" | "heading" | "dim";

export function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

export function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function glyph(strand: StrandView, now: number): string {
  if (strand.whose === "you") return (strand.snoozedUntil ?? 0) > now ? "◷" : "●";
  if (strand.whose === "agent") return "◐";
  if (strand.whose === "machine" || strand.whose === "person") return "⊘";
  return "○";
}

export function tone(strand: StrandView, now: number): Tone {
  if (strand.whose === "you") return (strand.snoozedUntil ?? 0) > now ? "quiet" : "you";
  if (strand.whose === "agent") return "agent";
  if (strand.whose === "machine" || strand.whose === "person") return "waiting";
  return "quiet";
}

export function holder(strand: StrandView, now: number): string {
  switch (strand.whose) {
    case "you":
      if ((strand.snoozedUntil ?? 0) > now) return `snoozed till ${clock(strand.snoozedUntil!)}`;
      return strand.dismissed ? "yours, toast dismissed" : strand.seen ? "yours, seen" : "yours";
    case "agent":
      return "agent working";
    case "machine":
    case "person":
      return strand.who ? `waiting on ${strand.who}` : `waiting on a ${strand.whose}`;
    case "nobody":
      return "idle";
  }
}

export function cause(strand: StrandView): string {
  const by = strand.source === "agent" ? "reported: " : strand.source === "you" ? "you: " : "";
  return `${by}${strand.why} ${clock(strand.updated)}`;
}

export function braidTitle(braid: BraidView): string {
  const kind = braid.kind === "epic" ? " (epic)" : "";
  return braid.title ? `${braid.name}  ${braid.title}${kind}` : braid.name;
}

export function tabsText(braid: BraidView): string {
  const numbers = braid.tabs.map((tab) => tab.number).filter((number) => number !== undefined);
  if (numbers.length === 0) return braid.strands.some((strand) => strand.live) ? "" : "no tab";
  return `tab ${numbers.join(", ")}`;
}

export function countsLine(snapshot: Snapshot): string {
  const { yours, agents, snoozed, waiting } = snapshot.counts;
  return `● ${yours} yours · ◐ ${agents} agents · ◷ ${snoozed} · ⊘ ${waiting}`;
}

export function strandLine(strand: StrandView, now: number, unseen: boolean): string {
  const label = `${strand.label}${strand.live || strand.kind === "report" ? "" : " (gone)"}`;
  const clockText = strand.whose === "nobody" ? "" : age(now - strand.since);
  return `     ${glyph(strand, now)}${unseen ? "*" : " "}${fit(label, 22)} ${fit(holder(strand, now), 26)} ${clockText.padStart(6)}   ${cause(strand)}`;
}

export function rows(snapshot: Snapshot, width: number, heardCount = 8): Row[] {
  const now = snapshot.now;
  const unseen = new Set(snapshot.unseen);
  const out: Row[] = [];
  const title = " ◆ ponpoko";
  const counts = countsLine(snapshot);
  out.push({ text: `${title}${" ".repeat(Math.max(2, width - title.length - counts.length - 1))}${counts}`, tone: "heading" });
  out.push({ text: "" });
  if (snapshot.braids.length === 0) out.push({ text: "  Nothing yet. ponpoko fills in as komux reports tabs, agents and jobs.", tone: "dim" });
  for (const braid of snapshot.braids) {
    const head = ` ▾ ${braidTitle(braid)}`;
    const where = tabsText(braid);
    out.push({ text: `${fit(head, Math.max(20, width - where.length - 2))}  ${where}`, braid, tone: "heading" });
    for (const strand of braid.strands) out.push({ text: strandLine(strand, now, unseen.has(strand.id)), strand, braid, tone: tone(strand, now) });
    for (const note of braid.notes.slice(-2)) out.push({ text: `     ✎ ${note.text}  ${clock(note.at)}`, braid, tone: "dim" });
  }
  if (heardCount > 0 && snapshot.heard.length > 0) {
    out.push({ text: "" });
    const labels = labelsOf(snapshot);
    snapshot.heard.slice(0, heardCount).forEach((event, index) => {
      out.push({ text: `${index === 0 ? " heard" : "      "}   ${clock(event.at)} ${event.source.padEnd(7)}  ${describe(event, labels)}`, tone: "dim" });
    });
  }
  return out;
}

function labelsOf(snapshot: Snapshot): { braids: Map<string, string>; strands: Map<string, string> } {
  const braids = new Map(snapshot.braids.map((braid) => [braid.id, braid.name]));
  const strands = new Map(snapshot.braids.flatMap((braid) => braid.strands.map((strand) => [strand.id, `${braid.name} ${strand.label}`] as const)));
  return { braids, strands };
}

export function describe(event: Recorded, labels: { braids: Map<string, string>; strands: Map<string, string> }): string {
  const braid = (id: string) => labels.braids.get(id) ?? id;
  const strand = (id: string) => labels.strands.get(id) ?? id;
  switch (event.type) {
    case "braid.made":
      return `new braid ${event.name}`;
    case "braid.titled":
      return `${braid(event.braid)} is a ${event.kind}`;
    case "braid.note":
      return `${braid(event.braid)} note added`;
    case "braid.seen":
      return `${braid(event.braid)} caught up`;
    case "dir.pointed":
      return `${event.dir} → ${braid(event.braid)}`;
    case "strand.move":
    {
      const to = event.whose === "you" ? "→ you" : event.whose === "agent" ? "working" : event.whose === "nobody" ? "idle" : event.who ? `waiting on ${event.who}` : `→ ${event.whose}`;
      return `${braid(event.braid)} ${event.label} ${to}${event.why === to ? "" : `: ${event.why}`}`;
    }
    case "strand.ended":
      return `${strand(event.strand)} ended: ${event.why}`;
    case "strand.dismissed":
      return `${strand(event.strand)} toast dismissed`;
    case "strand.seen":
      return `${strand(event.strand)} seen`;
    case "strand.snoozed":
      return `${strand(event.strand)} snoozed till ${clock(event.until)}`;
    case "strand.forgotten":
      return `${strand(event.strand)} forgotten`;
  }
}

export function fit(text: string, width: number): string {
  const chars = [...text];
  if (chars.length > width) return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
  return text + " ".repeat(width - chars.length);
}
