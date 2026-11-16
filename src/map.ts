import { underOf, type Snapshot, type StrandView } from "./core.ts";
import { prName } from "./github.ts";
import { isPooled, mentionsId, ownPrs, repoAdapter, reviewsId, stateAdapter, type OwnPrView } from "./inbox.ts";
import { headline, isWaitingOn, snoozedLabel, standingOf, whyOf, type Why } from "./render.ts";
import { cells, style, type Part } from "./screen.ts";
import { isStory } from "./shortcut.ts";

export type Area = "work" | "reviews" | "mentions";
export const areas: Area[] = ["work", "reviews", "mentions"];
export const areaNames: Record<Area, string> = { work: "Work", reviews: "Reviews", mentions: "Mentions" };

export type MapRow = { text: string; picked?: string; key?: string; strand?: StrandView; fold?: boolean; pr?: OwnPrView };

type Ctx = { snapshot: Snapshot; width: number; opened: Set<string>; selected?: string; kids: Map<string | undefined, StrandView[]> };

type Line = { key: string; strand?: StrandView; indent: number; glyph: string; paint: (text: string) => string; title: string; id: string; why: Why; age: string; where?: string; tail?: string; pr?: OwnPrView; bold?: boolean };

function context(snapshot: Snapshot, width: number, opened: Set<string>, selected: string | undefined): Ctx {
  const kids = new Map<string | undefined, StrandView[]>();
  for (const strand of snapshot.strands) {
    const siblings = kids.get(strand.parent);
    if (siblings) siblings.push(strand);
    else kids.set(strand.parent, [strand]);
  }
  return { snapshot, width, opened, selected, kids };
}

function asleep(strand: StrandView, now: number): boolean {
  return (strand.snoozedUntil ?? 0) > now;
}

function both(ctx: Ctx, key: string | undefined, draw: (picked: boolean) => string): { text: string; picked?: string } {
  if (key === undefined) return { text: draw(false) };
  const plain = draw(false);
  const picked = style.selected(draw(true));
  return { text: key === ctx.selected ? picked : plain, picked };
}

function row(ctx: Ctx, line: Line): MapRow {
  return { ...both(ctx, line.key, (picked) => rowText(ctx, line, picked)), key: line.key, ...(line.strand ? { strand: line.strand } : {}), ...(line.pr ? { pr: line.pr } : {}) };
}

function rowText(ctx: Ctx, line: Line, picked: boolean): string {
  const width = ctx.width;
  const whyW = Math.max(16, Math.min(36, Math.floor(width * 0.28)));
  const idW = Math.max(8, Math.min(18, Math.floor(width * 0.12)));
  const whereW = 9;
  const tailW = 4;
  const titleW = Math.max(10, width - 2 - line.indent - 2 - 1 - idW - whyW - 4 - 2 - whereW - tailW);
  const text = cells(
    [
      [picked ? "▎ " : "  ", style.accent],
      " ".repeat(line.indent),
      [`${line.glyph} `, line.paint],
      [cells([[line.title, (text) => (line.paint === style.faint ? style.faint(text) : style.text(picked || line.bold ? style.bold(text) : text))]], titleW)],
      " ",
      [cells([[line.id, style.faint]], idW - 1)],
      " ",
      [cells([[line.why.text, line.why.paint]], whyW)],
      [line.age.padStart(4), style.faint],
      "  ",
      [cells([[line.where ?? "", style.faint]], whereW)],
      [line.tail ?? "", style.faint],
    ],
    width,
  );
  return text;
}

function heading(ctx: Ctx, title: string, rest: Part[] = [], key?: string, strand?: StrandView): MapRow {
  const drawn = both(ctx, key, (picked) => cells([[picked ? "▎ " : "  ", style.accent], [title, (text) => style.text(style.bold(text))], ...rest], ctx.width));
  return { ...drawn, ...(key ? { key } : {}), ...(strand ? { strand } : {}) };
}

