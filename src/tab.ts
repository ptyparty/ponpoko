import { pickup, pickupChoice, pickupLine, serviceActions, snoozeChoices, snoozeLine, type Actions } from "./actions.ts";
import { goPlace, goTarget, pickupOffer, startsAt, type Pickup } from "./komux/go.ts";
import { state, watch } from "./client.ts";
import { aboveOf, type Snapshot, type StrandView } from "./core.ts";
import { clock, rows, type Row, type Tone } from "./render.ts";
import { openScreen, style, type Key } from "./screen.ts";

type Purpose = "note" | "point" | "add" | "move";
type Mode = { kind: "list" } | { kind: "pickup"; options: Pickup } | { kind: "snooze" } | { kind: "forget" } | { kind: "help" } | { kind: "text"; purpose: Purpose; text: string; top?: boolean };

const keysLine = "␣ moves   f fresh   a/A add   m move   d done   o open   z snooze   n note   x forget   p point   c caught up   ? keys   q quit";

const help = [
  " Keys",
  "",
  "   j k ↑ ↓   move between strands",
  "   ⏎         go to the strand: its agent's tab, a Claude already in the tab it lives in, or a tab opened at its directory",
  "   f         start a fresh Claude on the strand, even when one is already in its tab",
  "   ␣         show or hide the strand's moves",
  "   a         add a strand under this one",
  "   A         add a strand at the top",
  "   m         move the strand under another, named by its path, such as ptyparty › ponpoko; a rogue's loose strand merges into it",
  "   d         mark the strand done",
  "   o         open what the strand's latest move links to, such as a notebook page (📓) in quoll",
  "   z         snooze the strand, then pick how long",
  "   n         add a note to the strand",
  "   x         forget a strand ponpoko has wrong",
  "   p         point the strand's directory at a strand, so agents there work on it",
  "   c         mark the strand caught up, so its moves are no longer new (*)",
  "   q         quit",
  "",
  " Glyphs:  ● yours   ◐ an agent's   ⊘ waiting on someone or something   ◷ snoozed   ○ nothing to do",
  "",
  " Any key goes back.",
];

const prompts: Record<Purpose, string> = {
  note: "note",
  point: "point this directory at strand",
  add: "new strand",
  move: "move under (empty for the top)",
};

export class TabController {
  snapshot: Snapshot | undefined;
  mode: Mode = { kind: "list" };
  message: string | undefined;
  selected = 0;
  readonly expanded = new Set<string>();
  private top = 0;
  private down = false;

  constructor(
    private readonly actions: Actions,
    private readonly now: () => number = Date.now,
  ) {}

