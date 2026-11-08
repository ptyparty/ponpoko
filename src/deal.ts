import { pickup, pickupChoice, pickupLine, serviceActions, snoozeChoices, snoozeLine, timeLine, type Actions } from "./actions.ts";
import { state } from "./client.ts";
import { aboveOf, underOf, type Snapshot, type StrandView } from "./core.ts";
import { goPlace, goTarget, openTab, pickupOffer, startsAt, tabStrands } from "./komux/go.ts";
import { komuxTabHandle } from "./komux/translate.ts";
import { age, cause, clock, fit, holder, snoozedLabel, strandGlyph } from "./render.ts";
import { openScreen, style, type Key } from "./screen.ts";
import { parseWhen, whenLabel } from "./when.ts";

type Mode = "card" | "pickup" | "snooze" | "time" | "forget" | Purpose;
type Purpose = "add" | "note" | "move" | "rename";
export type TabRef = { server: string; tabId: number };

const prompts: Record<Purpose, string> = {
  add: "new strand under it",
  note: "note",
  move: "move under (empty for the top)",
  rename: "rename to",
};
const purposeKeys: Record<string, Purpose> = { a: "add", n: "note", m: "move", r: "rename" };

export class Dealer {
  private snapshot: Snapshot | undefined;
  private hand: StrandView[] = [];
  private others: { title: string; strands: StrandView[] }[] = [];
  private skipped: string[] = [];
  private dealt = new Set<string>();
  private selected = 0;
  private wide = false;
  private sideAt = { mine: 0, others: 0 };
  private typed = "";
  mode: Mode = "card";
  message: string | undefined;

  constructor(
    private readonly actions: Actions,
    private readonly unseen: boolean,
    private readonly now: () => number = Date.now,
    private readonly tab?: TabRef,
  ) {}