function foldRow(ctx: Ctx, key: string, indent: number, text: string, strand?: StrandView): MapRow {
  const open = ctx.opened.has(key);
  const drawn = both(ctx, key, (picked) => cells([[picked ? "▎ " : "  ", style.accent], " ".repeat(indent), [`${open ? "▾" : "▸"} ${text}`, picked ? (shown) => style.text(style.bold(shown)) : style.faint]], ctx.width));
  return { ...drawn, key, fold: true, ...(strand ? { strand } : {}) };
}

export { isStory };

export function holderOf(strands: StrandView[], strand: StrandView): StrandView {
  if (strand.own.whose !== undefined || isWaitingOn(strand, strand.own.waitsOn) || strand.rolled.whose === undefined) return strand;
  return underOf(strands, strand).find((below) => below.own.whose === strand.rolled.whose && below.own.since === strand.rolled.since && below.own.why === strand.rolled.why) ?? strand;
}

function storyLine(ctx: Ctx, strand: StrandView, indent: number): MapRow {
  const now = ctx.snapshot.now;
  const sleeping = asleep(strand, now);
  const source = sleeping ? strand : holderOf(ctx.snapshot.strands, strand);
  const standing = standingOf(source, now);
  const rest = (ctx.kids.get(strand.id) ?? []).filter((kid) => !isStory(kid));
  const tail = rest.length === 0 ? "" : ctx.opened.has(strand.id) ? " ▾" : ` ▸${rest.length}`;
  const glyph = sleeping ? { glyph: "◷", paint: style.faint } : standing;
  return row(ctx, {
    key: strand.id,
    strand,
    indent,
    glyph: glyph.glyph,
    paint: glyph.paint,
    title: strand.title ?? strand.name,
    id: strand.title ? strand.name : "",
    why: whyOf(source, now),
    age: sleeping ? "" : standing.age,
    where: strand.spaces[0]?.short ?? "",
    tail,
  });
}

function subtree(ctx: Ctx, strand: StrandView, indent: number, out: MapRow[]): void {
  const now = ctx.snapshot.now;
  const standing = standingOf(strand, now);
  out.push(row(ctx, { key: strand.id, strand, indent, glyph: standing.glyph, paint: standing.paint, title: strand.title ? `${strand.name}  ${strand.title}` : strand.name, id: "", why: whyOf(strand, now), age: standing.age, where: strand.spaces[0]?.short ?? "" }));
  for (const kid of ctx.kids.get(strand.id) ?? []) subtree(ctx, kid, indent + 2, out);
}

function story(ctx: Ctx, strand: StrandView, indent: number, out: MapRow[]): void {
  out.push(storyLine(ctx, strand, indent));
  const kids = ctx.kids.get(strand.id) ?? [];
  if (ctx.opened.has(strand.id)) for (const kid of kids.filter((candidate) => !isStory(candidate))) subtree(ctx, kid, indent + 4, out);
  const stories = kids.filter(isStory);
  if (stories.length > 0) lines(ctx, stories, indent + 2, out);
}

function shortTitle(strand: StrandView, head: StrandView): string {
  if (!strand.title) return "";
  const words = strand.title.split(/\s+/);
  const theirs = (head.title ?? "").split(/\s+/);
  let at = 0;
  while (at < words.length - 1 && at < theirs.length && words[at]!.toLowerCase() === theirs[at]!.toLowerCase()) at++;
  while (at < words.length - 1 && /^(for|to|the|on|in|of|a|an|and)$/i.test(words[at]!)) at++;
  const text = words.slice(at).join(" ");
  return text.length > 22 ? `${text.slice(0, 21).trimEnd()}…` : text;
}

