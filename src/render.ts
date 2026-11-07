import type { MoveView, Snapshot, StrandView } from "./core.ts";
import type { Recorded, Whose } from "./events.ts";

export type Row = { text: string; strand?: StrandView; tone?: Tone };
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

function snoozed(strand: StrandView, now: number): boolean {
  return (strand.snoozedUntil ?? 0) > now;
}

export function glyph(whose: Whose | undefined, isSnoozed: boolean): string {
  if (whose === "you") return isSnoozed ? "◷" : "●";
  if (whose === "agent") return "◐";
  if (whose === "machine" || whose === "person") return "⊘";
  return "○";
}

export function strandGlyph(strand: StrandView, now: number): string {
  return glyph(strand.rolled.whose, strand.rolled.whose === "you" && strand.own.whose === "you" && snoozed(strand, now));
}

export function tone(strand: StrandView, now: number): Tone {
  const whose = strand.rolled.whose;
  if (whose === "you") return strand.own.whose === "you" && snoozed(strand, now) ? "quiet" : "you";
  if (whose === "agent") return "agent";
  if (whose === "machine" || whose === "person") return "waiting";
  return "quiet";
}

export function pathText(strand: StrandView): string {
  return strand.path.join(" › ");
}

export function titled(strand: StrandView): string {
  const kind = strand.kind === "epic" ? " (epic)" : "";
  return strand.title ? `${strand.name}  ${strand.title}${kind}` : `${strand.name}${kind}`;
}

function who(move: MoveView): string {
  return move.player === "you" ? (move.answers?.who ?? "you") : move.by.who;
}

export function holder(strand: StrandView, now: number): string {
  const standing = strand.own;
  const moves = strand.open.filter((move) => (move.player === "you" ? "you" : move.by.kind === "job" ? "machine" : move.by.kind) === standing.whose);
  switch (standing.whose) {
    case "you":
      if (snoozed(strand, now)) return `snoozed till ${clock(strand.snoozedUntil!)}`;
      return strand.unseen ? "yours" : strand.dismissedAt >= standing.since ? "yours, toast dismissed" : "yours, seen";
    case "agent":
      return `${moves.map((move) => move.by.who).join(", ") || "agent"} working`;
    case "machine":
    case "person":
      return `waiting on ${moves.map((move) => move.by.who).join(", ")}`;
    default:
      return "";
  }
}

export function cause(strand: StrandView): string {
  const standing = strand.own;
  if (standing.whose === undefined) return "";
  const move = strand.open.find((candidate) => candidate.from === standing.since) ?? strand.open[0];
  const answering = move?.player === "you" && move.answers ? `${move.answers.who} · ` : "";
  const by = move?.source === "agent" ? "reported: " : move?.source === "you" ? "you: " : "";
  return `${answering}${by}${standing.why}`;
}

export function countsLine(snapshot: Snapshot): string {
  const { yours, agents, snoozed: sleeping, waiting } = snapshot.counts;
  return `● ${yours} yours · ◐ ${agents} agents · ◷ ${sleeping} · ⊘ ${waiting}`;
}

export function strandLine(strand: StrandView, now: number): string {
  const indent = " ".repeat(1 + strand.depth * 2);
  const head = `${indent}${strandGlyph(strand, now)}${strand.unseen ? "*" : " "}${strand.depth === 0 ? titled(strand) : strand.name}`;
  const clockText = strand.own.whose === undefined ? "" : age(now - strand.own.since);
  return `${fit(head, 34)} ${fit(holder(strand, now), 24)} ${clockText.padStart(6)}   ${cause(strand)}`;
}

function moveLine(move: MoveView, depth: number): string {
  const until = move.until === undefined ? "     " : clock(move.until);
  const links = move.links.map((link) => `  ${link.adapter === "quoll" ? "📓" : "↗"} ${link.ref}`).join("");
  return `${" ".repeat(3 + depth * 2)}${clock(move.from)}–${until}  ${fit(move.player === "you" ? "you" : move.by.who, 10)} ${move.what}${links}`;
}

export type RowOptions = { expanded?: Set<string>; heardCount?: number };