  setSnapshot(snapshot: Snapshot | undefined): void {
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
    const strand = this.current()?.strand;
    if (mode.kind === "snooze") {
      this.mode = { kind: "list" };
      const choice = snoozeChoices.find((candidate) => candidate.key === key.name);
      if (choice && strand) {
        const until = choice.until(this.now());
        await this.run(() => this.actions.snooze(strand.id, until), `Snoozed till ${clock(until)}`);
      }
      return undefined;
    }
    if (mode.kind === "pickup") {
      this.mode = { kind: "list" };
      const how = pickupChoice(mode.options, key.name);
      if (how && strand) await this.run(() => this.actions.pickUp(strand, how), how === "resume" ? "Resuming its last Claude" : "Starting a fresh Claude on it");
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
        else await this.run(() => this.actions.go(strand, this.strands()));
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
        else await this.run(() => this.actions.open(link), `Opened ${link.ref}`);
        return undefined;
      }
      case "a":
      case "A":
        this.mode = { kind: "text", purpose: "add", text: "", top: key.name === "A" || !strand };
        return undefined;
      case "m":
      case "n":
        if (strand) this.mode = { kind: "text", purpose: key.name === "m" ? "move" : "note", text: "" };
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
    }
    return undefined;
  }

  view(width: number, height: number): string[] {
    if (this.mode.kind === "help") return help;
    if (this.down || !this.snapshot) return [" ◆ ponpoko", "", style.red(" ponpoko ✗  the service isn't running. Start it with `systemctl --user start ponpoko`."), "", " q quit"];
    const all = rows(this.snapshot, width, { expanded: this.expanded });
    const selectable = all.filter(isSelectable);
    const chosen = selectable[this.selected];
    const footer = this.footer();
    const room = Math.max(3, height - footer.length - 1);
    const at = chosen ? all.indexOf(chosen) : 0;
    if (at < this.top + 2) this.top = Math.max(0, at - 2);
    if (at >= this.top + room) this.top = at - room + 1;
    const shown = all.slice(this.top, this.top + room).map((row) => paint(row, row === chosen, width));
    while (shown.length < room) shown.push("");
    return [...shown, "", ...footer];
  }

  private footer(): string[] {
    const mode = this.mode;
    if (mode.kind === "snooze") return [style.amber(` ${snoozeLine()}`)];
    if (mode.kind === "pickup") return [style.amber(` no one is on it · ${pickupLine(mode.options, this.now())}`)];
    if (mode.kind === "forget") return [style.amber(` forget ${this.current()?.strand?.name}?  y yes   any other key no`)];
    if (mode.kind === "text") return [style.amber(` ${mode.purpose === "add" && mode.top ? "new strand at the top" : prompts[mode.purpose]}: ${mode.text}▏`)];
    if (this.message) return [style.amber(` ${this.message}`)];
    const strand = this.current()?.strand;
    return [`${style.bold(` ⏎ ${strand ? enterDoes(strand, this.strands()) : "nothing to go to"}`)}`, style.dim(` ${keysLine}`)];
  }

  private async textKey(mode: Extract<Mode, { kind: "text" }>, key: Key): Promise<undefined> {
    if (key.name === "escape" || key.name === "ctrl+c") this.mode = { kind: "list" };
    else if (key.name === "backspace") mode.text = mode.text.slice(0, -1);
    else if (key.name === "return") {
      this.mode = { kind: "list" };
      const strand = this.current()?.strand;
      const text = mode.text.trim();
      if (text === "" && mode.purpose !== "move") return undefined;
      if (mode.purpose === "add") await this.run(() => this.actions.add(mode.top ? undefined : strand?.id, text), `Added ${text}`);
      else if (!strand) return undefined;
      else if (mode.purpose === "note") await this.run(() => this.actions.note(strand.id, text), "Note added");
      else if (mode.purpose === "move") await this.run(() => this.actions.reparent(strand.id, text), text === "" ? `${strand.name} is at the top` : `${strand.name} is under ${text}`);
      else {
        const dir = this.pointDir()!;
        await this.run(() => this.actions.point(dir, text), `${dir} now works on ${text}`);
      }
    } else if (key.text) mode.text += key.text;
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

  private async run(action: () => Promise<unknown>, done?: string): Promise<void> {
    try {
      await action();
      this.message = done;
    } catch (error) {
      this.message = (error as Error).message;
    }
  }

  private selectable(): Row[] {
    return this.snapshot ? rows(this.snapshot, 100, { expanded: this.expanded, heardCount: 0 }).filter(isSelectable) : [];
  }
}

function isSelectable(row: Row): boolean {
  return row.strand !== undefined;
}

const tones: Record<Tone, (text: string) => string> = {
  you: style.amber,
  agent: style.cyan,
  waiting: style.magenta,
  quiet: style.dim,
  heading: style.bold,
  dim: style.dim,
};

function paint(row: Row, selected: boolean, width: number): string {
  if (selected) return style.reverse(row.text.padEnd(width));
  return row.tone ? tones[row.tone](row.text) : row.text;
}

export async function runTab(): Promise<number> {
  const controller = new TabController(serviceActions);
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
      void controller.key(key).then(async (outcome) => {
        if (outcome === "quit") return done.resolve();
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

function enterDoes(strand: StrandView, strands: StrandView[]): string {
  const target = goTarget(strand, strands);
  if (target) return `go to ${target.player.who} in ${target.player.space ?? "its tab"}`;
  const options = pickupOffer(strand, strands);
  if (options?.resume) return `resume ${options.resume.who} on ${strand.name}, or start a fresh Claude`;
  if (options) return `start a Claude on ${strand.name}`;
  const place = goPlace(strand, aboveOf(strands, strand));
  if (strand.own.whose === undefined) return place ? `open a tab at ${place.dir}; its work is in the strands under it` : "nothing here; its work is in the strands under it";
  return place ? `open a tab at ${place.dir}` : "nothing: no one is on it, and ponpoko doesn't know where it lives (p points a directory at it)";
}
