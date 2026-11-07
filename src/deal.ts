import { serviceActions, snoozeChoices, snoozeLine, type Actions } from "./actions.ts";
import { state } from "./client.ts";
import type { Snapshot, StrandView } from "./core.ts";
import { age, braidTitle, clock, glyph, holder } from "./render.ts";
import { openScreen, style, type Key } from "./screen.ts";

type Mode = "card" | "snooze" | "forget";

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
    if (this.mode === "forget") {
      this.mode = "card";
      if (key.name === "y" && card) await this.act(() => this.actions.forget(card.id), `Forgot ${card.label}`);
      return undefined;
    }
    switch (key.name) {
      case "escape":
      case "q":
      case "ctrl+c":
        return this.finish();
      case "return":
        if (!card) return this.finish();
        this.dealt.add(card.id);
        if (await this.act(() => this.actions.go(card, this.snapshot?.braids.find((braid) => braid.id === card.braid)?.dir))) return this.finish();
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
    }
    return undefined;
  }

  view(): string[] {
    const hand = this.unseen ? "since you last caught up" : "your move";
    if (!this.snapshot) return ["", style.red(" ponpoko ✗  the service isn't running"), "", style.dim(" esc close")];
    const card = this.card();
    if (!card) {
      return ["", style.bold(` ${this.unseen ? "✓ caught up" : "✓ clear"}`), "", style.dim(this.unseen ? " nothing new is yours since you last caught up" : " nothing is waiting on you"), "", style.dim(" esc close")];
    }
    const braid = this.snapshot.braids.find((candidate) => candidate.id === card.braid);
    const where = card.live && card.space ? `→ ${card.space}` : card.place?.dir || braid?.dir ? `→ open a tab at ${card.place?.dir ?? braid?.dir}` : "→ nowhere ponpoko knows of";
    const lines = [
      style.dim(` ${hand} · 1 of ${this.hand.length}`),
      "",
      style.amber(style.bold(` ${glyph(card, this.snapshot.now)} ${braid ? braidTitle(braid) : card.braid}`)),
      `   ${card.label} · ${card.why}${card.who ? ` (${card.who})` : ""} · ${age(this.snapshot.now - card.since)}`,
      style.dim(`   ${holder(card, this.snapshot.now)}, since ${clock(card.since)}${card.source === "agent" ? " · reported by the agent" : ""}`),
      `   ${where}`,
      "",
    ];
    const footer =
      this.mode === "snooze" ? style.amber(` ${snoozeLine()}`) : this.mode === "forget" ? style.amber(` forget ${card.label}?  y yes   any other key no`) : style.dim(" ⏎ go   s skip   z snooze   x forget   esc close");
    if (this.message) lines.push(style.amber(` ${this.message}`));
    lines.push(footer);
    return lines;
  }

  private async finish(): Promise<"close"> {
    if (this.unseen && this.snapshot) {
      const unseen = new Set(this.snapshot.unseen);
      const braids = new Set(this.snapshot.moves.filter((strand) => this.dealt.has(strand.id)).map((strand) => strand.braid));
      for (const braid of braids) {
        const left = this.snapshot.moves.some((strand) => strand.braid === braid && unseen.has(strand.id) && !this.dealt.has(strand.id));
        if (!left) await this.actions.seen(braid).catch(() => undefined);
      }
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
  const draw = () => screen.draw(dealer.view());
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
