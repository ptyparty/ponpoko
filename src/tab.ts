import { serviceActions, snoozeChoices, snoozeLine, type Actions } from "./actions.ts";
import { state, watch } from "./client.ts";
import type { Snapshot } from "./core.ts";
import { clock, rows, type Row, type Tone } from "./render.ts";
import { openScreen, style, type Key } from "./screen.ts";

type Mode = { kind: "list" } | { kind: "snooze" } | { kind: "forget" } | { kind: "help" } | { kind: "text"; purpose: "note" | "point"; text: string };

const keysLine = " ⏎ go   o open page   z snooze   n note   x forget   p point   c caught up   ? keys   q quit";

const help = [
  " Keys",
  "",
  "   j k ↑ ↓   move between braids and strands",
  "   ⏎         go to the strand: focus its pane, or reopen its tab",
  "   o         open the notebook page an agent's status points at (📓), in quoll",
  "   z         snooze the strand, then pick how long",
  "   n         add a note to the braid",
  "   x         forget a strand ponpoko has wrong, such as a pane long gone",
  "   p         point the braid's directory at another braid, such as sc-1234",
  "   c         mark the braid caught up, so its moves are no longer new (*)",
  "   q         quit",
  "",
  " Glyphs:  ● yours   ◐ an agent's   ⊘ waiting on someone or something   ◷ snoozed   ○ idle",
  "",
  " Any key goes back.",
];

export class TabController {
  snapshot: Snapshot | undefined;
  mode: Mode = { kind: "list" };
  message: string | undefined;
  selected = 0;
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
    const again = this.selectable(100).findIndex((row) => (before.strand ? row.strand?.id === before.strand.id : !row.strand && row.braid?.id === before.braid?.id));
    if (again >= 0) this.selected = again;
    this.selected = Math.min(this.selected, Math.max(0, this.selectable(100).length - 1));
  }

  current(): Row | undefined {
    return this.selectable(100)[this.selected];
  }

  async key(key: Key): Promise<"quit" | undefined> {
    this.message = undefined;
    const mode = this.mode;
    if (mode.kind === "help") {
      this.mode = { kind: "list" };
      return undefined;
    }
    if (mode.kind === "text") return this.textKey(mode, key);
    if (mode.kind === "snooze") {
      this.mode = { kind: "list" };
      const choice = snoozeChoices.find((candidate) => candidate.key === key.name);
      const strand = this.current()?.strand;
      if (choice && strand) {
        const until = choice.until(this.now());
        await this.run(() => this.actions.snooze(strand.id, until), `Snoozed till ${clock(until)}`);
      }
      return undefined;
    }
    if (mode.kind === "forget") {
      this.mode = { kind: "list" };
      const strand = this.current()?.strand;
      if (key.name === "y" && strand) await this.run(() => this.actions.forget(strand.id), `Forgot ${strand.label}`);
      return undefined;
    }
    const count = this.selectable(100).length;
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
        const row = this.current();
        const strand = row?.strand ?? row?.braid?.strands[0];
        if (!strand) this.message = "Nothing to go to here";
        else await this.run(() => this.actions.go(strand, row?.braid?.dir));
        return undefined;
      }
      case "o": {
        const doing = this.current()?.strand?.doing;
        if (!doing?.page) this.message = "This strand's status points at no page";
        else await this.run(() => this.actions.showPage(doing.page!), `Showing ${doing.page} in quoll`);
        return undefined;
      }
      case "z":
        if (this.current()?.strand) this.mode = { kind: "snooze" };
        else this.message = "Pick a strand to snooze";
        return undefined;
      case "x":
        if (this.current()?.strand) this.mode = { kind: "forget" };
        else this.message = "Pick a strand to forget";
        return undefined;
      case "n":
        if (this.current()?.braid) this.mode = { kind: "text", purpose: "note", text: "" };
        return undefined;
      case "p": {
        const braid = this.current()?.braid;
        if (!braid?.dir) this.message = "ponpoko doesn't know this braid's directory";
        else this.mode = { kind: "text", purpose: "point", text: "" };
        return undefined;
      }
      case "c": {
        const braid = this.current()?.braid;
        if (braid) await this.run(() => this.actions.seen(braid.id), `${braid.name} caught up`);
        return undefined;
      }
    }
    return undefined;
  }

  view(width: number, height: number): string[] {
    if (this.mode.kind === "help") return help;
    if (this.down || !this.snapshot) return [" ◆ ponpoko", "", style.red(" ponpoko ✗  the service isn't running. Start it with `systemctl --user start ponpoko`."), "", " q quit"];
    const all = rows(this.snapshot, width);
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
    if (mode.kind === "forget") return [style.amber(` forget ${this.current()?.strand?.label}?  y yes   any other key no`)];
    if (mode.kind === "text") return [style.amber(` ${mode.purpose === "note" ? "note" : "point this braid's directory at braid"}: ${mode.text}▏`)];
    return [this.message ? style.amber(` ${this.message}`) : style.dim(keysLine)];
  }

  private async textKey(mode: Extract<Mode, { kind: "text" }>, key: Key): Promise<undefined> {
    if (key.name === "escape" || key.name === "ctrl+c") this.mode = { kind: "list" };
    else if (key.name === "backspace") mode.text = mode.text.slice(0, -1);
    else if (key.name === "return") {
      this.mode = { kind: "list" };
      const braid = this.current()?.braid;
      const text = mode.text.trim();
      if (!braid || text === "") return undefined;
      if (mode.purpose === "note") await this.run(() => this.actions.note(braid.id, text), "Note added");
      else await this.run(() => this.actions.point(braid.dir!, text.toLowerCase()), `${braid.dir} now belongs to ${text}`);
    } else if (key.text) mode.text += key.text;
    return undefined;
  }

  private async run(action: () => Promise<unknown>, done?: string): Promise<void> {
    try {
      await action();
      this.message = done;
    } catch (error) {
      this.message = (error as Error).message;
    }
  }

  private selectable(width: number): Row[] {
    return this.snapshot ? rows(this.snapshot, width).filter(isSelectable) : [];
  }
}

function isSelectable(row: Row): boolean {
  return row.strand !== undefined || (row.braid !== undefined && row.tone === "heading");
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