export function chainsOf(strands: StrandView[]): Map<string, StrandView[]> {
  const ids = new Set(strands.map((strand) => strand.id));
  const within = (strand: StrandView) => Object.keys(strand.blockedOn ?? {}).filter((id) => ids.has(id));
  const used = new Set<string>();
  const chains = new Map<string, StrandView[]>();
  for (const head of strands.filter((strand) => within(strand).length === 0)) {
    const members = new Set([head.id]);
    const chain: StrandView[] = [];
    for (let tail = head.id; ; ) {
      const behind = strands.filter((strand) => !members.has(strand.id) && !used.has(strand.id) && within(strand).includes(tail) && within(strand).every((id) => members.has(id)));
      const next = behind.length > 1 ? behind.filter((strand) => strand.own.whose === undefined) : behind;
      if (next.length !== 1) break;
      chain.push(next[0]!);
      members.add(next[0]!.id);
      tail = next[0]!.id;
    }
    for (const strand of chain) used.add(strand.id);
    chains.set(head.id, chain);
  }
  for (const strand of strands) if (!chains.has(strand.id) && !used.has(strand.id)) chains.set(strand.id, []);
  return new Map(strands.filter((strand) => chains.has(strand.id)).map((strand) => [strand.id, chains.get(strand.id)!]));
}

function lines(ctx: Ctx, strands: StrandView[], indent: number, out: MapRow[]): void {
  const now = ctx.snapshot.now;
  const awake = strands.filter((strand) => !asleep(strand, now));
  const chains = chainsOf(awake);
  for (const [head, chain] of chains) {
    const strand = awake.find((candidate) => candidate.id === head)!;
    story(ctx, strand, indent, out);
    if (chain.length === 0) continue;
    const key = `then:${head}`;
    out.push(foldRow(ctx, key, indent + 4, `then: ${chain.map((next) => [shortTitle(next, strand), next.name].filter(Boolean).join(" ")).join(" → ")}`));
    if (ctx.opened.has(key)) for (const next of chain) story(ctx, next, indent + 2, out);
  }
  for (const strand of strands.filter((candidate) => asleep(candidate, now))) story(ctx, strand, indent, out);
}

function isInbox(strand: StrandView): boolean {
  return strand.id === reviewsId || strand.id === mentionsId;
}

export function workRows(snapshot: Snapshot, width: number, opened: Set<string>, selected?: string): MapRow[] {
  const ctx = context(snapshot, width, opened, selected);
  const now = snapshot.now;
  const tops = (ctx.kids.get(undefined) ?? []).filter((strand) => !isInbox(strand)).sort((a, b) => a.made - b.made || a.name.localeCompare(b.name));
  const epics = tops.filter((strand) => strand.kind === "epic").sort((a, b) => Number(asleep(a, now)) - Number(asleep(b, now)));
  const rest = tops.filter((strand) => strand.kind !== "epic");
  const out: MapRow[] = [];
  for (const epic of epics) {
    if (out.length > 0) out.push({ text: "" });
    const stories = ctx.kids.get(epic.id) ?? [];
    const yours = stories.filter((strand) => strand.rolled.whose === "you" && !asleep(strand, now)).length;
    const summary = [`${stories.length} ${stories.length === 1 ? "story" : "stories"}`, ...(yours > 0 ? [`${yours} yours`] : []), ...(asleep(epic, now) ? [`snoozed ${snoozedLabel(epic, now)}`] : [])].join(" · ");
    out.push(heading(ctx, epic.title ?? epic.name, [[`  ${epic.title ? `${epic.name} · ` : ""}epic · `, style.faint], [summary, style.muted]], epic.id, epic));
    lines(ctx, stories, 2, out);
  }
  if (rest.length > 0) {
    if (out.length > 0) out.push({ text: "" });
    out.push(heading(ctx, "Other work"));
    lines(ctx, rest, 2, out);
  }
  if (out.length === 0) out.push({ text: style.muted("  Nothing yet. ponpoko fills in as agents take turns and you add strands.") });
  return out;
}

export type ReviewStanding = { kind: "waiting" | "reviewed"; why: Why; yours: boolean };

