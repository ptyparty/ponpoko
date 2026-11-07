import { pickup, pickupChoice, pickupLine, serviceActions, snoozeChoices, snoozeLine, type Actions } from "./actions.ts";
import { state } from "./client.ts";
import type { Snapshot, StrandView } from "./core.ts";
import { age, cause, clock, fit, holder } from "./render.ts";
import { openScreen, style, type Key } from "./screen.ts";

type Mode = "card" | "pickup" | "snooze" | "forget";

export class Dealer {
  private snapshot: Snapshot | undefined;
  private hand: StrandView[] = [];
  private skipped: string[] = [];
  private dealt = new Set<string>();
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
      return;
    }
    const wanted = this.unseen ? new Set(snapshot.unseen) : undefined;
    const moves = snapshot.moves.filter((strand) => !wanted || wanted.has(strand.id));
    const fresh = moves.filter((strand) => !this.skipped.includes(strand.id));
    const back = this.skipped.flatMap((id) => moves.filter((strand) => strand.id === id));
    this.hand = [...fresh, ...back];
  }

  card(): StrandView | undefined {
    return this.hand[0];
  }

  async key(key: Key): Promise<"close" | undefined> {
    this.message = undefined;
    const card = this.card();
    if (this.mode === "snooze") {
      this.mode = "card";
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
        if (pickup(card)) {
          this.mode = "pickup";
          return undefined;
        }
        this.dealt.add(card.id);
        if (await this.act(() => this.actions.go(card))) return this.finish();
        return undefined;
      case "s":
      case " ":
        if (card) {
          this.dealt.add(card.id);
          this.skipped = [...this.skipped.filter((id) => id !== card.id), card.id];
          this.hand = [...this.hand.slice(1), card];
        }
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
    return undefined;
  }

  view(width = 80): string[] {
    const hand = this.unseen ? "since you last caught up" : "your move";
    if (!this.snapshot) return ["", style.red(" ponpoko ✗  the service isn't running"), "", style.dim(" esc close")];
    const card = this.card();
    if (!card) {
      return ["", style.bold(` ${this.unseen ? "✓ caught up" : "✓ clear"}`), "", style.dim(this.unseen ? " nothing new is yours since you last caught up" : " nothing is waiting on you"), "", style.dim(" esc close")];
    }
    const target = card.open.map((move) => move.answers ?? move.by).find((player) => player.live && player.space);
    const options = pickup(card);
    const where = target ? `→ ${target.space}` : options?.resume ? `→ no one is on it; resume ${options.resume.who} or start a fresh Claude` : options?.dir ? `→ no one is on it; start a Claude at ${options.dir}` : card.dir ? `→ open a tab at ${card.dir}` : "→ nowhere ponpoko knows of";
    const lines = [
      style.dim(` ${hand} · 1 of ${this.hand.length}`),
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
        : this.mode === "forget"
          ? style.amber(` forget ${card.name}?  y yes   any other key no`)
          : this.mode === "pickup" && options
            ? style.amber(` ${pickupLine(options, this.snapshot.now)}`)
            : style.dim(" ⏎ go   s skip   d done   z snooze   x forget   esc close");
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
  const draw = () => screen.draw(dealer.view(screen.width));
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
