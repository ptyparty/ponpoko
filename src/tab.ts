import { pickup, pickupChoice, pickupLine, serviceActions, snoozeChoices, snoozeLine, timeLine, type Actions } from "./actions.ts";
import { goPlace, goTarget, openTab, pickupOffer, startsAt, type Pickup } from "./komux/go.ts";
import { state, watch } from "./client.ts";
import { aboveOf, type Snapshot, type StrandView } from "./core.ts";
import { blockersOf, clock, header, isWaitingOn, rows, snoozedLabel, standingOf, type Row } from "./render.ts";
import { cells, keyLine, openScreen, style, type Key } from "./screen.ts";
import { LogView } from "./log.ts";
import { parseWhen } from "./when.ts";

type Purpose = "note" | "point" | "add" | "move" | "snooze" | "wait";
type Mode = { kind: "list" } | { kind: "pickup"; options: Pickup } | { kind: "moving"; strand: StrandView } | { kind: "waiting"; strand: StrandView } | { kind: "snooze" } | { kind: "forget" } | { kind: "help" } | { kind: "log" } | { kind: "text"; purpose: Purpose; text: string; top?: boolean };

const keys: [string, string][] = [["␣", "moves"], ["a", "add"], ["m", "move"], ["w", "wait on"], ["d", "done"], ["z", "snooze"], ["n", "note"], ["f", "fresh Claude"], ["l", "log"], ["?", "all keys"], ["q", "quit"]];