export function rows(snapshot: Snapshot, width: number, options: RowOptions = {}): Row[] {
  const now = snapshot.now;
  const expanded = options.expanded ?? new Set<string>();
  const heardCount = options.heardCount ?? 8;
  const out: Row[] = [];
  const title = " ◆ ponpoko";
  const counts = countsLine(snapshot);
  out.push({ text: `${title}${" ".repeat(Math.max(2, width - title.length - counts.length - 1))}${counts}`, tone: "heading" });
  out.push({ text: "" });
  if (snapshot.strands.length === 0) out.push({ text: "  Nothing yet. ponpoko fills in as agents take turns and you add strands.", tone: "dim" });
  for (const strand of snapshot.strands) {
    const where = strand.depth === 0 ? strand.spaces.map((space) => space.short).join(", ") : "";
    const line = strandLine(strand, now);
    out.push({ text: where ? `${fit(line, Math.max(20, width - where.length - 2))}  ${where}` : line, strand, tone: strand.depth === 0 ? "heading" : tone(strand, now) });
    if (strand.open.length > 1) for (const move of strand.open) out.push({ text: `${" ".repeat(5 + strand.depth * 2)}↳ ${who(move)} · ${move.what}`, tone: "dim" });
    if (expanded.has(strand.id)) {
      if (strand.recent.length === 0) out.push({ text: `${" ".repeat(3 + strand.depth * 2)}no moves yet`, tone: "dim" });
      for (const move of strand.recent) out.push({ text: moveLine(move, strand.depth), tone: "dim" });
    }
    for (const note of strand.notes.slice(-2)) out.push({ text: `${" ".repeat(5 + strand.depth * 2)}✎ ${note.text}  ${clock(note.at)}`, tone: "dim" });
  }
  if (heardCount > 0 && snapshot.heard.length > 0) {
    out.push({ text: "" });
    snapshot.heard.slice(0, heardCount).forEach((event, index) => {
      out.push({ text: `${index === 0 ? " heard" : "      "}   ${clock(event.at)} ${event.source.padEnd(7)}  ${describe(event, snapshot.labels)}`, tone: "dim" });
    });
  }
  return out;
}

export function describe(event: Recorded, labels: Record<string, string>): string {
  const name = (id: string | undefined) => (id === undefined ? "the top" : (labels[id] ?? id));
  switch (event.type) {
    case "strand.made":
      return `new strand ${name(event.strand)}`;
    case "strand.titled":
      return `${name(event.strand)} is ${event.kind ? `a ${event.kind}: ` : ""}${event.title}`;
    case "strand.parented":
      return `${name(event.strand)} moved under ${name(event.parent)}`;
    case "strand.done":
      return `${name(event.strand)} done: ${event.why}`;
    case "strand.reopened":
      return `${name(event.strand)} reopened`;
    case "strand.forgotten":
      return `${name(event.strand)} forgotten`;
    case "strand.merged":
      return `${name(event.strand)} merged into ${name(event.into)}`;
    case "strand.note":
      return `${name(event.strand)} note added`;
    case "strand.seen":
      return `${name(event.strand)} caught up`;
    case "strand.dismissed":
      return `${name(event.strand)} toast dismissed`;
    case "strand.snoozed":
      return `${name(event.strand)} snoozed till ${clock(event.until)}`;
    case "player.joined":
      return `${event.who} joined`;
    case "player.gone":
      return `${name(event.player)} gone: ${event.why}`;
    case "move.opened":
      return event.player === "you" ? `${name(event.strand)} → you${event.with ? ` (${name(event.with)})` : ""}: ${event.what}` : `${name(event.strand)} → ${name(event.player)}: ${event.what}`;
    case "move.described":
      return `${name(event.move)}: ${event.what}`;
    case "move.closed":
      return `${name(event.move)}, move over`;
    case "link.added":
      return `${name(event.strand ?? event.move)} linked to ${event.adapter} ${event.ref}`;
    case "link.removed":
      return "link removed";
  }
}

export function fit(text: string, width: number): string {
  const chars = [...text];
  if (chars.length > width) return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
  return text + " ".repeat(width - chars.length);
}
