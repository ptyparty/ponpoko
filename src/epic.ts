import { serviceActions, type Actions } from "./actions.ts";
import { state } from "./client.ts";
import type { Ended, Snapshot, StrandView } from "./core.ts";
import { holderOf } from "./map.ts";
import { isWaitingOn, onOwnJob, whyOf } from "./render.ts";
import { cells, keyLine, style, visible, type Key, type Part } from "./screen.ts";
import { isStory, storyNumber } from "./shortcut.ts";

export type StoryState = "done" | "review" | "mine" | "agent" | "ready" | "later";
export type StoryNode = { id: string; name: string; title: string; state: StoryState; strand?: StrandView; ended?: Ended; on: string[]; unblocks: string[] };
export type EpicGraph = { epic: StrandView; nodes: StoryNode[] };

const looks: Record<StoryState, { glyph: string; paint: (text: string) => string; label: string }> = {
  done: { glyph: "✓", paint: style.ok, label: "done" },
  review: { glyph: "⊘", paint: style.wait, label: "in review or waiting on someone" },
  mine: { glyph: "●", paint: style.you, label: "yours" },
  agent: { glyph: "◐", paint: style.agent, label: "an agent's" },
  ready: { glyph: "○", paint: style.accent, label: "ready to start" },
  later: { glyph: "·", paint: style.faint, label: "not started" },
};
const order: StoryState[] = ["done", "review", "mine", "agent", "ready", "later"];

export function findEpic(snapshot: Snapshot, wanted: string): StrandView | undefined {
  const text = wanted.trim().toLowerCase();
  const name = /^\d+$/.test(text) ? `sc-${text}` : text;
  const matches = snapshot.strands.filter((strand) => strand.id === wanted || strand.name.toLowerCase() === name);
  return matches.find((strand) => strand.kind === "epic") ?? matches[0];
}

function shortName(name: string): string {
  const number = storyNumber(name);
  return number === undefined ? name : String(number);
}

