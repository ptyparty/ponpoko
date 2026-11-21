import { draftsOf, openableLink, pickupChoice, pickupLine, readyChoice, readyLine, serviceActions, snoozeChoices, snoozeLine, timeLine, type Actions } from "./actions.ts";
import { prName } from "./github.ts";
import { isPooled, mentionLink, ownPrs, prAdapter, type OwnPrView } from "./inbox.ts";
import { goPlace, goTarget, openTab, pickupOffer, reviewLayout, reviewOf, startsAt, tabOf, type Pickup } from "./komux/go.ts";
import { state, watch } from "./client.ts";
import { aboveOf, type Snapshot, type StrandView } from "./core.ts";
import { areaCount, areaNames, areaOf, areaRows, areas, chainsOf, isPublic, isStory, searchRows, type Area, type MapRow } from "./map.ts";
import { blockersOf, clock, fit, wrap, isWaitingOn, rows, snoozedLabel, standingOf, whyOf } from "./render.ts";
import { cells, keyLine, openScreen, style, visible, type Key, type Part } from "./screen.ts";
import { LogView } from "./log.ts";
import { EpicController } from "./epic.ts";
import { parseWhen } from "./when.ts";

type Purpose = "note" | "point" | "add" | "move" | "snooze" | "wait";
type Mode = { kind: "list" } | { kind: "pickup"; options: Pickup } | { kind: "moving"; strand: StrandView } | { kind: "waiting"; strand: StrandView } | { kind: "snooze" } | { kind: "forget" } | { kind: "assign"; strand: StrandView } | { kind: "help" } | { kind: "log" } | { kind: "search"; text: string } | { kind: "ready"; strand: StrandView; drafts: OwnPrView[] } | { kind: "epic"; view: EpicController } | { kind: "text"; purpose: Purpose; text: string; top?: boolean; strand?: StrandView };

const help = [
  " Keys",
  "",
  "   1 2 3     switch between Work, Reviews and Mentions; tab goes to the next",
  "   j k ↑ ↓   move between rows",
  "   /         search names and titles across all three, then ⏎ goes to the strand's row",
  "   ⏎         go to the strand: its agent's tab, a Claude already in the tab it lives in, or a tab opened at its directory",
  "             a review opens its pull request in the pr-review layout, asking first whether to assign yourself, and a mention opens on GitHub",
  "   ␣         open or fold a story's own strands, a chain of stories queued behind it, or the reviews on public repos",
  "   f         start a fresh Claude on the strand, even when one is already in its tab",
  "   a         add a strand under this one",
  "   A         add a strand at the top",
  "   m         move the strand: pick its new parent with j k ↑ ↓ and ⏎, t for the top, or / to type a path such as ptyparty › ponpoko; a rogue's loose strand merges into it",
  "   w         make the strand wait on another strand: pick it with j k ↑ ↓ and ⏎ (⏎ again stops waiting on it), / to type a path, or c to stop waiting on every strand; when that strand is done, this one is yours again",
  "   d         mark the strand done",
  "   o         open the strand's pull request on GitHub, or else what its latest move links to, such as a notebook page (📓) in quoll",
  "   R         mark the strand's draft pull request ready for review",
  "   y         take a review nobody has: assign yourself and open it",
  "   z         snooze the strand, then pick how long, t to type a time such as 14:30, mon 9, 2h or nov 12, or 0 till woken",
  "   n         add a note to the strand",
  "   x         forget a strand ponpoko has wrong",
  "   p         point the strand's directory at a strand, so agents there work on it",
  "   c         mark the strand caught up, so its moves are no longer new",
  "   s         start a planned strand, so it's yours until someone takes a turn on it",
  "   l         show the log of what ponpoko heard, newest first; leader m l opens it as a popup",
  "   q         quit",
  "",
  " Glyphs:  ● yours   ◐ an agent's   ⊘ waiting on someone, something or another strand   ○ waiting on a strand under it, or nobody yet   ◷ snoozed",
  " A story shows who has it anywhere under it; ▸3 after its tab says it has three strands of its own folded away.",
  "",
  " Any key goes back.",
];

const prompts: Record<Purpose, string> = {
  note: "note",
  point: "point this directory at strand",
  add: "new strand",
  move: "move under (empty for the top)",
  snooze: "snooze until",
  wait: "waits on",
};

const cardWidth = 50;