export function reviewStanding(strand: StrandView): ReviewStanding {
  const ref = strand.links.filter((link) => link.adapter === stateAdapter).sort((a, b) => a.at - b.at).at(-1)?.ref ?? "";
  const [kind = "", , ...rest] = ref.split(":");
  const why = rest.join(":");
  const author = strand.open.find((move) => move.player !== "you" && move.by.kind === "person");
  if (kind === "author" || (!kind && author)) return { kind: "reviewed", why: { text: `you asked for changes · ${author?.by.who ?? "the author"} on it`, paint: style.muted }, yours: false };
  const decided = /(approved|changes requested) by (.+)$/.exec(why);
  if (decided && isPooled(strand)) return { kind: "reviewed", why: { text: `${decided[1]} by ${decided[2]} · nobody assigned`, paint: style.muted }, yours: false };
  if (isPooled(strand)) return { kind: "waiting", why: { text: "nobody yet", paint: style.muted }, yours: false };
  return { kind: "waiting", why: { text: strand.own.why || "yours", paint: style.you }, yours: true };
}

export function isPublic(strand: StrandView): boolean {
  return strand.links.some((link) => link.adapter === repoAdapter && link.ref === "public");
}

export function myPrs(snapshot: Snapshot): { strand: StrandView; pr: OwnPrView }[] {
  return snapshot.strands.filter((strand) => !strand.id.startsWith("github:")).flatMap((strand) => ownPrs(strand).filter((pr) => pr.state !== "closed").map((pr) => ({ strand, pr })));
}

function prWhy(pr: OwnPrView): { glyph: string; paint: (text: string) => string; why: Why } {
  if (pr.state === "yours") return { glyph: "●", paint: style.you, why: { text: pr.what, paint: pr.approved ? style.ok : style.you } };
  if (pr.state === "waiting") return { glyph: "⊘", paint: style.wait, why: { text: `${pr.who} · ${pr.what}`, paint: style.muted } };
  return { glyph: "○", paint: style.muted, why: { text: "draft", paint: style.muted } };
}

export function reviewRows(snapshot: Snapshot, width: number, opened: Set<string>, selected?: string): MapRow[] {
  const ctx = context(snapshot, width, opened, selected);
  const now = snapshot.now;
  const out: MapRow[] = [];
  const mine = myPrs(snapshot);
  out.push(heading(ctx, "my PRs", [[` ${mine.length}`, style.muted], ["   your open pull requests and where each stands", style.faint]]));
  for (const { strand, pr } of mine) {
    const shown = prWhy(pr);
    out.push(row(ctx, { key: `pr:${pr.url}`, strand, pr, indent: 0, glyph: shown.glyph, paint: shown.paint, title: pr.title, id: prName(pr.repo, pr.number), why: shown.why, age: standingOf(strand, now).age, where: strand.spaces[0]?.short ?? "", bold: true }));
  }
  if (mine.length === 0) out.push({ text: style.muted("    none open") });
  const reviews = snapshot.strands.filter((strand) => strand.kind === "review" && strand.parent === reviewsId);
  const newest = (a: StrandView, b: StrandView) => b.made - a.made || b.name.localeCompare(a.name);
  const reviewLine = (strand: StrandView, standing: ReviewStanding) => {
    const glyph = standing.yours ? { glyph: "●", paint: style.you } : strand.own.whose === "person" ? { glyph: "⊘", paint: style.wait } : { glyph: "○", paint: style.muted };
    return row(ctx, { key: strand.id, strand, indent: 0, glyph: glyph.glyph, paint: glyph.paint, title: strand.title ?? strand.name, id: strand.name, why: standing.why, age: standingOf(strand, now).age, where: strand.spaces[0]?.short ?? "", bold: true });
  };
  const standings = new Map(reviews.map((strand) => [strand.id, reviewStanding(strand)]));
  const waiting = reviews.filter((strand) => standings.get(strand.id)!.kind === "waiting").sort(newest);
  const internal = waiting.filter((strand) => !isPublic(strand));
  const outside = waiting.filter(isPublic);
  out.push({ text: "" }, heading(ctx, "waiting for review", [[` ${waiting.length}`, style.muted], ["   nobody has reviewed these yet · newest first · internal before public", style.faint]]));
  for (const strand of internal) out.push(reviewLine(strand, standings.get(strand.id)!));
  if (outside.length > 0) {
    out.push(foldRow(ctx, "public", 2, `${outside.length} on public repos`));
    if (opened.has("public")) for (const strand of outside) out.push(reviewLine(strand, standings.get(strand.id)!));
  }
  const reviewed = reviews.filter((strand) => standings.get(strand.id)!.kind === "reviewed").sort(newest);
  out.push({ text: "" }, heading(ctx, "already reviewed", [[` ${reviewed.length}`, style.muted], ["   still open", style.faint]]));
  for (const strand of reviewed) out.push(reviewLine(strand, standings.get(strand.id)!));
  return out;
}