export function epicGraph(snapshot: Snapshot, epic: StrandView): EpicGraph {
  const live = snapshot.strands.filter((strand) => strand.parent === epic.id && isStory(strand));
  const ended = (snapshot.ended ?? []).filter((strand) => strand.parent === epic.id && isStory(strand));
  const ids = new Set([...live.map((strand) => strand.id), ...ended.map((strand) => strand.id)]);
  const finished = new Set(ended.map((strand) => strand.id));
  const stateOf = (strand: StrandView): StoryState => {
    const blocked = Object.keys(strand.blockedOn).some((on) => ids.has(on) && !finished.has(on)) || isWaitingOn(strand, strand.own.waitsOn) || strand.heldBy !== undefined;
    if (strand.planned) return blocked ? "later" : "ready";
    if (blocked && strand.rolled.whose === undefined) return "later";
    if (onOwnJob(holderOf(snapshot.strands, strand))) return "agent";
    switch (strand.rolled.whose) {
      case "you":
        return "mine";
      case "agent":
        return "agent";
      case "person":
      case "machine":
        return "review";
      default:
        return blocked ? "later" : "ready";
    }
  };
  const nodes: StoryNode[] = [
    ...live.map((strand) => ({ id: strand.id, name: strand.name, title: strand.title ?? strand.name, state: stateOf(strand), strand, on: [] as string[], unblocks: [] as string[] })),
    ...ended.map((strand) => ({ id: strand.id, name: strand.name, title: strand.title ?? strand.name, state: "done" as const, ended: strand, on: [] as string[], unblocks: [] as string[] })),
  ].sort((a, b) => (storyNumber(a.name) ?? Number.MAX_SAFE_INTEGER) - (storyNumber(b.name) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const blockedOn = node.strand?.blockedOn ?? node.ended?.blockedOn ?? {};
    for (const on of Object.keys(blockedOn)) {
      const blocker = byId.get(on);
      if (!blocker) continue;
      node.on.push(on);
      blocker.unblocks.push(node.id);
    }
  }
  return { epic, nodes };
}

export type Placed = { node: StoryNode; col: number; row: number };
export type Layout = { placed: Placed[]; linkedRows: number; columns: number; loose: StoryNode[] };

export function layoutGraph(graph: EpicGraph, sweeps = 0): Layout {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const linked = graph.nodes.filter((node) => node.on.length > 0 || node.unblocks.length > 0);
  const depth = new Map<string, number>();
  const depthOf = (node: StoryNode, seen = new Set<string>()): number => {
    const known = depth.get(node.id);
    if (known !== undefined) return known;
    if (seen.has(node.id)) return 0;
    seen.add(node.id);
    const value = node.on.length === 0 ? 0 : Math.max(...node.on.map((on) => depthOf(byId.get(on)!, seen) + 1));
    depth.set(node.id, value);
    return value;
  };
  for (const node of linked) depthOf(node);
  for (const node of linked) {
    if (node.on.length > 0 || node.unblocks.length === 0) continue;
    depth.set(node.id, Math.max(0, Math.min(...node.unblocks.map((id) => depth.get(id)!)) - 1));
  }
  const nextFree = new Map<number, number>();
  const rowOf = new Map<string, number>();
  const component = new Map<string, number>();
  let used = -1;
  const place = (node: StoryNode, least: number, group: number) => {
    if (rowOf.has(node.id)) return;
    const col = depth.get(node.id)!;
    const row = Math.max(least, nextFree.get(col) ?? 0);
    rowOf.set(node.id, row);
    component.set(node.id, group);
    nextFree.set(col, row + 1);
    used = Math.max(used, row);
    for (const id of node.unblocks) place(byId.get(id)!, row, group);
  };
  const groupOf = (node: StoryNode): number | undefined => {
    const seen = new Set<string>();
    const queue = [node];
    while (queue.length > 0) {
      const at = queue.shift()!;
      if (seen.has(at.id)) continue;
      seen.add(at.id);
      if (component.has(at.id)) return component.get(at.id);
      for (const id of [...at.on, ...at.unblocks]) queue.push(byId.get(id)!);
    }
    return undefined;
  };
  let groups = 0;
  const tops = new Map<number, number>();
  for (const source of linked.filter((node) => node.on.length === 0)) {
    const group = groupOf(source);
    if (group === undefined) {
      const fresh = groups++;
      tops.set(fresh, used + 1);
      place(source, used + 1, fresh);
    } else place(source, tops.get(group)!, group);
  }
  for (const node of linked) if (!rowOf.has(node.id)) place(node, used + 1, groups++);
  const columns = Math.max(0, ...linked.map((node) => depth.get(node.id)!));
  const centre = (ids: string[]) => (ids.length === 0 ? undefined : ids.reduce((total, id) => total + rowOf.get(id)!, 0) / ids.length);
  const sweep = (col: number, neighbours: (node: StoryNode) => string[]) => {
    const inColumn = linked.filter((node) => depth.get(node.id) === col);
    for (const group of new Set(inColumn.map((node) => component.get(node.id)))) {
      const members = inColumn.filter((node) => component.get(node.id) === group);
      const slots = members.map((node) => rowOf.get(node.id)!).sort((a, b) => a - b);
      const sorted = [...members].sort((a, b) => (centre(neighbours(a)) ?? rowOf.get(a.id)!) - (centre(neighbours(b)) ?? rowOf.get(b.id)!) || rowOf.get(a.id)! - rowOf.get(b.id)!);
      sorted.forEach((node, at) => rowOf.set(node.id, slots[at]!));
    }
  };
  for (let pass = 0; pass < sweeps; pass++) {
    for (let col = 1; col <= columns; col++) sweep(col, (node) => node.on);
    for (let col = columns - 1; col >= 0; col--) sweep(col, (node) => node.unblocks);
  }
  const placed = linked.map((node) => ({ node, col: depth.get(node.id)!, row: rowOf.get(node.id)! }));
  return { placed, linkedRows: used + 1, columns: Math.max(1, ...placed.map((at) => at.col + 1)), loose: graph.nodes.filter((node) => !linked.includes(node)) };
}

type Cell = { ch: string; paint?: (text: string) => string };
type Box = { node: StoryNode; x: number; y: number };
const gap = 6;
const boxHeight = 4;
const rowPitch = 5;

export type Drawing = { lines: Cell[][]; boxes: Box[]; width: number; boxWidth: number; crossings: number };

export function bestLayout(graph: EpicGraph, width: number): Layout {
  const tried = [0, 1, 2, 4, 8].map((sweeps) => {
    const layout = layoutGraph(graph, sweeps);
    return { layout, crossings: drawGraph(layout, width, undefined).crossings };
  });
  return tried.reduce((best, next) => (next.crossings < best.crossings ? next : best)).layout;
}

export function drawGraph(layout: Layout, width: number, selected: string | undefined): Drawing {
  const columns = Math.max(layout.columns, 1);
  const boxWidth = Math.max(width >= 120 ? 22 : 18, Math.min(30, Math.floor((width - 2 - gap * (columns - 1)) / columns)));
  const pitch = boxWidth + gap;
  const perRow = Math.max(columns, Math.max(1, Math.floor((width - 2 + gap) / pitch)));
  const looseRows = Math.ceil(layout.loose.length / perRow);
  const at = new Map(layout.placed.map((placed) => [placed.node.id, placed]));
  const reach = (from: string, skip: string): boolean => {
    const seen = new Set<string>();
    const queue = (at.get(from)?.node.unblocks ?? []).filter((id) => id !== skip);
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (next === skip) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(at.get(next)?.node.unblocks ?? []));
    }
    return false;
  };
  const direct = new Map(layout.placed.map((placed) => [placed.node.id, placed.node.unblocks.filter((id) => at.has(id) && !reach(placed.node.id, id))]));
  const isLong = (from: Placed, to: Placed) => to.col - from.col > 1 && (to.row !== from.row || layout.placed.some((other) => other.row === from.row && other.col > from.col && other.col < to.col));
  const gutterSources = new Map<number, string[]>();
  for (const placed of layout.placed) {
    if (!direct.get(placed.node.id)!.some((id) => isLong(placed, at.get(id)!))) continue;
    gutterSources.set(placed.row, [...(gutterSources.get(placed.row) ?? []), placed.node.id]);
  }
  const rowY: number[] = [0];
  for (let row = 0; row < layout.linkedRows; row++) rowY.push(rowY[row]! + boxHeight + Math.max(1, gutterSources.get(row)?.length ?? 0));
  const looseTop = rowY[layout.linkedRows]! + (layout.linkedRows > 0 && layout.loose.length > 0 ? 1 : 0);
  const height = looseTop + looseRows * rowPitch;
  const gridWidth = Math.max(width, 2 + Math.max(columns, Math.min(perRow, layout.loose.length)) * pitch);
  const lines: Cell[][] = Array.from({ length: height }, () => Array.from({ length: gridWidth }, () => ({ ch: " " })));
  const boxes: Box[] = [
    ...layout.placed.map((placed) => ({ node: placed.node, x: 2 + placed.col * pitch, y: rowY[placed.row]! })),
    ...layout.loose.map((node, at) => ({ node, x: 2 + (at % perRow) * pitch, y: looseTop + Math.floor(at / perRow) * rowPitch })),
  ];
  const where = new Map(boxes.map((box) => [box.node.id, box]));
  const bits = new Map<string, Map<number, number>>();
  let edge = 0;
  const mark = (x: number, y: number, bit: number) => {
    const cell = bits.get(`${x},${y}`) ?? new Map<number, number>();
    cell.set(edge, (cell.get(edge) ?? 0) | bit);
    bits.set(`${x},${y}`, cell);
  };
  const [up, down, left, right] = [1, 2, 4, 8];
  const across = (from: number, to: number, y: number) => {
    for (let x = from; x <= to; x++) {
      if (x > from) mark(x, y, left);
      if (x < to) mark(x, y, right);
    }
  };
  const along = (from: number, to: number, x: number) => {
    const [top, bottom] = from < to ? [from, to] : [to, from];
    for (let y = top; y <= bottom; y++) {
      if (y > top) mark(x, y, up);
      if (y < bottom) mark(x, y, down);
    }
  };
  const arrows: [number, number][] = [];
  type Leg = { gap: number; source: Box; end: number };
  const routes = boxes.flatMap((box) =>
    (direct.get(box.node.id) ?? []).flatMap((id) => {
      const target = where.get(id);
      const from = at.get(box.node.id);
      if (!target || !from) return [];
      const long = isLong(from, at.get(id)!);
      const gutter = box.y + boxHeight + Math.max(0, gutterSources.get(from.row)?.indexOf(box.node.id) ?? 0);
      const legs: Leg[] = long ? [{ gap: box.x + pitch, source: box, end: gutter }, { gap: target.x, source: box, end: target.y + 1 }] : target.y === box.y ? [] : [{ gap: target.x, source: box, end: target.y + 1 }];
      return [{ box, target, long, gutter, legs }];
    }),
  );
  const laneOf = new Map<string, number>();
  const byGap = new Map<number, Leg[]>();
  for (const leg of routes.flatMap((route) => route.legs)) byGap.set(leg.gap, [...(byGap.get(leg.gap) ?? []), leg]);
  for (const [x, legs] of byGap) {
    const sources = [...new Set(legs.map((leg) => leg.source))].sort((a, b) => a.y - b.y || a.x - b.x);
    const before = new Map(sources.map((source) => [source, new Set<Box>()]));
    for (const leg of legs) for (const other of sources) if (other !== leg.source && other.y + 1 === leg.end && other.x + pitch === x) before.get(leg.source)!.add(other);
    const ordered: Box[] = [];
    const left = [...sources];
    while (left.length > 0) {
      const next = left.find((source) => [...before.get(source)!].every((other) => ordered.includes(other))) ?? left[0]!;
      ordered.push(next);
      left.splice(left.indexOf(next), 1);
    }
    const positions = ordered.length === 1 ? [4] : ordered.length === 2 ? [4, 3] : ordered.length === 3 ? [5, 4, 3] : [5, 4, 3, 2];
    ordered.forEach((source, at) => laneOf.set(`${x},${source.node.id}`, x - positions[at % positions.length]!));
  }
  for (const { box, target, long, gutter } of routes) {
    edge++;
    const x0 = box.x + boxWidth;
    const y0 = box.y + 1;
    const xt = target.x - 1;
    const yt = target.y + 1;
    const xm = Math.max(x0, laneOf.get(`${target.x},${box.node.id}`) ?? target.x - 4);
    mark(x0, y0, left);
    if (long) {
      const xa = laneOf.get(`${box.x + pitch},${box.node.id}`) ?? x0 + 2;
      across(x0, xa, y0);
      along(y0, gutter, xa);
      across(xa, xm, gutter);
      along(gutter, yt, xm);
    } else {
      across(x0, xm, y0);
      along(y0, yt, xm);
    }
    across(xm, xt, yt);
    arrows.push([xt, yt]);
  }
  const joins: Record<number, string> = { [left | right]: "─", [left]: "─", [right]: "─", [up | down]: "│", [up]: "│", [down]: "│", [down | right]: "┌", [down | left]: "┐", [up | right]: "└", [up | left]: "┘", [left | right | down]: "┬", [left | right | up]: "┴", [up | down | right]: "├", [up | down | left]: "┤", [up | down | left | right]: "┼" };
  let crossings = 0;
  const sideways = left | right;
  const upright = up | down;
  for (const [key, edges] of bits) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    const parts = [...edges.values()];
    const value = parts.reduce((all, part) => all | part, 0);
    const turns = parts.some((part) => (part & sideways) !== 0 && (part & upright) !== 0);
    const crossing = !turns && parts.some((part) => (part & upright) === 0) && parts.some((part) => (part & sideways) === 0);
    if (crossing) crossings++;
    if (lines[y]?.[x]) lines[y]![x] = { ch: crossing ? "─" : (joins[value] ?? "┼"), paint: style.faint };
  }
  for (const [x, y] of arrows) if (lines[y]?.[x]) lines[y]![x] = { ch: "▶", paint: style.faint };
  for (const box of boxes) {
    const look = looks[box.node.state];
    const picked = box.node.id === selected;
    const border = picked ? (text: string) => style.accent(style.bold(text)) : look.paint;
    const inner = boxWidth - 4;
    const id = shortName(box.node.name);
    const titlePaint = box.node.state === "done" || box.node.state === "later" ? style.muted : picked ? (text: string) => style.text(style.bold(text)) : style.text;
    const rows: Cell[][] = [
      [{ ch: `╭${"─".repeat(boxWidth - 2)}╮`, paint: border }],
      [{ ch: "│ ", paint: border }, { ch: `${look.glyph} `, paint: look.paint }, { ch: clip(id, inner - 2), paint: style.faint }, { ch: " │", paint: border }],
      [{ ch: "│ ", paint: border }, { ch: clip(box.node.title, inner), paint: titlePaint }, { ch: " │", paint: border }],
      [{ ch: `╰${"─".repeat(boxWidth - 2)}╯`, paint: border }],
    ];
    rows.forEach((parts, dy) => {
      let x = box.x;
      for (const part of parts) {
        for (const ch of [...part.ch]) {
          const line = lines[box.y + dy];
          if (line && x < line.length) line[x] = { ch, paint: part.paint };
          x++;
        }
      }
    });
  }
  return { lines, boxes, width: gridWidth, boxWidth, crossings };
}

