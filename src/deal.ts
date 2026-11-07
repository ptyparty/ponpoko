import { pickup, pickupChoice, pickupLine, serviceActions, snoozeChoices, snoozeLine, timeLine, type Actions } from "./actions.ts";
import { state } from "./client.ts";
import { aboveOf, type Snapshot, type StrandView } from "./core.ts";
import { goPlace, goTarget, pickupOffer, startsAt } from "./komux/go.ts";
import { age, cause, clock, fit, holder } from "./render.ts";
import { openScreen, style, type Key } from "./screen.ts";
import { parseWhen, whenLabel } from "./when.ts";

type Mode = "card" | "pickup" | "snooze" | "time" | "forget";

export class Dealer {
  private snapshot: Snapshot | undefined;
  private hand: StrandView[] = [];
  private others: { title: string; strands: StrandView[] }[] = [];
  private skipped: string[] = [];
  private dealt = new Set<string>();
  private selected = 0;
  private typed = "";
  mode: Mode = "card";
  message: string | undefined;

  constructor(
    private readonly actions: Actions,
    private readonly unseen: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  setSnapshot(snapshot: Snapshot | undefined): void {
    this.snapshot = snapshot;
    if (!snapshot) {
      this.hand = [];
      this.others = [];
      return;
    }
    const before = this.card()?.id;
    const wanted = this.unseen ? new Set(snapshot.unseen) : undefined;
    const moves = snapshot.moves.filter((strand) => !wanted || wanted.has(strand.id)).sort((a, b) => urgency(a) - urgency(b) || b.own.since - a.own.since);
    const fresh = moves.filter((strand) => !this.skipped.includes(strand.id));
    const back = this.skipped.flatMap((id) => moves.filter((strand) => strand.id === id));
    this.hand = [...fresh, ...back];
    const live = this.unseen ? [] : snapshot.strands;
    const asleep = (strand: StrandView) => (strand.snoozedUntil ?? 0) > snapshot.now;
    const newest = (a: StrandView, b: StrandView) => b.own.since - a.own.since;
    this.others = [
      { title: "agents", strands: live.filter((strand) => strand.own.whose === "agent" && !asleep(strand)).sort(newest) },
      { title: "waiting on others", strands: live.filter((strand) => (strand.own.whose === "person" || strand.own.whose === "machine") && !asleep(strand)).sort(newest) },
      { title: "snoozed", strands: live.filter(asleep).sort((a, b) => a.snoozedUntil! - b.snoozedUntil!) },
    ].filter((section) => section.strands.length > 0);
    const rows = this.rows();
    const again = rows.findIndex((strand) => strand.id === before);
    this.selected = again >= 0 ? again : Math.min(this.selected, Math.max(0, rows.length - 1));
  }

  private rows(): StrandView[] {
    return [...this.hand, ...this.others.flatMap((section) => section.strands)];
  }

  private strands(): StrandView[] {
    return this.snapshot?.strands ?? [];
  }

  card(): StrandView | undefined {
    return this.rows()[this.selected];
  }

  async key(key: Key): Promise<"close" | undefined> {
    this.message = undefined;
    const card = this.card();
    if (this.mode === "time") return this.timeKey(key);
    if (this.mode === "snooze") {
      this.mode = key.name === "t" ? "time" : "card";
      this.typed = "";
      const choice = snoozeChoices.find((candidate) => candidate.key === key.name);
      if (choice && card) await this.act(() => this.actions.snooze(card.id, choice.until(this.now())), `Snoozed till ${clock(choice.until(this.now()))}`);
      return undefined;
    }
    if (this.mode === "pickup") {
      this.mode = "card";
      const options = card ? pickup(card) : undefined;
      const how = options ? pickupChoice(options, key.name) : undefined;
      if (how && card && (await this.act(() => this.actions.pickUp(card, how)))) {
        this.dealt.add(card.id);
        return this.finish();
      }
      return undefined;
    }
    if (this.mode === "forget") {
      this.mode = "card";
      if (key.name === "y" && card) await this.act(() => this.actions.forget(card.id), `Forgot ${card.name}`);
      return undefined;
    }
    switch (key.name) {
      case "escape":
      case "q":
      case "ctrl+c":
        return this.finish();
      case "return":
        if (!card) return this.finish();
        if (pickupOffer(card, this.strands())) {
          this.mode = "pickup";
          return undefined;
        }
        this.dealt.add(card.id);
        if (await this.act(() => this.actions.go(card, this.strands()))) return this.finish();
        return undefined;
      case "f":
        if (!card || !startsAt(card)) return undefined;
        this.dealt.add(card.id);
        if (await this.act(() => this.actions.pickUp(card, "fresh"))) return this.finish();
        return undefined;
      case "s":
      case " ":
        if (card && this.hand.includes(card)) {
          this.dealt.add(card.id);
          this.skipped = [...this.skipped.filter((id) => id !== card.id), card.id];
          this.hand = [...this.hand.filter((strand) => strand !== card), card];
        }
        return undefined;
      case "j":
      case "down":
        this.selected = Math.min(this.selected + 1, Math.max(0, this.rows().length - 1));
        return undefined;
      case "k":
      case "up":
        this.selected = Math.max(this.selected - 1, 0);
        return undefined;
      case "z":
        if (card) this.mode = "snooze";
        return undefined;
      case "x":
        if (card) this.mode = "forget";
        return undefined;
      case "d":
        if (card) await this.act(() => this.actions.done(card.id), `${card.name} is done`);
        return undefined;
    }
    if (/^[1-9]$/.test(key.name) && Number(key.name) <= this.rows().length) this.selected = Number(key.name) - 1;
    return undefined;
  }

  private async timeKey(key: Key): Promise<undefined> {
    const card = this.card();
    if (key.name === "escape" || key.name === "ctrl+c") this.mode = "card";
    else if (key.name === "backspace") this.typed = this.typed.slice(0, -1);
    else if (key.name === "return") {
      const until = parseWhen(this.typed, this.now());
      if (until === undefined) this.message = `ponpoko can't read "${this.typed.trim()}" as a time to come`;
      else {
        this.mode = "card";
        if (card) await this.act(() => this.actions.snooze(card.id, until), `Snoozed till ${whenLabel(until, this.now())}`);
      }
    } else if (key.text) this.typed += key.text;
    return undefined;
  }

  view(width = 80, height = 40): string[] {
    const hand = this.unseen ? "since you last caught up" : "your move";
    if (!this.snapshot) return ["", style.red(" ponpoko ✗  the service isn't running"), "", style.dim(" esc close")];
    const card = this.card();
    if (!card) {
      return ["", style.bold(` ${this.unseen ? "✓ caught up" : "✓ clear"}`), "", style.dim(this.unseen ? " nothing new is yours since you last caught up" : " nothing is going on"), "", style.dim(" esc close")];
    }
    const target = goTarget(card, this.strands())?.player;
    const options = pickupOffer(card, this.strands());
    const place = goPlace(card, aboveOf(this.strands(), card));
    const where = target ? `→ ${target.who} in ${target.space ?? "its tab"}` : options?.resume ? `→ no one is on it; resume ${options.resume.who} or start a fresh Claude` : options?.dir ? `→ no one is on it; start a Claude at ${options.dir}` : place ? `→ open a tab at ${place.dir}` : "→ nowhere ponpoko knows of";
    const now = this.snapshot.now;
    const listed: { line: string; row?: number }[] = [{ line: style.dim(` ${hand} · ${this.hand.length}${this.hand.length === 0 ? "  ✓ nothing is waiting on you" : ""}`) }];
    let index = 0;
    const row = (strand: StrandView, what: string, mine: boolean) => {
      const at = index++;
      const text = fit(`${at === this.selected ? "▸" : " "} ${at < 9 ? at + 1 : " "}  ${fit(strand.name, 24)}  ${what}`, width - 2).trimEnd();
      listed.push({ row: at, line: mine && urgency(strand) === 0 ? style.amber(` ${text}`) : at === this.selected ? ` ${text}` : style.dim(` ${text}`) });
    };
    for (const strand of this.hand) row(strand, `${cause(strand)} · ${age(now - strand.own.since)}`, true);
    for (const section of this.others) {
      listed.push({ line: style.dim(` ${section.title} · ${section.strands.length}`) });
      for (const strand of section.strands) row(strand, section.title === "snoozed" ? `till ${whenLabel(strand.snoozedUntil!, now)} · ${othersCause(strand)}` : `${othersCause(strand)} · ${age(now - strand.own.since)}`, false);
    }
    const room = Math.max(6, height - 20);
    const picked = listed.findIndex((entry) => entry.row === this.selected);
    const start = Math.max(0, Math.min(picked - Math.floor(room / 2), listed.length - room));
    const lines = [
      ...listed.slice(start, start + room).map((entry) => entry.line),
      "",
      style.amber(style.bold(fit(` ● ${card.name}${card.title ? `  ${card.title}` : ""}`, width - 1).trimEnd())),
      ...(card.above ?? []).map((above) => style.dim(fit(`   in ${above.kind && above.kind !== "loose" ? `${above.kind} ` : ""}${above.name}${above.title ? `  ${above.title}` : ""}`, width - 1).trimEnd())),
      "",
      `   ${cause(card)} · ${age(this.snapshot.now - card.own.since)}`,
      style.dim(`   ${holder(card, this.snapshot.now)}, since ${clock(card.own.since)}`),
      ...(card.notes.length > 0 ? wrap(`✎ ${card.notes.at(-1)!.text}`, width - 6).map((text) => style.dim(`   ${text}`)) : []),
      `   ${where}`,
      "",
    ];
    const footer =
      this.mode === "snooze"
        ? style.amber(` ${snoozeLine()}`)
        : this.mode === "time"
          ? style.amber(` ${timeLine(this.typed, this.now())}`)
        : this.mode === "forget"
          ? style.amber(` forget ${card.name}?  y yes   any other key no`)
          : this.mode === "pickup" && options
            ? style.amber(` ${pickupLine(options, this.snapshot.now)}`)
            : style.dim(` ⏎ go  j/k pick  s skip${startsAt(card) ? "  f fresh" : ""}  d done  z snooze  x forget  esc`);
    if (this.message) lines.push(style.amber(` ${this.message}`));
    lines.push(footer);
    return lines;
  }

  private async finish(): Promise<"close"> {
    if (this.unseen && this.snapshot) {
      for (const strand of this.snapshot.moves) if (this.dealt.has(strand.id) && strand.unseen) await this.actions.seen(strand.id).catch(() => undefined);
    }
    return "close";
  }

  private async act(action: () => Promise<unknown>, done?: string): Promise<boolean> {
    try {
      await action();
      this.message = done;
      return true;
    } catch (error) {
      this.message = (error as Error).message;
      return false;
    }
  }
}

export async function runDeal(args: string[]): Promise<number> {
  const dealer = new Dealer(serviceActions, args.includes("--unseen"));
  const done = Promise.withResolvers<void>();
  const draw = () => screen.draw(dealer.view(screen.width, screen.height));
  const reload = async () => {
    dealer.setSnapshot(await state().catch(() => undefined));
    draw();
  };
  const screen = openScreen(
    (key) =>
      void dealer.key(key).then(async (outcome) => {
        if (outcome === "close") return done.resolve();
        await reload();
      }),
    draw,
  );
  await reload();
  const ticker = setInterval(() => void reload(), 10_000);
  await done.promise;
  clearInterval(ticker);
  screen.close();
  return 0;
}

function othersCause(strand: StrandView): string {
  const move = strand.open.find((candidate) => candidate.from === strand.own.since) ?? strand.open[0];
  return move && move.player !== "you" ? `${move.by.who} · ${strand.own.why}` : cause(strand);
}

function urgency(strand: StrandView): number {
  const asks = strand.open.filter((move) => move.player === "you").map((move) => move.what);
  if (asks.some((what) => what === "asking you" || what === "waiting on you")) return 0;
  return asks.length > 0 && asks.every((what) => what === "ready for a prompt") ? 2 : 1;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length > 4 ? [...lines.slice(0, 3), `${lines[3]!.slice(0, width - 1)}…`] : lines;
}