export class TabController {
  snapshot: Snapshot | undefined;
  mode: Mode = { kind: "list" };
  message: string | undefined;
  area: Area = "work";
  readonly opened = new Set<string>();
  private picked: string | undefined;
  private pickedAt = 0;
  private returnTo: string | undefined;
  private drawn: { snapshot: Snapshot; key: string; rows: MapRow[] } | undefined;
  private top = 0;
  private readonly log = new LogView();
  private height = 30;
  private width = 120;
  private down = false;

  constructor(
    private readonly actions: Actions,
    private readonly now: () => number = Date.now,
    focus: Area | undefined = undefined,
  ) {
    if (focus) this.area = focus;
  }

  setSnapshot(snapshot: Snapshot | undefined): void {
    this.log.setSnapshot(snapshot);
    if (this.mode.kind === "epic") this.mode.view.setSnapshot(snapshot);
    this.snapshot = snapshot;
    this.down = snapshot === undefined;
  }

  private strands(): StrandView[] {
    return this.snapshot?.strands ?? [];
  }

  private listWidth(): number {
    return this.beside() ? this.width - cardWidth - 3 : this.width;
  }

  private beside(): boolean {
    return this.width >= 170;
  }

  private rows(selected = this.picked): MapRow[] {
    const snapshot = this.snapshot;
    if (!snapshot) return [];
    const mode = this.mode;
    const tree = mode.kind === "moving" || mode.kind === "waiting";
    const key = [mode.kind, mode.kind === "search" ? mode.text : "", this.area, this.listWidth(), tree ? (selected ?? "") : "", [...this.opened].join(" ")].join("\n");
    if (this.drawn?.snapshot === snapshot && this.drawn.key === key) return this.drawn.rows;
    const rows = this.build(snapshot, tree ? selected : undefined);
    this.drawn = { snapshot, key, rows };
    return rows;
  }

  private build(snapshot: Snapshot, selected: string | undefined): MapRow[] {
    const width = this.listWidth();
    const mode = this.mode;
    if (mode.kind === "moving" || mode.kind === "waiting") return rows(snapshot, width, { header: false, logCount: 0, selected }).map((row) => ({ ...row, ...(row.strand ? { key: row.strand.id } : {}) }));
    if (mode.kind === "search") return searchRows(snapshot, width, mode.text, selected);
    return areaRows(this.area, snapshot, width, this.opened, selected);
  }

  private selectable(): MapRow[] {
    return this.rows().filter((row) => row.key !== undefined);
  }

  current(): MapRow | undefined {
    const selectable = this.selectable();
    const at = selectable.findIndex((row) => row.key === this.picked);
    if (at >= 0) {
      this.pickedAt = at;
      return selectable[at];
    }
    return selectable[Math.max(0, Math.min(this.pickedAt, selectable.length - 1))];
  }

  private move(by: number): void {
    const selectable = this.selectable();
    const at = Math.max(0, selectable.findIndex((row) => row.key === this.current()?.key));
    this.pickedAt = Math.max(0, Math.min(selectable.length - 1, at + by));
    this.picked = selectable[this.pickedAt]?.key;
  }

  private select(id: string): boolean {
    const at = this.selectable().findIndex((row) => row.key === id);
    if (at >= 0) {
      this.picked = id;
      this.pickedAt = at;
    }
    return at >= 0;
  }

  private startPicking(mode: Extract<Mode, { kind: "moving" | "waiting" }>, at: string): void {
    this.returnTo = this.current()?.key;
    this.mode = mode;
    this.select(at);
  }

  private stopPicking(mode: Mode, fallback: string): void {
    this.mode = mode;
    const back = this.returnTo;
    this.returnTo = undefined;
    this.picked = back ?? fallback;
    if (mode.kind === "list" && back && !this.selectable().some((row) => row.key === back)) this.picked = fallback;
  }

  private switchArea(area: Area): void {
    if (area === this.area) return;
    this.area = area;
    this.picked = undefined;
    this.pickedAt = 0;
    this.top = 0;
  }

  private reveal(strand: StrandView): void {
    this.switchArea(areaOf(strand, this.strands()));
    if (this.select(strand.id)) return;
    const path = [strand, ...aboveOf(this.strands(), strand)];
    const now = this.snapshot?.now ?? this.now();
    for (const above of path.slice(1)) this.opened.add(above.id);
    for (const at of path) {
      const siblings = this.strands().filter((candidate) => candidate.parent === at.parent && !((candidate.snoozedUntil ?? 0) > now));
      for (const [head, chain] of chainsOf(siblings)) if (chain.some((next) => next.id === at.id)) this.opened.add(`then:${head}`);
    }
    if (isPublic(strand)) this.opened.add("public");
    this.select(strand.id);
  }