function clip(text: string, width: number): string {
  const chars = [...text];
  return chars.length > width ? `${chars.slice(0, width - 1).join("")}…` : text + " ".repeat(width - chars.length);
}

function paintLine(cellsOf: Cell[], from: number, width: number): string {
  let out = "";
  let run = "";
  let paint: ((text: string) => string) | undefined;
  const flush = () => {
    if (run) out += paint ? paint(run) : run;
    run = "";
  };
  for (const cell of cellsOf.slice(from, from + width)) {
    if (cell.paint !== paint) {
      flush();
      paint = cell.paint;
    }
    run += cell.ch;
  }
  flush();
  return out;
}

const mermaidStyles: Record<StoryState, string> = {
  done: "fill:#1d2b1a,stroke:#a2e27a,color:#e8ebf2",
  review: "fill:#2a2238,stroke:#c89dff,color:#e8ebf2",
  mine: "fill:#33291a,stroke:#ffc45e,color:#e8ebf2",
  agent: "fill:#1c2438,stroke:#8fb0ff,color:#e8ebf2",
  ready: "fill:#181b24,stroke:#8fb0ff,color:#e8ebf2",
  later: "fill:#181b24,stroke:#565e72,color:#9298ab,stroke-dasharray:4 3",
};

export function mermaid(graph: EpicGraph): string {
  const key = (node: StoryNode) => `s${node.name.replace(/[^A-Za-z0-9]+/g, "_")}`;
  const label = (node: StoryNode) => `${shortName(node.name)} ${node.title}`.replace(/"/g, "#quot;");
  const used = new Set(graph.nodes.map((node) => node.state));
  return [
    "flowchart LR",
    ...graph.nodes.map((node) => `  ${key(node)}["${label(node)}"]:::${node.state}`),
    ...graph.nodes.flatMap((node) => node.unblocks.map((id) => `  ${key(node)} --> ${key(graph.nodes.find((other) => other.id === id)!)}`)),
    ...order.filter((state) => used.has(state)).map((state) => `  classDef ${state} ${mermaidStyles[state]}`),
  ].join("\n");
}

export function summary(graph: EpicGraph): string {
  const count = (state: StoryState) => graph.nodes.filter((node) => node.state === state).length;
  const parts = [`${graph.nodes.length} ${graph.nodes.length === 1 ? "story" : "stories"}`, ...(count("done") ? [`${count("done")} done`] : []), ...(count("review") ? [`${count("review")} in review`] : []), ...(count("mine") + count("agent") ? [`${count("mine") + count("agent")} in progress`] : []), ...(count("ready") ? [`${count("ready")} ready`] : [])];
  return parts.join(" · ");
}

function keyRows(width: number): string[] {
  const parts: Part[][] = [...order.map((state): Part[] => [[looks[state].glyph, looks[state].paint], [` ${looks[state].label}`, style.muted]]), [["─▶", style.faint], [" unblocks", style.muted]]];
  const length = (group: Part[]) => group.reduce((total, part) => total + [...(typeof part === "string" ? part : part[0])].length, 0) + 3;
  const rows: Part[][] = [[" "]];
  let used = 1;
  for (const group of parts) {
    if (used + length(group) > width && used > 1) {
      rows.push([" "]);
      used = 1;
    }
    rows.at(-1)!.push(...group, "   ");
    used += length(group);
  }
  return rows.map((row) => cells(row, width));
}

export type Copy = (text: string) => Promise<void>;

export async function copyText(text: string): Promise<void> {
  for (const command of [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]) {
    if (!Bun.which(command[0]!)) continue;
    const child = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    child.stdin.write(text);
    await child.stdin.end();
    if ((await child.exited) === 0) return;
  }
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
}

export class EpicController {
  snapshot: Snapshot | undefined;
  message: string | undefined;
  private selected: string | undefined;
  private typing: string | undefined;
  private top = 0;
  private left = 0;
  private width = 120;

  constructor(
    private readonly actions: Actions,
    readonly epicId: string,
    private readonly copy: Copy = copyText,
  ) {}

  setSnapshot(snapshot: Snapshot | undefined): void {
    this.snapshot = snapshot;
  }

  graph(): EpicGraph | undefined {
    return this.drawn()?.graph;
  }

  private cache: { snapshot: Snapshot; width: number; selected: string | undefined; graph: EpicGraph; layout: Layout; drawing: Drawing } | undefined;

  private drawn(selected: string | undefined = this.selected): { graph: EpicGraph; drawing: Drawing } | undefined {
    const snapshot = this.snapshot;
    if (!snapshot) return undefined;
    const cached = this.cache;
    if (cached?.snapshot === snapshot && cached.width === this.width) {
      if (cached.selected !== selected) Object.assign(cached, { selected, drawing: drawGraph(cached.layout, this.width, selected) });
      return cached;
    }
    const epic = findEpic(snapshot, this.epicId);
    if (!epic) return undefined;
    const graph = epicGraph(snapshot, epic);
    const layout = bestLayout(graph, this.width);
    this.cache = { snapshot, width: this.width, selected, graph, layout, drawing: drawGraph(layout, this.width, selected) };
    return this.cache;
  }

  private boxes(): Box[] {
    return this.drawn()?.drawing.boxes ?? [];
  }

  picked(): StoryNode | undefined {
    const boxes = this.boxes();
    return (boxes.find((box) => box.node.id === this.selected) ?? boxes[0])?.node;
  }

  private step(dx: number, dy: number): void {
    const boxes = this.boxes();
    const at = boxes.find((box) => box.node.id === this.picked()?.id);
    if (!at) return;
    const candidates = boxes.filter((box) => box !== at && (dx > 0 ? box.x > at.x : dx < 0 ? box.x < at.x : dy > 0 ? box.y > at.y : box.y < at.y));
    const sameLine = candidates.filter((box) => (dx !== 0 ? box.y === at.y : box.x === at.x));
    const pool = sameLine.length > 0 ? sameLine : candidates;
    const distance = (box: Box) => (dx !== 0 ? Math.abs(box.x - at.x) * 4 + Math.abs(box.y - at.y) * 6 : Math.abs(box.y - at.y) * 6 + Math.abs(box.x - at.x));
    const next = [...pool].sort((a, b) => distance(a) - distance(b))[0];
    if (next) this.selected = next.node.id;
  }

  async key(key: Key): Promise<"close" | undefined> {
    this.message = undefined;
    const node = this.picked();
    if (this.typing !== undefined) {
      if (key.name === "escape" || key.name === "ctrl+c") this.typing = undefined;
      else if (key.name === "backspace") this.typing = this.typing.slice(0, -1);
      else if (key.name === "return") {
        const text = this.typing.trim();
        this.typing = undefined;
        if (node?.strand) await this.run(() => (text === "" ? this.actions.unblock(node.strand!.id) : this.actions.block(node.strand!.id, text)), text === "" ? `${node.name} no longer waits on other strands` : `${node.name} waits on ${text}`);
      } else if (key.text) this.typing += key.text;
      return undefined;
    }
    switch (key.name) {
      case "escape":
      case "q":
      case "ctrl+c":
        return "close";
      case "left":
      case "h":
        this.step(-1, 0);
        return undefined;
      case "right":
      case "l":
        this.step(1, 0);
        return undefined;
      case "up":
      case "k":
        this.step(0, -1);
        return undefined;
      case "down":
      case "j":
        this.step(0, 1);
        return undefined;
      case "return":
        if (!node?.strand) this.message = node ? `${node.name} is done` : "No story here";
        else await this.run(() => this.actions.go(node.strand!, this.snapshot?.strands ?? []));
        return undefined;
      case "w":
        if (node?.strand) this.typing = "";
        else this.message = "Only a story that isn't done can wait";
        return undefined;
      case "s":
        if (node?.strand?.planned) await this.run(() => this.actions.start(node.strand!.id), `${node.name} is started`);
        else this.message = "Only a planned story can be started";
        return undefined;
      case "o": {
        const link = node?.strand?.links.find((candidate) => candidate.adapter === "shortcut");
        if (!link) this.message = "ponpoko has no Shortcut link for this story";
        else await this.run(() => this.actions.open(link), `Opened ${link.ref}`);
        return undefined;
      }
      case "r": {
        const graph = this.graph();
        const number = graph ? storyNumber(graph.epic.name) : undefined;
        if (!graph || number === undefined) this.message = "Only an epic named like sc-1234 comes from Shortcut";
        else await this.run(() => this.actions.refreshEpic(graph.epic.id, number), (said) => String(said));
        return undefined;
      }
      case "m": {
        const graph = this.graph();
        if (graph) await this.run(() => this.copy(mermaid(graph)), "Copied the graph as mermaid");
        return undefined;
      }
    }
    return undefined;
  }

  view(width: number, height: number): string[] {
    this.width = width;
    if (!this.snapshot) return ["", style.red(" ponpoko ✗  the service isn't running"), "", keyLine([["esc", "back"]])];
    const graph = this.graph();
    if (!graph) return ["", style.muted(` ponpoko knows of no epic ${this.epicId}`), "", keyLine([["esc", "back"]])];
    const node = this.picked();
    if (node) this.selected = node.id;
    const drawing = this.drawn(node?.id)!.drawing;
    const head = [
      cells([[` ${graph.epic.title ?? graph.epic.name}`, (text) => style.text(style.bold(text))], [`  ${graph.epic.title ? `${graph.epic.name} · ` : ""}${summary(graph)}`, style.faint], [drawing.width > width ? `   ${this.left > 0 ? "◂" : " "} scrolls ${this.left + width < drawing.width ? "▸" : " "}` : "", style.muted]], width),
      "",
      ...keyRows(width),
      "",
    ];
    const detail = node ? this.detail(node, graph, width) : [];
    const footer = this.footer(node, width);
    const room = Math.max(boxHeight, height - head.length - detail.length - footer.length - 2);
    const box = drawing.boxes.find((candidate) => candidate.node.id === node?.id);
    if (box) {
      if (box.y < this.top) this.top = box.y;
      if (box.y + boxHeight > this.top + room) this.top = box.y + boxHeight - room;
      if (box.x < this.left + 2) this.left = Math.max(0, box.x - 2);
      if (box.x + drawing.boxWidth > this.left + width) this.left = box.x + drawing.boxWidth - width + 2;
    }
    this.top = Math.max(0, Math.min(this.top, Math.max(0, drawing.lines.length - room)));
    const body = drawing.lines.slice(this.top, this.top + room).map((line) => paintLine(line, this.left, width));
    if (graph.nodes.length === 0) body.push(style.muted("  No stories under this epic yet."));
    while (body.length < room) body.push("");
    return [...head, ...body, "", ...detail, "", ...footer];
  }

  private detail(node: StoryNode, graph: EpicGraph, width: number): string[] {
    const look = looks[node.state];
    const names = (ids: string[]) => ids.map((id) => shortName(graph.nodes.find((other) => other.id === id)?.name ?? id)).join(", ");
    const strand = node.strand;
    const why = strand ? whyOf(holderOf(this.snapshot?.strands ?? [], strand), this.snapshot!.now).text : "done";
    const outside = Object.keys(strand?.heldBy ?? {});
    const facts = [...(strand?.planned ? ["planned"] : []), why, ...(outside.length > 0 && !why.includes("not ready yet") ? [`waits on ${outside.join(", ")} (not ready yet)`] : []), ...(strand?.spaces[0] ? [strand.spaces[0].short] : []), ...(node.on.length > 0 ? [`waits on ${names(node.on)}`] : []), ...(node.unblocks.length > 0 ? [`unblocks ${names(node.unblocks)}`] : [])];
    return [cells([[" ▎ ", look.paint], [node.name, (text) => style.text(style.bold(text))], [`  ${node.title}`, style.text]], width), cells([[" ▎ ", look.paint], [facts.join(" · "), style.muted]], width)];
  }

  private footer(node: StoryNode | undefined, width: number): string[] {
    if (this.typing !== undefined) return [style.you(` waits on (empty to stop waiting): ${this.typing}▏   ⏎ save   esc cancel`)];
    if (this.message) return [style.warn(` ${this.message}`)];
    const lead = node ? ` ${style.enter("⏎")} ${style.text(style.bold(node.strand ? `go to ${node.name}` : `${node.name} is done`))}  ` : " ";
    return [lead + keyLine([["← → ↑ ↓", "move between boxes"], ...(node?.strand ? [["w", "wait on"] as [string, string]] : []), ...(node?.strand?.planned ? [["s", "start"] as [string, string]] : []), ["o", "open in Shortcut"], ["r", "refresh from Shortcut"], ["m", "copy as mermaid"], ["esc", "back"]], Math.max(10, width - visible(lead)))];
  }

  private async run(action: () => Promise<unknown>, done?: string | ((result: unknown) => string)): Promise<boolean> {
    try {
      const result = await action();
      this.message = typeof done === "function" ? done(result) : done;
      return true;
    } catch (error) {
      this.message = (error as Error).message;
      return false;
    }
  }
}

export async function runEpic(args: string[]): Promise<number> {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    console.error("Usage: ponpoko epic ID [--refresh] [--mermaid]");
    return 2;
  }
  if (args.includes("--refresh")) {
    const snapshot = await state();
    const epic = findEpic(snapshot, id);
    const number = epic ? storyNumber(epic.name) : undefined;
    if (!epic || number === undefined) {
      console.error(`ponpoko knows of no epic ${id} from Shortcut`);
      return 1;
    }
    console.log(await serviceActions.refreshEpic(epic.id, number));
    if (!args.includes("--mermaid")) return 0;
  }
  if (args.includes("--mermaid")) {
    const snapshot = await state();
    const epic = findEpic(snapshot, id);
    if (!epic) {
      console.error(`ponpoko knows of no epic ${id}`);
      return 1;
    }
    console.log(mermaid(epicGraph(snapshot, epic)));
    return 0;
  }
  const { runLive } = await import("./tab.ts");
  return runLive(new EpicController(serviceActions, id));
}