export function mentionRows(snapshot: Snapshot, width: number, opened: Set<string>, selected?: string): MapRow[] {
  const ctx = context(snapshot, width, opened, selected);
  const now = snapshot.now;
  const mentions = snapshot.strands.filter((strand) => strand.parent === mentionsId).sort((a, b) => b.own.since - a.own.since);
  if (mentions.length === 0) return [{ text: style.muted("  No mentions waiting on you.") }];
  return mentions.map((strand) => {
    const standing = standingOf(strand, now);
    return row(ctx, { key: strand.id, strand, indent: 0, glyph: standing.glyph, paint: standing.paint, title: strand.title ?? strand.name, id: strand.name, why: whyOf(strand, now), age: standing.age, bold: true });
  });
}

export function areaRows(area: Area, snapshot: Snapshot, width: number, opened: Set<string>, selected?: string): MapRow[] {
  if (area === "reviews") return reviewRows(snapshot, width, opened, selected);
  if (area === "mentions") return mentionRows(snapshot, width, opened, selected);
  return workRows(snapshot, width, opened, selected);
}

export function areaCount(area: Area, snapshot: Snapshot): number {
  if (area === "mentions") return snapshot.strands.filter((strand) => strand.parent === mentionsId).length;
  if (area === "reviews") return myPrs(snapshot).length + snapshot.strands.filter((strand) => strand.kind === "review" && strand.parent === reviewsId).length;
  const epics = new Set(snapshot.strands.filter((strand) => strand.depth === 0 && strand.kind === "epic").map((strand) => strand.id));
  return snapshot.strands.filter((strand) => (strand.depth === 0 && !epics.has(strand.id) && !isInbox(strand)) || (strand.parent !== undefined && epics.has(strand.parent))).length;
}

export function areaOf(strand: StrandView, strands: StrandView[]): Area {
  const top = strand.path.length > 1 ? strands.find((candidate) => candidate.depth === 0 && candidate.name === strand.path[0]) : strand;
  if (top?.id === reviewsId) return "reviews";
  if (top?.id === mentionsId) return "mentions";
  return "work";
}

export function searchRows(snapshot: Snapshot, width: number, query: string, selected?: string): MapRow[] {
  const ctx = context(snapshot, width, new Set(), selected);
  const now = snapshot.now;
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return [{ text: style.muted("  type part of a name or title") }];
  const found = snapshot.strands.filter((strand) => !isInbox(strand) && [strand.name, strand.title ?? "", ...ownPrs(strand).map((pr) => pr.title)].some((text) => text.toLowerCase().includes(wanted)));
  if (found.length === 0) return [{ text: style.muted(`  nothing matches ${query.trim()}`) }];
  return found.map((strand) => {
    const standing = standingOf(strand, now);
    const { title } = headline(strand);
    const where = strand.path.slice(0, -1);
    return row(ctx, { key: strand.id, strand, indent: 0, glyph: standing.glyph, paint: standing.paint, title: strand.title ?? (title === strand.name ? strand.name : `${strand.name}  ${title}`), id: strand.title ? strand.name : "", why: where.length > 0 ? { text: `in ${where.join(" › ")}`, paint: style.faint } : whyOf(strand, now), age: standing.age, where: areaNames[areaOf(strand, snapshot.strands)] });
  });
}