  setSnapshot(snapshot: Snapshot | undefined): void {
    this.snapshot = snapshot;
    if (!snapshot) {
      this.hand = [];
      this.others = [];
      return;
    }
    const before = this.card()?.id;
    if (this.tab) {
      this.hand = tabStrands(snapshot.strands, this.tab.server, this.tab.tabId);
      this.others = [];
      const again = this.hand.findIndex((strand) => strand.id === before);
      this.selected = again >= 0 ? again : Math.min(this.selected, Math.max(0, this.hand.length - 1));
      return;
    }
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
      { title: "waiting on other strands", strands: live.filter((strand) => strand.own.whose === undefined && !asleep(strand)).sort(newest) },
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
    if (this.mode in prompts) return this.textKey(this.mode as Purpose, key);
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
        if (card && !this.tab && this.hand.includes(card)) {
          this.dealt.add(card.id);
          this.skipped = [...this.skipped.filter((id) => id !== card.id), card.id];
          this.hand = [...this.hand.filter((strand) => strand !== card), card];
        }
        return undefined;
      case "j":
      case "down": {
        const last = this.wide && this.selected < this.hand.length ? this.hand.length - 1 : this.rows().length - 1;
        this.selected = Math.min(this.selected + 1, Math.max(0, last));
        return undefined;
      }
      case "k":
      case "up": {
        const first = this.wide && this.selected >= this.hand.length ? this.hand.length : 0;
        this.selected = Math.max(this.selected - 1, first);
        return undefined;
      }
      case "tab":
        this.side(this.selected < this.hand.length ? "others" : "mine");
        return undefined;
      case "l":
      case "right":
        this.side("others");
        return undefined;
      case "h":
      case "left":
        this.side("mine");
        return undefined;
      case "z":
        if (card) this.mode = "snooze";
        return undefined;
      case "a":
      case "n":
      case "m":
      case "r":
        if (card) {
          this.mode = purposeKeys[key.name]!;
          this.typed = this.mode === "rename" ? card.name : "";
        }
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

  private under(strand: StrandView): StrandView[] {
    return this.tab ? [] : underOf(this.strands(), strand);
  }

  private tabLabel(): string {
    const handle = this.tab ? komuxTabHandle(this.tab.server, this.tab.tabId) : undefined;
    return this.strands().flatMap((strand) => strand.spaces).find((space) => space.handle === handle)?.label ?? "this tab";
  }

  private side(to: "mine" | "others"): void {
    const count = this.rows().length - this.hand.length;
    if (to === "others" && count === 0) return;
    if (to === "mine" && this.hand.length === 0) return;
    if (this.selected < this.hand.length) this.sideAt.mine = this.selected;
    else this.sideAt.others = this.selected - this.hand.length;
    this.selected = to === "mine" ? Math.min(this.sideAt.mine, this.hand.length - 1) : this.hand.length + Math.min(this.sideAt.others, count - 1);
  }

  private async textKey(purpose: Purpose, key: Key): Promise<undefined> {
    const card = this.card();
    if (key.name === "escape" || key.name === "ctrl+c") this.mode = "card";
    else if (key.name === "backspace") this.typed = this.typed.slice(0, -1);
    else if (key.name === "return") {
      this.mode = "card";
      const text = this.typed.trim();
      if (!card || (text === "" && purpose !== "move")) return undefined;
      if (purpose === "add") await this.act(() => this.actions.add(card.id, text), `Added ${text} under ${card.name}`);
      else if (purpose === "note") await this.act(() => this.actions.note(card.id, text), "Note added");
      else if (purpose === "move") await this.act(() => this.actions.reparent(card.id, text), text === "" ? `${card.name} is at the top` : `${card.name} is under ${text}`);
      else await this.act(() => this.actions.rename(card.id, text), `Renamed to ${text}`);
    } else if (key.text) this.typed += key.text;
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
    const hand = this.tab ? this.tabLabel() : this.unseen ? "since you last caught up" : "your move";
    if (!this.snapshot) return ["", style.red(" ponpoko ✗  the service isn't running"), "", style.dim(" esc close")];
    const card = this.card();
    if (!card && this.tab) return ["", style.bold(` ${hand}`), "", style.dim(" ponpoko knows of no strand in this tab; ask its Claude to call ponpoko's status, or label the tab"), "", style.dim(" esc close")];
    if (!card) {
      return ["", style.bold(` ${this.unseen ? "✓ caught up" : "✓ clear"}`), "", style.dim(this.unseen ? " nothing new is yours since you last caught up" : " nothing is going on"), "", style.dim(" esc close")];
    }
    const target = goTarget(card, this.strands())?.player;
    const options = pickupOffer(card, this.strands());
    const place = goPlace(card, aboveOf(this.strands(), card));
    const open = target ? undefined : openTab(card);
    const where = target ? `→ ${target.who} in ${target.space ?? "its tab"}` : open ? `→ ${open.label}` : options?.resume ? `→ no one is on it; resume ${options.resume.who} or start a fresh Claude` : options?.dir ? `→ no one is on it; start a Claude at ${options.dir}` : place ? `→ open a tab at ${place.dir}` : "→ nowhere ponpoko knows of";
    const now = this.snapshot.now;
    this.wide = width >= 100 && this.others.length > 0;
    const column = this.wide ? Math.floor((width - 3) / 2) : width;
    const mine: Listed[] = [{ line: style.dim(` ${hand} · ${this.hand.length}${this.hand.length === 0 ? "  ✓ nothing is waiting on you" : ""}`) }];
    const ids = new Set(this.hand.map((strand) => strand.id));
    const indent = (strand: StrandView) => (this.tab ? "  ".repeat(aboveOf(this.strands(), strand).filter((above) => ids.has(above.id)).length) : "");
    const theirs: Listed[] = [];
    let index = 0;
    const row = (into: Listed[], strand: StrandView, what: string, yours: boolean) => {
      const at = index++;
      const label = strand.title ? `${strand.name}  ${strand.title}` : strand.name;
      const nested = indent(strand);
      const text = fit(`${at === this.selected ? "▸" : " "} ${at < 9 ? at + 1 : " "}  ${nested}${fit(label, Math.max(24, Math.floor(column * 0.5)) - nested.length)}  ${what}`, column - 2).trimEnd();
      into.push({ row: at, line: yours && urgency(strand) === 0 ? style.amber(` ${text}`) : at === this.selected ? ` ${text}` : style.dim(` ${text}`) });
    };
    for (const strand of this.hand) row(mine, strand, this.tab ? standing(strand, now) : `${cause(strand)} · ${age(now - strand.own.since)}`, true);
    for (const section of this.others) {
      theirs.push({ line: style.dim(` ${section.title} · ${section.strands.length}`) });
      for (const strand of section.strands) row(theirs, strand, section.title === "snoozed" ? [snoozedLabel(strand, now), othersCause(strand)].filter(Boolean).join(" · ") : `${othersCause(strand)} · ${age(now - strand.own.since)}`, false);
    }
    const under = this.under(card);
    const tree = under.slice(0, 12).map((strand) => {
      const label = strand.title ? `${strand.name}  ${strand.title}` : strand.name;
      const state = standing(strand, now);
      const indent = "  ".repeat(strand.depth - card.depth - 1);
      const text = fit(`   ${indent}${strandGlyph(strand, now)} ${fit(label, Math.max(24, Math.floor(width * 0.4)) - indent.length)}  ${state}`, width - 1).trimEnd();
      return strand.own.whose === "you" ? text : style.dim(text);
    });
    const detail = [
      style.amber(style.bold(fit(` ● ${card.name}${card.title ? `  ${card.title}` : ""}`, width - 1).trimEnd())),
      ...(card.above ?? []).map((above) => style.dim(fit(`   in ${above.kind && above.kind !== "loose" ? `${above.kind} ` : ""}${above.name}${above.title ? `  ${above.title}` : ""}`, width - 1).trimEnd())),
      "",
      `   ${cause(card)} · ${age(this.snapshot.now - card.own.since)}`,
      style.dim(`   ${holder(card, this.snapshot.now)}, since ${clock(card.own.since)}`),
      ...(card.notes.length > 0 ? wrap(`✎ ${card.notes.at(-1)!.text}`, width - 6).map((text) => style.dim(`   ${text}`)) : []),
      `   ${where}`,
      ...(under.length > 0 ? ["", style.dim(`   under it · ${under.length}`), ...tree, ...(under.length > tree.length ? [style.dim(`   +${under.length - tree.length} more`)] : [])] : []),
      "",
    ];
    const room = Math.max(6, height - detail.length - 3);
    const list = this.wide
      ? sideBySide(scrolled(mine, this.selected, room), scrolled(theirs, this.selected, room), column)
      : scrolled([...mine, ...theirs], this.selected, room);
    const lines = [...list, ...(this.wide ? [style.dim(` ${"─".repeat(Math.max(0, width - 2))}`)] : [""]), ...detail];
    const footer =
      this.mode === "snooze"
        ? style.amber(` ${snoozeLine()}`)
        : this.mode === "time"
          ? style.amber(` ${timeLine(this.typed, this.now())}`)
        : this.mode === "forget"
          ? style.amber(` forget ${card.name}?  y yes   any other key no`)
          : this.mode === "pickup" && options
            ? style.amber(` ${pickupLine(options, this.snapshot.now)}`)
            : this.mode in prompts
              ? style.amber(` ${prompts[this.mode as Purpose]}: ${this.typed}▏   ⏎ save   esc cancel`)
              : style.dim(` ⏎ go  j/k pick${this.wide ? "  tab side" : ""}${this.tab ? "" : "  s skip"}${startsAt(card) ? "  f fresh" : ""}  d done  z snooze  x forget  a add  n note  m move  r rename  esc`);
    if (this.message) lines.push(style.amber(` ${this.message}`));
    lines.push(footer);
    return lines;
  }

  private async finish(): Promise<"close"> {
    if (this.snapshot) {
      for (const strand of this.snapshot.moves) if (this.dealt.has(strand.id) && ((this.unseen && strand.unseen) || strand.own.finished)) await this.actions.seen(strand.id).catch(() => undefined);
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

function tabFrom(env: Record<string, string | undefined>): TabRef | undefined {
  const tabId = Number(env.KOMUX_TAB_ID);
  return env.KOMUX_SERVER_ID && env.KOMUX_TAB_ID && Number.isInteger(tabId) ? { server: env.KOMUX_SERVER_ID, tabId } : undefined;
}

export async function runDeal(args: string[]): Promise<number> {
  const tab = args.includes("--tab") ? tabFrom(process.env) : undefined;
  if (args.includes("--tab") && !tab) {
    console.error("ponpoko deal --tab runs in a komux popup, which gives it KOMUX_SERVER_ID and KOMUX_TAB_ID");
    return 2;
  }
  const dealer = new Dealer(serviceActions, args.includes("--unseen"), Date.now, tab);
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

type Listed = { line: string; row?: number };

function scrolled(listed: Listed[], selected: number, room: number): string[] {
  const picked = listed.findIndex((entry) => entry.row === selected);
  const start = picked < 0 ? 0 : Math.max(0, Math.min(picked - Math.floor(room / 2), listed.length - room));
  return listed.slice(start, start + room).map((entry) => entry.line);
}

function sideBySide(left: string[], right: string[], column: number): string[] {
  const visible = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").length;
  return Array.from({ length: Math.max(left.length, right.length) }, (_, at) => {
    const line = left[at] ?? "";
    return `${line}${" ".repeat(Math.max(0, column - visible(line)))}${style.dim(" │")}${right[at] ?? ""}`;
  });
}

function standing(strand: StrandView, now: number): string {
  if ((strand.snoozedUntil ?? 0) > now) return snoozedLabel(strand, now);
  return strand.own.whose || strand.own.waitsOn ? `${othersCause(strand)} · ${age(now - strand.own.since)}` : "";
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