const help = [
  " Keys",
  "",
  "   j k ↑ ↓   move between strands",
  "   ⏎         go to the strand: its agent's tab, a Claude already in the tab it lives in, or a tab opened at its directory",
  "   f         start a fresh Claude on the strand, even when one is already in its tab",
  "   ␣         show or hide the strand's moves",
  "   a         add a strand under this one",
  "   A         add a strand at the top",
  "   m         move the strand: pick its new parent with j k ↑ ↓ and ⏎, t for the top, or / to type a path such as ptyparty › ponpoko; a rogue's loose strand merges into it",
  "   w         make the strand wait on another strand: pick it with j k ↑ ↓ and ⏎ (⏎ again stops waiting on it), / to type a path, or c to stop waiting on every strand; when that strand is done, this one is yours again",
  "   d         mark the strand done",
  "   o         open what the strand's latest move links to, such as a notebook page (📓) in quoll",
  "   z         snooze the strand, then pick how long, t to type a time such as 14:30, mon 9, 2h or nov 12, or 0 till woken",
  "   n         add a note to the strand",
  "   x         forget a strand ponpoko has wrong",
  "   p         point the strand's directory at a strand, so agents there work on it",
  "   c         mark the strand caught up, so its moves are no longer new (•)",
  "   l         show the log of what ponpoko heard, newest first; leader m l opens it as a popup",
  "   q         quit",
  "",
  " Glyphs:  ● yours   ◐ an agent's   ⊘ waiting on someone, something or another strand   ○ waiting on a strand under it   ◷ snoozed",
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

export class TabController {
  snapshot: Snapshot | undefined;
  mode: Mode = { kind: "list" };
  message: string | undefined;
  selected = 0;
  readonly expanded = new Set<string>();
  private top = 0;
  private readonly log = new LogView();
  private height = 30;
  private down = false;

  constructor(
    private readonly actions: Actions,
    private readonly now: () => number = Date.now,
  ) {}

  setSnapshot(snapshot: Snapshot | undefined): void {
    this.log.setSnapshot(snapshot);
    const before = this.current();
    this.snapshot = snapshot;
    this.down = snapshot === undefined;
    if (!snapshot || !before) return;
    const again = this.selectable().findIndex((row) => row.strand?.id === before.strand?.id);
    if (again >= 0) this.selected = again;
    this.selected = Math.min(this.selected, Math.max(0, this.selectable().length - 1));
  }

  private strands(): StrandView[] {
    return this.snapshot?.strands ?? [];
  }

  current(): Row | undefined {
    return this.selectable()[this.selected];
  }

  async key(key: Key): Promise<"quit" | undefined> {
    this.message = undefined;
    const mode = this.mode;
    if (mode.kind === "help") {
      this.mode = { kind: "list" };
      return undefined;
    }
    if (mode.kind === "text") return this.textKey(mode, key);
    if (mode.kind === "log") {
      if (this.log.key(key, this.height) === "close") this.mode = { kind: "list" };
      return undefined;
    }
    if (mode.kind === "moving") return this.movingKey(mode.strand, key);
    if (mode.kind === "waiting") return this.waitingKey(mode.strand, key);
    const strand = this.current()?.strand;
    if (mode.kind === "snooze") {
      this.mode = key.name === "t" && strand ? { kind: "text", purpose: "snooze", text: "" } : { kind: "list" };
      const choice = snoozeChoices.find((candidate) => candidate.key === key.name);
      if (choice && strand) {
        const until = choice.until(this.now());
        await this.run(() => this.actions.snooze(strand.id, until), `Snoozed ${snoozedLabel({ snoozedUntil: until }, this.now())}`);
      }
      return undefined;
    }
    if (mode.kind === "pickup") {
      this.mode = { kind: "list" };
      const how = pickupChoice(mode.options, key.name);
      if (how && strand && (await this.run(() => this.actions.pickUp(strand, how), how === "resume" ? "Resuming its last Claude" : "Starting a fresh Claude on it"))) await this.caughtUpOnFinish(strand);
      return undefined;
    }
    if (mode.kind === "forget") {
      this.mode = { kind: "list" };
      if (key.name === "y" && strand) await this.run(() => this.actions.forget(strand.id), `Forgot ${strand.name}`);
      return undefined;
    }
    const count = this.selectable().length;
    switch (key.name) {
      case "q":
      case "escape":
      case "ctrl+c":
        return "quit";
      case "j":
      case "down":
        this.selected = Math.min(this.selected + 1, Math.max(0, count - 1));
        return undefined;
      case "k":
      case "up":
        this.selected = Math.max(this.selected - 1, 0);
        return undefined;
      case "?":
        this.mode = { kind: "help" };
        return undefined;
      case "return": {
        const options = strand ? pickupOffer(strand, this.strands()) : undefined;
        if (!strand) this.message = "Nothing to go to here";
        else if (options) this.mode = { kind: "pickup", options };
        else if (await this.run(() => this.actions.go(strand, this.strands()))) await this.caughtUpOnFinish(strand);
        return undefined;
      }
      case "f":
        if (strand && startsAt(strand)) await this.run(() => this.actions.pickUp(strand, "fresh"), "Starting a fresh Claude on it");
        else this.message = "ponpoko doesn't know where to start a Claude for this strand";
        return undefined;
      case "space":
      case " ":
        if (strand && !this.expanded.delete(strand.id)) this.expanded.add(strand.id);
        return undefined;
      case "o": {
        const link = strand
          ? [...strand.recent.flatMap((move) => move.links), ...strand.links]
              .filter((candidate) => candidate.adapter !== "dir")
              .sort((a, b) => a.at - b.at)
              .at(-1)
          : undefined;
        if (!link) this.message = "Nothing on this strand links anywhere";
        else await this.run(() => this.actions.open(link), `Opened ${link.label ?? link.ref}`);
        return undefined;
      }
      case "a":
      case "A":
        this.mode = { kind: "text", purpose: "add", text: "", top: key.name === "A" || !strand };
        return undefined;
      case "m":
        if (!strand) this.message = "Pick a strand first";
        else {
          this.mode = { kind: "moving", strand };
          this.select(strand.parent ?? strand.id);
        }
        return undefined;
      case "w":
        if (!strand) this.message = "Pick a strand first";
        else this.mode = { kind: "waiting", strand };
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
      case "l":
        this.mode = { kind: "log" };
        return undefined;
    }
    return undefined;
  }

  view(width: number, height: number): string[] {
    this.height = height;
    if (this.mode.kind === "help") return help;
    if (this.mode.kind === "log") return this.log.view(width, height);
    if (this.down || !this.snapshot) return [" ◆ ponpoko", "", style.red(" ponpoko ✗  the service isn't running. Start it with `systemctl --user start ponpoko`."), "", " q quit"];
    const mode = this.mode;
    const strand = this.current()?.strand;
    const all = rows(this.snapshot, width, { expanded: this.expanded, header: false, selected: strand?.id, logCount: 0 });
    const chosen = all.find((row) => row.strand !== undefined && row.strand.id === strand?.id);
    const moving = mode.kind === "moving" || mode.kind === "waiting" ? all.find((row) => row.strand?.id === mode.strand.id) : undefined;
    const card = strand && mode.kind !== "moving" && mode.kind !== "waiting" ? this.card(strand, width) : [];
    const footer = this.footer();
    const room = Math.max(3, height - 2 - (card.length > 0 ? card.length + 1 : 0) - footer.length - 1);
    const at = chosen ? all.indexOf(chosen) : 0;
    if (at < this.top + 2) this.top = Math.max(0, at - 2);
    if (at >= this.top + room) this.top = at - room + 1;
    const shown = all.slice(this.top, this.top + room).map((row) => (row === chosen ? style.selected(row.text) : row === moving ? style.you(style.bold(`»${row.text.slice(1)}`)) : row.text));
    const body = [...shown, ...(card.length > 0 ? ["", ...card] : [])];
    while (body.length < height - 3 - footer.length) body.push("");
    return [header(this.snapshot, width), "", ...body, "", ...footer];
  }

  private card(strand: StrandView, width: number): string[] {
    const now = this.snapshot?.now ?? this.now();
    const standing = standingOf(strand, now);
    const stripe = (parts: Parameters<typeof cells>[0] = []) => style.raised(cells([[" ▎", standing.paint], " ", ...parts], width));
    const above = strand.path.slice(0, -1);
    const note = strand.notes.at(-1);
    const waits = blockersOf(strand, this.strands()).map((other) => other.name);
    const moves = strand.recent.slice(-2).map((move) => {
      const until = move.until === undefined ? "     " : clock(move.until);
      return stripe([[`${clock(move.from)}–${until}  ${(move.player === "you" ? "you" : move.by.who).padEnd(8)}  ${move.what}`, style.faint]]);
    });
    return [
      stripe([[strand.name, (text) => style.text(style.bold(text))], ...(strand.title ? ["  ", [strand.title, style.muted] as [string, (text: string) => string]] : [])]),
      ...(above.length > 0 ? [stripe([[`in ${above.join(" › ")}`, style.faint]])] : []),
      stripe(),
      stripe([[`${standing.glyph} `, standing.paint], [standing.text, standing.paint], [standing.age ? `  ·  ${standing.age}` : "", style.faint]]),
      ...(waits.length > 0 ? [stripe([[`waits on ${waits.join(", ")}`, style.wait]])] : []),
      ...(note ? [stripe([[`✎ ${note.text}`, style.muted]])] : []),
      ...moves,
    ];
  }

  private footer(): string[] {
    const mode = this.mode;
    const ask = (text: string) => [style.you(` ${text}`)];
    if (mode.kind === "snooze") return ask(snoozeLine());
    if (mode.kind === "pickup") return ask(`no one is on it · ${pickupLine(mode.options, this.now())}`);
    if (mode.kind === "moving") return [style.you(` move ${mode.strand.name} ${this.underWhat(mode.strand)}`), keyLine([["j k", "pick its new parent"], ["⏎", "move"], ["t", "top"], ["/", "type a path"], ["esc", "cancel"]])];
    if (mode.kind === "waiting") return [style.you(` ${mode.strand.name} ${this.waitsWhat(mode.strand)}`), keyLine([["j k", "pick the strand it waits on"], ["⏎", "wait on it"], ["/", "type a path"], ["c", "stop waiting"], ["esc", "cancel"]])];
    if (mode.kind === "forget") return ask(`forget ${this.current()?.strand?.name}?  y yes   any other key no`);
    if (mode.kind === "text" && mode.purpose === "snooze") return ask(timeLine(mode.text, this.now()));
    if (mode.kind === "text") return ask(`${mode.purpose === "add" && mode.top ? "new strand at the top" : prompts[mode.purpose]}: ${mode.text}▏`);
    const strand = this.current()?.strand;
    const first = this.message ? style.warn(` ${this.message}`) : ` ${style.enter("⏎")} ${style.text(style.bold(strand ? enterDoes(strand, this.strands()) : "nothing to go to"))}`;
    return [first, keyLine(keys)];
  }

  private async textKey(mode: Extract<Mode, { kind: "text" }>, key: Key): Promise<undefined> {
    if (key.name === "escape" || key.name === "ctrl+c") this.mode = { kind: "list" };
    else if (key.name === "backspace") mode.text = mode.text.slice(0, -1);
    else if (key.name === "return") {
      const strand = this.current()?.strand;
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

  private picked(picking: StrandView, key: Key): boolean {
    switch (key.name) {
      case "j":
      case "down":
        this.selected = Math.min(this.selected + 1, Math.max(0, this.selectable().length - 1));
        return true;
      case "k":
      case "up":
        this.selected = Math.max(this.selected - 1, 0);
        return true;
      case "escape":
      case "q":
      case "ctrl+c":
        this.mode = { kind: "list" };
        this.select(picking.id);
        return true;
    }
    return false;
  }

  private async movingKey(moving: StrandView, key: Key): Promise<undefined> {
    const target = this.current()?.strand;
    if (this.picked(moving, key)) return undefined;
    switch (key.name) {
      case "/":
        this.mode = this.select(moving.id) ? { kind: "text", purpose: "move", text: "" } : { kind: "list" };
        return undefined;
      case "t":
        this.mode = { kind: "list" };
        this.select(moving.id);
        await this.run(() => this.actions.reparent(moving.id, ""), `${moving.name} is at the top`);
        return undefined;
      case "return":
        if (!target || this.cannotHold(moving, target)) return undefined;
        this.mode = { kind: "list" };
        this.select(moving.id);
        if (target.id !== moving.parent) await this.run(() => this.actions.reparent(moving.id, target.id), `${moving.name} is under ${target.name}`);
        return undefined;
    }
    return undefined;
  }

  private async waitingKey(picked: StrandView, key: Key): Promise<undefined> {
    const waiting = this.strands().find((strand) => strand.id === picked.id) ?? picked;
    const target = this.current()?.strand;
    if (this.picked(waiting, key)) return undefined;
    switch (key.name) {
      case "/":
        this.mode = this.select(waiting.id) ? { kind: "text", purpose: "wait", text: "" } : { kind: "list" };
        return undefined;
      case "c":
        this.mode = { kind: "list" };
        this.select(waiting.id);
        await this.run(() => this.actions.unblock(waiting.id), `${waiting.name} no longer waits on other strands`);
        return undefined;
      case "return":
        if (!target || target.id === waiting.id) return undefined;
        this.mode = { kind: "list" };
        this.select(waiting.id);
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

  private select(id: string): boolean {
    const at = this.selectable().findIndex((row) => row.strand?.id === id);
    if (at >= 0) this.selected = at;
    return at >= 0;
  }

  private async caughtUpOnFinish(strand: StrandView): Promise<void> {
    if (strand.own.finished) await this.actions.seen(strand.id).catch(() => undefined);
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

  private async run(action: () => Promise<unknown>, done?: string): Promise<boolean> {
    try {
      await action();
      this.message = done;
      return true;
    } catch (error) {
      this.message = (error as Error).message;
      return false;
    }
  }

  private selectable(): Row[] {
    return this.snapshot ? rows(this.snapshot, 100, { expanded: this.expanded, logCount: 0 }).filter(isSelectable) : [];
  }
}

function isSelectable(row: Row): boolean {
  return row.strand !== undefined;
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
    draw,
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

export function runTab(): Promise<number> {
  return runLive(new TabController(serviceActions));
}

function enterDoes(strand: StrandView, strands: StrandView[]): string {
  const target = goTarget(strand, strands);
  if (target) return `go to ${target.player.who} in ${target.player.space ?? "its tab"}`;
  const open = openTab(strand);
  if (open) return `go to ${open.label}`;
  const options = pickupOffer(strand, strands);
  if (options?.resume) return `resume ${options.resume.who} on ${strand.name}, or start a fresh Claude`;
  if (options) return `start a Claude on ${strand.name}`;
  const place = goPlace(strand, aboveOf(strands, strand));
  if (isWaitingOn(strand, strand.own.waitsOn)) return place ? `open a tab at ${place.dir}; it's ${strand.own.why}` : `nothing here; it's ${strand.own.why}`;
  if (strand.own.whose === undefined) return place ? `open a tab at ${place.dir}; its work is in the strands under it` : "nothing here; its work is in the strands under it";
  return place ? `open a tab at ${place.dir}` : "nothing: no one is on it, and ponpoko doesn't know where it lives (p points a directory at it)";
}