  async key(key: Key): Promise<"quit" | undefined> {
    this.message = undefined;
    const mode = this.mode;
    if (mode.kind === "help") {
      this.mode = { kind: "list" };
      return undefined;
    }
    if (mode.kind === "text") return this.textKey(mode, key);
    if (mode.kind === "epic") {
      if ((await mode.view.key(key)) === "close") this.mode = { kind: "list" };
      return undefined;
    }
    if (mode.kind === "search") return this.searchKey(mode, key);
    if (mode.kind === "log") {
      if (this.log.key(key, this.height) === "close") this.mode = { kind: "list" };
      return undefined;
    }
    if (mode.kind === "moving") return this.movingKey(mode.strand, key);
    if (mode.kind === "waiting") return this.waitingKey(mode.strand, key);
    const row = this.current();
    const strand = row?.strand;
    if (mode.kind === "snooze") {
      this.mode = key.name === "t" && strand ? { kind: "text", purpose: "snooze", text: "" } : { kind: "list" };
      const choice = snoozeChoices.find((candidate) => candidate.key === key.name);
      if (choice && strand) {
        const until = choice.until(this.now());
        await this.run(() => this.actions.snooze(strand.id, until), `Snoozed ${snoozedLabel({ snoozedUntil: until }, this.now())}`);
      }
      return undefined;
    }
    if (mode.kind === "ready") {
      this.mode = { kind: "list" };
      const pr = readyChoice(mode.drafts, key.name);
      if (pr) await this.run(() => this.actions.ready(mode.strand, pr.url), (said) => String(said));
      return undefined;
    }
    if (mode.kind === "pickup") {
      this.mode = { kind: "list" };
      const how = pickupChoice(mode.options, key.name);
      if (how && strand) await this.run(() => this.actions.pickUp(strand, how), how === "resume" ? "Resuming its last Claude" : "Starting a fresh Claude on it");
      return undefined;
    }
    if (mode.kind === "assign") {
      this.mode = { kind: "list" };
      const pooled = mode.strand;
      if (key.name === "y" || key.name === "return") await this.take(pooled);
      else if (key.name === "o") await this.run(() => this.actions.go(pooled, this.strands()));
      return undefined;
    }
    if (mode.kind === "forget") {
      this.mode = { kind: "list" };
      if (key.name === "y" && strand) await this.run(() => this.actions.forget(strand.id), `Forgot ${strand.name}`);
      return undefined;
    }
    switch (key.name) {
      case "q":
      case "escape":
      case "ctrl+c":
        return "quit";
      case "1":
      case "2":
      case "3":
        this.switchArea(areas[Number(key.name) - 1]!);
        return undefined;
      case "tab":
        this.switchArea(areas[(areas.indexOf(this.area) + 1) % areas.length]!);
        return undefined;
      case "/":
        this.mode = { kind: "search", text: "" };
        this.returnTo = this.picked;
        this.picked = undefined;
        this.pickedAt = 0;
        return undefined;
      case "j":
      case "down":
        this.move(1);
        return undefined;
      case "k":
      case "up":
        this.move(-1);
        return undefined;
      case "?":
        this.mode = { kind: "help" };
        return undefined;
      case "return": {
        if (row?.fold) {
          this.toggle(row.key!);
          return undefined;
        }
        if (strand?.kind === "epic" && this.area === "work" && !row?.fold) {
          const view = new EpicController(this.actions, strand.id);
          view.setSnapshot(this.snapshot);
          this.mode = { kind: "epic", view };
          return undefined;
        }
        if (row?.pr && toMerge(row.pr)) {
          const pr = row.pr;
          await this.run(() => this.actions.open({ id: pr.url, adapter: prAdapter, ref: pr.url, at: 0 }), `Opened ${pr.url}`);
          return undefined;
        }
        const options = strand ? pickupOffer(strand, this.strands()) : undefined;
        if (!strand) this.message = "Nothing to go to here";
        else if (isPooled(strand)) this.mode = { kind: "assign", strand };
        else if (options) this.mode = { kind: "pickup", options };
        else await this.run(() => this.actions.go(strand, this.strands()));
        return undefined;
      }
      case "f":
        if (strand && startsAt(strand)) await this.run(() => this.actions.pickUp(strand, "fresh"), "Starting a fresh Claude on it");
        else this.message = "ponpoko doesn't know where to start a Claude for this strand";
        return undefined;
      case "space":
      case " ":
        if (row?.fold) this.toggle(row.key!);
        else if (strand && this.hasOwnStrands(strand)) this.toggle(strand.id);
        else this.message = "Nothing folded here";
        return undefined;
      case "y":
        if (strand && isPooled(strand)) await this.take(strand);
        else this.message = "Only a review nobody has taken can be taken";
        return undefined;
      case "o": {
        const link = row?.pr ? { id: row.pr.url, adapter: prAdapter, ref: row.pr.url, at: 0 } : strand ? openableLink(strand) : undefined;
        if (!link) this.message = "Nothing on this strand links anywhere";
        else await this.run(() => this.actions.open(link), `Opened ${link.label ?? link.ref}`);
        return undefined;
      }
      case "R": {
        const drafts = row?.pr ? (row.pr.draft && row.pr.state !== "closed" ? [row.pr] : []) : strand ? draftsOf(strand) : [];
        if (!strand || drafts.length === 0) this.message = row?.pr ? "This pull request isn't a draft" : "This strand has no draft pull request to mark ready";
        else if (drafts.length === 1) await this.run(() => this.actions.ready(strand, drafts[0]!.url), (said) => String(said));
        else this.mode = { kind: "ready", strand, drafts };
        return undefined;
      }
      case "a":
      case "A":
        this.mode = { kind: "text", purpose: "add", text: "", top: key.name === "A" || !strand };
        return undefined;
      case "m":
        if (!strand) this.message = "Pick a strand first";
        else this.startPicking({ kind: "moving", strand }, strand.parent ?? strand.id);
        return undefined;
      case "w":
        if (!strand) this.message = "Pick a strand first";
        else this.startPicking({ kind: "waiting", strand }, strand.id);
        return undefined;
      case "n":
        if (strand) this.mode = { kind: "text", purpose: "note", text: "" };
        else this.message = "Pick a strand first";
        return undefined;
      case "d":
        if (strand) await this.run(() => this.actions.done(strand.id), `${strand.name} is done`);
        return undefined;
      case "z":
        if (strand) this.mode = { kind: "snooze" };
        else this.message = "Pick a strand to snooze";
        return undefined;
      case "x":
        if (strand) this.mode = { kind: "forget" };
        else this.message = "Pick a strand to forget";
        return undefined;
      case "p":
        if (!this.pointDir()) this.message = "ponpoko doesn't know this strand's directory";
        else this.mode = { kind: "text", purpose: "point", text: "" };
        return undefined;
      case "c":
        if (strand) await this.run(() => this.actions.seen(strand.id), `${strand.name} caught up`);
        return undefined;
      case "s":
        if (strand?.planned) await this.run(() => this.actions.start(strand.id), `${strand.name} is started: it's yours until someone takes a turn on it`);
        else this.message = "Only a planned strand can be started";
        return undefined;
      case "l":
        this.mode = { kind: "log" };
        return undefined;
    }
    return undefined;
  }

