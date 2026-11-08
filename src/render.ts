import type { MoveView, Snapshot, StrandView } from "./core.ts";
import type { Recorded } from "./events.ts";
import { cells, style, type Part } from "./screen.ts";
import { dormant } from "./model.ts";
import { whenLabel } from "./when.ts";

export type Row = { text: string; strand?: StrandView };

export function snoozedLabel(strand: { snoozedUntil?: number }, now: number): string {
  return strand.snoozedUntil === dormant ? "till woken" : `till ${whenLabel(strand.snoozedUntil ?? now, now)}`;
}

export function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

export function shortAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function snoozed(strand: StrandView, now: number): boolean {
  return (strand.snoozedUntil ?? 0) > now;
}

export type Standing = { glyph: string; paint: (text: string) => string; text: string; age: string };

export function standingOf(strand: StrandView, now: number): Standing {
  const own = strand.own;
  const since = shortAge(now - own.since);
  if (snoozed(strand, now)) return { glyph: "◷", paint: style.faint, text: `snoozed ${snoozedLabel(strand, now)}`, age: "" };
  switch (own.whose) {
    case "you": {
      const said = cause(strand);
      return { glyph: "●", paint: style.you, text: strand.open.some((move) => move.player === "you" && move.answers) ? said : `yours · ${said}`, age: since };
    }
    case "agent":
      return { glyph: "◐", paint: style.agent, text: othersCause(strand), age: since };
    case "person":
    case "machine":
      return { glyph: "⊘", paint: style.wait, text: othersCause(strand), age: since };
    default:
      if (isWaitingOn(strand, own.waitsOn)) return { glyph: "⊘", paint: style.wait, text: own.why, age: since };
      return { glyph: "○", paint: style.muted, text: own.why, age: "" };
  }
}

export function isWaitingOn(strand: StrandView, id: string | undefined): boolean {
  return id !== undefined && strand.blockedOn?.[id] !== undefined;
}

export function blockersOf(strand: StrandView, strands: StrandView[]): StrandView[] {
  return strands.filter((other) => isWaitingOn(strand, other.id));
}

export function othersCause(strand: StrandView): string {
  const move = strand.open.find((candidate) => candidate.from === strand.own.since) ?? strand.open[0];
  return move && move.player !== "you" ? `${move.by.who} · ${strand.own.why}` : cause(strand);
}

export function pathText(strand: StrandView): string {
  return strand.path.join(" › ");
}

function who(move: MoveView): string {
  return move.player === "you" ? (move.answers?.who ?? "you") : move.by.who;
}