  private hasOwnStrands(strand: StrandView): boolean {
    return this.strands().some((candidate) => candidate.parent === strand.id && !isStory(candidate));
  }

  private toggle(key: string): void {
    if (!this.opened.delete(key)) this.opened.add(key);
    this.picked = key;
  }

  private async take(pooled: StrandView): Promise<void> {
    if (await this.run(() => this.actions.assign(pooled), `Assigned you to ${pooled.name}`)) await this.run(() => this.actions.go(pooled, this.strands()), `Assigned you to ${pooled.name}`);
  }

  private async searchKey(mode: Extract<Mode, { kind: "search" }>, key: Key): Promise<undefined> {
    if (key.name === "escape" || key.name === "ctrl+c") this.stopPicking({ kind: "list" }, ""); else if (key.name === "backspace") mode.text = mode.text.slice(0, -1);
    else if (key.name === "down" || key.name === "tab") this.move(1);
    else if (key.name === "up") this.move(-1);
    else if (key.name === "return") {
      const strand = this.current()?.strand;
      this.stopPicking({ kind: "list" }, "");
      if (strand) this.reveal(strand);
    } else if (key.text) {
      mode.text += key.text;
      this.picked = undefined;
      this.pickedAt = 0;
    }
    return undefined;
  }

  view(width: number, height: number): string[] {
    this.height = height;
    this.width = width;
    if (this.mode.kind === "help") return help;
    if (this.mode.kind === "log") return this.log.view(width, height);
    if (this.mode.kind === "epic") return this.mode.view.view(width, height);
    if (this.down || !this.snapshot) return [" ◆ ponpoko", "", style.red(" ponpoko ✗  the service isn't running. Start it with `systemctl --user start ponpoko`."), "", " q quit"];
    const mode = this.mode;
    const current = this.current();
    const strand = current?.strand;
    const all = this.rows(current?.key);
    const chosen = all.findIndex((row) => row.key !== undefined && row.key === current?.key);
    const moving = mode.kind === "moving" || mode.kind === "waiting" ? all.find((row) => row.strand?.id === mode.strand.id) : undefined;
    const beside = this.beside();
    const card = strand && mode.kind !== "moving" && mode.kind !== "waiting" ? this.card(strand, beside ? cardWidth : width) : [];
    const footer = this.footer(width);
    const room = Math.max(3, height - 2 - (beside || card.length === 0 ? 0 : card.length + 1) - footer.length - 1);
    const at = Math.max(0, chosen);
    if (at < this.top + 2) this.top = Math.max(0, at - 2);
    if (at >= this.top + room) this.top = at - room + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, all.length - room)));
    const shown = all.slice(this.top, this.top + room).map((row) => (row === moving && row !== all[chosen] ? style.you(style.bold(`»${row.text.slice(1)}`)) : row === all[chosen] ? (row.picked ?? row.text) : row.text));
    const listWidth = this.listWidth();
    const body = beside ? Array.from({ length: Math.max(shown.length, card.length) }, (_, index) => `${cells([[shown[index] ?? ""]], listWidth)}${style.faint(" │ ")}${card[index] ?? ""}`) : [...shown, ...(card.length > 0 ? ["", ...card] : [])];
    while (body.length < height - 3 - footer.length) body.push(beside ? `${" ".repeat(listWidth)}${style.faint(" │ ")}` : "");
    return [this.header(width), "", ...body.slice(0, Math.max(0, height - 3 - footer.length)), "", ...footer];
  }

  private header(width: number): string {
    const snapshot = this.snapshot!;
    const mode = this.mode;
    const tabs: Part[] = areas.flatMap((area, index): Part[] => {
      const label = ` ${index + 1} ${areaNames[area]} ${areaCount(area, snapshot)} `;
      const on = area === this.area && mode.kind !== "search";
      return [[label, on ? (text) => style.selected(style.you(style.bold(text))) : style.muted], "  "];
    });
    const search: Part = mode.kind === "search" ? [`/ ${mode.text}▏`, (text) => style.you(style.bold(text))] : ["/ search all", style.faint];
    return style.surface(cells([[" ◆ ", (text) => style.accent(style.bold(text))], ["ponpoko   ", (text) => style.text(style.bold(text))], ...tabs, "    ", search], width));
  }

  private card(strand: StrandView, width: number): string[] {
    const now = this.snapshot?.now ?? this.now();
    const standing = standingOf(strand, now);
    const stripe = (parts: Parameters<typeof cells>[0] = []) => style.raised(cells([[" ▎", standing.paint], " ", ...parts], width));
    const above = strand.path.slice(0, -1);
    const note = strand.notes.at(-1);
    const waits = blockersOf(strand, this.strands()).map((other) => other.name);
    const behind = this.strands().filter((other) => isWaitingOn(other, strand.id)).map((other) => other.name);
    const wrapped = (text: string, paint: (text: string) => string) => wrap(text, width - 4, 3).map((line) => stripe([[line, paint]]));
    const moves = strand.recent.slice(this.height < 36 ? -1 : -3).map((move) => {
      const until = move.until === undefined ? "     " : clock(move.until);
      return stripe([[`${clock(move.from)}–${until}  ${(move.player === "you" ? (move.answers?.kind === "person" ? move.answers.who : "you") : move.by.who).padEnd(8)}  ${move.what}`, style.faint]]);
    });
    const why = whyOf(strand, now);
    const where = strand.spaces.map((space) => space.label).join(", ");
    return [
      stripe([[strand.name, (text) => style.text(style.bold(text))]]),
      ...(strand.title ? wrapped(strand.title, style.muted) : []),
      ...(above.length > 0 ? wrapped(`in ${above.join(" › ")}`, style.faint) : []),
      stripe(),
      stripe([[`${standing.glyph} `, standing.paint], [why.text, why.paint], [[standing.age, where].filter(Boolean).map((text) => ` · ${text}`).join(""), style.faint]]),
      ...ownPrs(strand)
        .filter((pr) => pr.state !== "closed")
        .flatMap((pr) => wrapped(`↗ ${prName(pr.repo, pr.number)}${pr.draft ? " (draft)" : ""} · ${pr.state === "waiting" ? `${pr.who} · ` : ""}${pr.what}`, pr.state === "yours" ? style.you : style.muted)),
      ...(waits.length > 0 ? wrapped(`waits on ${waits.join(", ")}`, style.wait) : []),
      ...(behind.length > 0 ? wrapped(`waiting behind it: ${behind.join(", ")}`, style.faint) : []),
      ...(note ? wrapped(`✎ ${note.text}`, style.muted) : []),
      ...(moves.length > 0 ? [stripe(), ...moves] : []),
    ];
  }

  private footer(width: number): string[] {
    const mode = this.mode;
    const ask = (text: string) => [style.you(` ${text}`)];
    if (mode.kind === "snooze") return ask(snoozeLine());
    if (mode.kind === "ready") return ask(readyLine(mode.drafts));
    if (mode.kind === "pickup") return ask(`no one is on it · ${pickupLine(mode.options, this.now())}`);
    if (mode.kind === "moving") return [style.you(` move ${mode.strand.name} ${this.underWhat(mode.strand)}`), keyLine([["j k", "pick its new parent"], ["⏎", "move"], ["t", "top"], ["/", "type a path"], ["esc", "cancel"]], width)];
    if (mode.kind === "waiting") return [style.you(` ${mode.strand.name} ${this.waitsWhat(mode.strand)}`), keyLine([["j k", "pick the strand it waits on"], ["⏎", "wait on it"], ["/", "type a path"], ["c", "stop waiting"], ["esc", "cancel"]], width)];
    if (mode.kind === "assign") return [style.you(` ${mode.strand.name} has no reviewer yet`), keyLine([["y ⏎", "assign yourself and open it"], ["o", "open it without assigning"], ["esc", "cancel"]], width)];
    if (mode.kind === "forget") return ask(`forget ${this.current()?.strand?.name}?  y yes   any other key no`);
    if (mode.kind === "text" && mode.purpose === "snooze") return ask(timeLine(mode.text, this.now()));
    if (mode.kind === "text") return ask(`${mode.purpose === "add" && mode.top ? "new strand at the top" : prompts[mode.purpose]}: ${mode.text}▏`);
    if (mode.kind === "search") return [keyLine([["⏎", "go to its row"], ["↑ ↓", "pick"], ["esc", "back"]], width)];
    if (this.message) return [style.warn(` ${this.message}`)];
    const row = this.current();
    const strand = row?.strand;
    if (!row) return [keyLine([["1 2 3", "areas"], ["a", "add"], ["/", "search"], ["?", "more"], ["q", "quit"]], width)];
    const enter = row.fold ? (this.opened.has(row.key!) ? "fold it away" : "open it") : strand?.kind === "epic" && this.area === "work" ? "show its stories and what blocks what" : row.pr && toMerge(row.pr) ? `open ${prName(row.pr.repo, row.pr.number)} on GitHub to merge` : strand ? enterDoes(strand, this.strands()) : "nothing to go to";
    const keys: [string, string][] = [
      ...(!row.fold && strand && this.hasOwnStrands(strand) ? [["␣", this.opened.has(strand.id) ? "fold its strands" : "its strands"] as [string, string]] : []),
      ...(strand && isPooled(strand) ? [["y", "take it"] as [string, string]] : []),
      ...(strand?.planned ? [["s", "start"] as [string, string]] : []),
      ...(row.pr || (strand && openableLink(strand)) ? [["o", row.pr || strand?.kind === "review" ? "on GitHub" : "open"] as [string, string]] : []),
      ...(strand && draftsOf(strand).length > 0 ? [["R", "mark ready"] as [string, string]] : []),
      ...(strand && !row.fold ? [["d", "done"], ["z", "snooze"], ["a", "add"], ["m", "move"], ["w", "wait on"]] as [string, string][] : []),
      ["/", "search"],
      ["?", "more"],
    ];
    const lead = ` ${style.enter("⏎")} ${style.text(style.bold(fit(enter, Math.max(30, Math.floor(width * 0.45))).trimEnd()))}  `;
    return [lead + keyLine(keys, Math.max(10, width - visible(lead)))];
  }

  private async textKey(mode: Extract<Mode, { kind: "text" }>, key: Key): Promise<undefined> {
    if (key.name === "escape" || key.name === "ctrl+c") this.mode = { kind: "list" };
    else if (key.name === "backspace") mode.text = mode.text.slice(0, -1);
    else if (key.name === "return") {
      const strand = mode.strand ?? this.current()?.strand;
      const text = mode.text.trim();
      if (mode.purpose === "snooze") return this.snoozeUntil(strand, text);
      this.mode = { kind: "list" };
      if (text === "" && mode.purpose !== "move") return undefined;
      if (mode.purpose === "add") await this.run(() => this.actions.add(mode.top ? undefined : strand?.id, text), `Added ${text}`);
      else if (!strand) return undefined;
      else if (mode.purpose === "note") await this.run(() => this.actions.note(strand.id, text), "Note added");
      else if (mode.purpose === "move") await this.run(() => this.actions.reparent(strand.id, text), text === "" ? `${strand.name} is at the top` : `${strand.name} is under ${text}`);
      else if (mode.purpose === "wait") await this.run(() => this.actions.block(strand.id, text), `${strand.name} waits on ${text}`);
      else {
        const dir = this.pointDir()!;
        await this.run(() => this.actions.point(dir, text), `${dir} now works on ${text}`);
      }
    } else if (key.text) mode.text += key.text;
    return undefined;
  }

  private pickedKey(picking: StrandView, key: Key): boolean {
    switch (key.name) {
      case "j":
      case "down":
        this.move(1);
        return true;
      case "k":
      case "up":
        this.move(-1);
        return true;
      case "escape":
      case "q":
      case "ctrl+c":
        this.stopPicking({ kind: "list" }, picking.id);
        return true;
    }
    return false;
  }

  private async movingKey(moving: StrandView, key: Key): Promise<undefined> {
    const target = this.current()?.strand;
    if (this.pickedKey(moving, key)) return undefined;
    switch (key.name) {
      case "/":
        this.stopPicking({ kind: "text", purpose: "move", text: "", strand: moving }, moving.id);
        return undefined;
      case "t":
        this.stopPicking({ kind: "list" }, moving.id);
        await this.run(() => this.actions.reparent(moving.id, ""), `${moving.name} is at the top`);
        return undefined;
      case "return":
        if (!target || this.cannotHold(moving, target)) return undefined;
        this.stopPicking({ kind: "list" }, moving.id);
        if (target.id !== moving.parent) await this.run(() => this.actions.reparent(moving.id, target.id), `${moving.name} is under ${target.name}`);
        return undefined;
    }
    return undefined;
  }

  private async waitingKey(picked: StrandView, key: Key): Promise<undefined> {
    const waiting = this.strands().find((strand) => strand.id === picked.id) ?? picked;
    const target = this.current()?.strand;
    if (this.pickedKey(waiting, key)) return undefined;
    switch (key.name) {
      case "/":
        this.stopPicking({ kind: "text", purpose: "wait", text: "", strand: waiting }, waiting.id);
        return undefined;
      case "c":
        this.stopPicking({ kind: "list" }, waiting.id);
        await this.run(() => this.actions.unblock(waiting.id), `${waiting.name} no longer waits on other strands`);
        return undefined;
      case "return":
        if (!target || target.id === waiting.id) return undefined;
        this.stopPicking({ kind: "list" }, waiting.id);
        if (isWaitingOn(waiting, target.id)) await this.run(() => this.actions.unblock(waiting.id, target.id), `${waiting.name} no longer waits on ${target.name}`);
        else await this.run(() => this.actions.block(waiting.id, target.id), `${waiting.name} waits on ${target.name}`);
        return undefined;
    }
    return undefined;
  }

  private waitsWhat(picked: StrandView): string {
    const waiting = this.strands().find((strand) => strand.id === picked.id) ?? picked;
    const target = this.current()?.strand;
    if (!target) return "";
    if (target.id === waiting.id) return "can't wait on itself";
    return isWaitingOn(waiting, target.id) ? `stops waiting on ${target.name}` : `waits on ${target.name}`;
  }

  private underWhat(moving: StrandView): string {
    const target = this.current()?.strand;
    if (!target) return "";
    if (this.cannotHold(moving, target)) return `can't go under ${target.id === moving.id ? "itself" : "a strand under it"}`;
    return target.id === moving.parent ? `stays under ${target.name}` : `under ${target.name}`;
  }

  private cannotHold(moving: StrandView, target: StrandView): boolean {
    return target.id === moving.id || aboveOf(this.strands(), target).some((above) => above.id === moving.id);
  }

  private async snoozeUntil(strand: StrandView | undefined, text: string): Promise<undefined> {
    const until = parseWhen(text, this.now());
    if (until === undefined) {
      this.message = `ponpoko can't read "${text}" as a time to come`;
      return undefined;
    }
    this.mode = { kind: "list" };
    if (strand) await this.run(() => this.actions.snooze(strand.id, until), `Snoozed ${snoozedLabel({ snoozedUntil: until }, this.now())}`);
    return undefined;
  }

  private pointDir(): string | undefined {
    const strand = this.current()?.strand;
    if (!strand) return undefined;
    for (const move of [...strand.open, ...[...strand.recent].reverse()]) {
      const dir = (move.answers ?? move.by).place?.dir;
      if (typeof dir === "string") return dir;
    }
    return strand.dir;
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

function toMerge(pr: OwnPrView): boolean {
  return pr.state === "yours" && pr.approved === true;
}


export type Live = { setSnapshot: (snapshot: Snapshot | undefined) => void; view: (width: number, height: number) => string[]; key: (key: Key, height: number) => Promise<"quit" | "close" | undefined> | "quit" | "close" | undefined };

export async function runLive(controller: Live): Promise<number> {
  let connection: { close: () => void } | undefined;
  let closed = false;
  const draw = () => screen.draw(controller.view(screen.width, screen.height));
  const reload = async () => {
    controller.setSnapshot(await state().catch(() => undefined));
    if (!closed) draw();
  };
  const connect = async () => {
    connection = await watch(
      () => void reload(),
      () => {
        connection = undefined;
      },
    ).catch(() => undefined);
  };
  const done = Promise.withResolvers<void>();
  const screen = openScreen(
    (key) =>
      void Promise.resolve(controller.key(key, screen.height)).then(async (outcome) => {
        if (outcome === "quit" || outcome === "close") return done.resolve();
        await reload();
      }),
    () => draw(),
    () => {
      draw();
      void reload();
    },
  );
  await reload();
  await connect();
  const ticker = setInterval(() => {
    if (!connection) void connect();
    void reload();
  }, 15_000);
  await done.promise;
  closed = true;
  clearInterval(ticker);
  connection?.close();
  screen.close();
  return 0;
}

export function runTab(args: string[] = []): Promise<number> {
  return runLive(new TabController(serviceActions, Date.now, args.includes("--reviews") ? "reviews" : args.includes("--mentions") ? "mentions" : undefined));
}

export function enterDoes(strand: StrandView, strands: StrandView[]): string {
  if (mentionLink(strand)) return "open the mention on GitHub";
  if (isPooled(strand)) return `take ${strand.name}: assign yourself and open it in ${reviewLayout()}`;
  const target = goTarget(strand, strands);
  if (target) return `go to ${target.player.who} in ${target.player.space ?? "its tab"}`;
  const open = openTab(strand);
  if (open) return `go to ${open.label}`;
  if (reviewOf(strand) && !tabOf(strand)) return `open ${strand.name} in ${reviewLayout()}`;
  const options = pickupOffer(strand, strands);
  if (options?.resume) return `resume ${options.resume.who} on ${strand.name}, or start a fresh Claude`;
  if (options) return `start a Claude on ${strand.name}`;
  const place = goPlace(strand, aboveOf(strands, strand));
  if (isWaitingOn(strand, strand.own.waitsOn)) return place ? `open a tab at ${place.dir}; it's ${strand.own.why}` : `nothing here; it's ${strand.own.why}`;
  if (strand.own.whose === undefined && !strand.own.quiet) return place ? `open a tab at ${place.dir}; its work is in the strands under it` : "nothing here; its work is in the strands under it";
  return place ? `open a tab at ${place.dir}` : "nothing: no one is on it, and ponpoko doesn't know where it lives (p points a directory at it)";
}