export function holder(strand: StrandView, now: number): string {
  const standing = strand.own;
  const moves = strand.open.filter((move) => (move.player === "you" ? "you" : move.by.kind === "job" ? "machine" : move.by.kind) === standing.whose);
  switch (standing.whose) {
    case "you":
      if (snoozed(strand, now)) return `snoozed ${snoozedLabel(strand, now)}`;
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
  if (standing.whose === undefined) return standing.why;
  const move = strand.open.find((candidate) => candidate.from === standing.since) ?? strand.open[0];
  const answering = move?.player === "you" && move.answers ? `${move.answers.who} · ` : "";
  const by = move?.source === "agent" ? "reported: " : move?.source === "you" ? "you: " : "";
  return `${answering}${by}${standing.why}`;
}

export function header(snapshot: Snapshot, width: number): string {
  const { yours, agents, snoozed: sleeping, waiting } = snapshot.counts;
  const counts: Part[] = [["● ", style.you], [`${yours} yours`, style.muted], ["   ◐ ", style.agent], [`${agents} agent${agents === 1 ? "" : "s"}`, style.muted], ["   ⊘ ", style.wait], [`${waiting} waiting`, style.muted], ["   ◷ ", style.faint], [`${sleeping} snoozed`, style.muted], " "];
  const right = counts.reduce<number>((total, part) => total + [...(typeof part === "string" ? part : part[0])].length, 0);
  return style.surface(cells([[" ◆ ", (text) => style.accent(style.bold(text))], ["ponpoko", (text) => style.text(style.bold(text))]], Math.max(12, width - right)) + cells(counts, right));
}

export function strandLine(strand: StrandView, now: number, width: number, selected = false): string {
  const standing = standingOf(strand, now);
  const asleep = snoozed(strand, now);
  const tabW = 8;
  const ageW = 5;
  const statusW = Math.max(20, Math.min(48, Math.floor(width * 0.34)));
  const nameW = Math.max(24, width - 2 - statusW - 2 - ageW - 3 - tabW);
  const name: Part[] = ["  ".repeat(strand.depth), [standing.glyph, standing.paint], " ", [strand.name, (text) => (asleep ? style.faint(text) : style.text(selected ? style.bold(text) : text))]];
  if (strand.title) name.push("  ", [strand.title, asleep ? style.faint : style.muted]);
  const where = strand.spaces.map((space) => space.short).join(", ");
  return cells(
    [
      [selected ? "▎" : " ", style.accent],
      [strand.unseen && !asleep ? "•" : " ", (text) => style.you(style.bold(text))],
      [cells(name, nameW)],
      "  ",
      [cells([[standing.text, standing.paint]], statusW - 1)],
      [standing.age.padStart(ageW + 1), style.faint],
      "   ",
      [where, style.faint],
    ],
    width,
  );
}

function moveLine(move: MoveView, depth: number): string {
  const until = move.until === undefined ? "     " : clock(move.until);
  const links = move.links.map((link) => `  ${link.adapter === "quoll" ? "📓" : "↗"} ${link.ref}`).join("");
  return `${" ".repeat(4 + depth * 2)}${clock(move.from)}–${until}  ${fit(move.player === "you" ? "you" : move.by.who, 10)} ${move.what}${links}`;
}

export type RowOptions = { expanded?: Set<string>; logCount?: number; header?: boolean; selected?: string };

export function rows(snapshot: Snapshot, width: number, options: RowOptions = {}): Row[] {
  const now = snapshot.now;
  const expanded = options.expanded ?? new Set<string>();
  const logCount = options.logCount ?? 8;
  const out: Row[] = [];
  if (options.header ?? true) out.push({ text: header(snapshot, width) }, { text: "" });
  if (snapshot.strands.length === 0) out.push({ text: style.muted("  Nothing yet. ponpoko fills in as agents take turns and you add strands.") });
  snapshot.strands.forEach((strand, index) => {
    if (strand.depth === 0 && index > 0) out.push({ text: "" });
    out.push({ text: strandLine(strand, now, width, strand.id === options.selected), strand });
    if (strand.open.length > 1) for (const move of strand.open) out.push({ text: style.faint(`${" ".repeat(6 + strand.depth * 2)}↳ ${who(move)} · ${move.what}`) });
    if (expanded.has(strand.id)) {
      if (strand.recent.length === 0) out.push({ text: style.faint(`${" ".repeat(4 + strand.depth * 2)}no moves yet`) });
      for (const move of strand.recent) out.push({ text: style.faint(moveLine(move, strand.depth)) });
    }
  });
  if (logCount > 0 && snapshot.heard.length > 0) {
    out.push({ text: "" });
    snapshot.heard.slice(0, logCount).forEach((event, index) => {
      out.push({ text: style.faint(`${index === 0 ? " log  " : "      "}  ${clock(event.at)}  ${event.source.padEnd(6)} ${describe(event, snapshot.labels)}`) });
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
    case "strand.renamed":
      return `${name(event.strand)} renamed`;
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
    case "strand.blocked":
      return `${name(event.strand)} waits on ${name(event.on)}`;
    case "strand.unblocked":
      return `${name(event.strand)} no longer waits on ${name(event.on)}`;
    case "strand.seen":
      return `${name(event.strand)} caught up`;
    case "strand.dismissed":
      return `${name(event.strand)} toast dismissed`;
    case "strand.snoozed":
      return `${name(event.strand)} ${event.untilNeeded ? "snoozed till needed" : event.until === dormant ? "snoozed till woken" : `snoozed till ${clock(event.until)}`}`;
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
