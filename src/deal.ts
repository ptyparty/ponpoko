import { draftsOf, openableLink, pickup, pickupChoice, pickupLine, readyChoice, readyLine, serviceActions, snoozeChoices, snoozeLine, timeLine, type Actions } from "./actions.ts";
import { state } from "./client.ts";
import { aboveOf, underOf, type Snapshot, type StrandView } from "./core.ts";
import { isPooled, mentionLink, mentionsId, ownPrs, reviewsId } from "./inbox.ts";
import { goPlace, goTarget, openTab, pickupOffer, reviewLayout, reviewOf, startsAt, tabOf, tabStrands } from "./komux/go.ts";
import { komuxTabHandle } from "./komux/translate.ts";
import { blockersOf, fit, headline, wrap, moveKind, onOwnJob, snoozedLabel, standingOf, waitingOn, whyOf, type MoveKind } from "./render.ts";
import { cells, keyLine, openScreen, style, visible, type Key, type Part } from "./screen.ts";
import { parseWhen } from "./when.ts";

type Mode = "card" | "pickup" | "snooze" | "time" | "forget" | "ready" | Purpose;
type Purpose = "add" | "note" | "move" | "rename" | "title" | "wait";
export type TabRef = { server: string; tabId: number };

const prompts: Record<Purpose, string> = {
  add: "new strand under it",
  note: "note",
  move: "move under (empty for the top)",
  rename: "rename to",
  title: "title (empty to clear)",
  wait: "waits on (empty to stop waiting)",
};
const purposeKeys: Record<string, Purpose> = { a: "add", n: "note", m: "move", r: "rename", t: "title", w: "wait" };

type Section = { title: string; side: "mine" | "others"; strands: StrandView[]; counted: boolean };
type FoldKey = "blocked" | "quiet" | "snoozed";
type Fold = { key: FoldKey; title: string; strands: StrandView[] };
type Item = { strand: StrandView; fold?: undefined } | { fold: Fold; strand?: undefined };

const groups: { kind: MoveKind; title: string }[] = [
  { kind: "claimed", title: "in progress: you took it on" },
  { kind: "asking", title: "Claude asks you" },
  { kind: "replied", title: "Claude replied: go read it" },
  { kind: "review", title: "review" },
  { kind: "pickup", title: "pick up" },
];

export class Dealer {
  private snapshot: Snapshot | undefined;
  private sections: Section[] = [];
  private folds: Fold[] = [];
  private readonly opened = new Set<FoldKey>();
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
    const before = this.item();
    const beforeKey = before?.strand?.id ?? before?.fold?.key;
    const beforeMine = this.selected < this.mine().length;
    this.snapshot = snapshot;
    this.sections = [];
    this.folds = [];
    if (!snapshot) return;
    if (this.tab) {
      this.sections = [{ title: this.tabLabel(), side: "mine", strands: tabStrands(snapshot.strands, this.tab.server, this.tab.tabId), counted: true }];
    } else {
      const newest = (a: StrandView, b: StrandView) => b.own.since - a.own.since;
      const wanted = this.unseen ? new Set(snapshot.unseen) : undefined;
      const moves = snapshot.moves.filter((strand) => !wanted || wanted.has(strand.id));
      for (const group of groups) {
        const strands = moves.filter((strand) => moveKind(strand) === group.kind).sort(newest);
        if (strands.length > 0) this.sections.push({ title: group.title, side: "mine", strands, counted: false });
      }
      if (!this.unseen) this.dealOthers(snapshot, newest);
    }
    const items = this.items();
    const matches = (item: Item) => (item.strand?.id ?? item.fold?.key) === beforeKey;
    const sameSide = beforeMine ? this.mine().findIndex(matches) : this.theirs().findIndex(matches);
    const again = sameSide >= 0 ? sameSide + (beforeMine ? 0 : this.mine().length) : items.findIndex(matches);
    this.selected = again >= 0 ? again : Math.min(this.selected, Math.max(0, items.length - 1));
  }

  private dealOthers(snapshot: Snapshot, newest: (a: StrandView, b: StrandView) => number): void {
    const listed = snapshot.strands.filter((strand) => !isPooled(strand) && !strand.planned && strand.id !== reviewsId && strand.id !== mentionsId);
    const asleep = (strand: StrandView) => (strand.snoozedUntil ?? 0) > snapshot.now;
    const awake = listed.filter((strand) => !asleep(strand) && strand.own.whose !== "you");
    const agents = [...awake.filter((strand) => strand.own.whose === "agent" || onOwnJob(strand)), ...listed.filter((strand) => !asleep(strand) && strand.own.whose === "you").flatMap((strand) => agentSide(strand) ?? [])];
    const waiting = awake.filter((strand) => (strand.own.whose === "person" || strand.own.whose === "machine") && !agents.includes(strand));
    const outForReview = waiting.filter((strand) => ownPrs(strand).some((pr) => pr.state === "waiting"));
    const byWhom = new Map<string, StrandView[]>();
    for (const strand of waiting.filter((candidate) => !outForReview.includes(candidate))) {
      const who = waitingOn(strand) ?? "others";
      byWhom.set(who, [...(byWhom.get(who) ?? []), strand]);
    }
    const others = [...byWhom].sort(([a], [b]) => a.localeCompare(b)).map(([who, strands]) => [`waiting on ${who}`, strands] as const);
    for (const [title, strands] of [["agents", agents], ["your PRs out for review", outForReview], ...others] as const) {
      if (strands.length > 0) this.sections.push({ title, side: "others", strands: [...strands].sort(newest), counted: true });
    }
    const blocked = awake.filter((strand) => strand.own.whose === undefined && !strand.own.quiet).sort(newest);
    const quiet = awake.filter((strand) => strand.own.whose === undefined && strand.own.quiet).sort(newest);
    const sleeping = listed.filter(asleep).sort((a, b) => a.snoozedUntil! - b.snoozedUntil!);
    if (blocked.length > 0) this.folds.push({ key: "blocked", title: "waiting on other strands", strands: blocked });
    if (quiet.length > 0) this.folds.push({ key: "quiet", title: "nothing asked", strands: quiet });
    if (sleeping.length > 0) this.folds.push({ key: "snoozed", title: "snoozed", strands: sleeping });
  }

  private mine(): Item[] {
    return this.sections.filter((section) => section.side === "mine").flatMap((section) => section.strands.map((strand) => ({ strand })));
  }

  private theirs(): Item[] {
    return [
      ...this.sections.filter((section) => section.side === "others").flatMap((section) => section.strands.map((strand) => ({ strand }))),
      ...this.folds.flatMap((fold): Item[] => [{ fold }, ...(this.opened.has(fold.key) ? fold.strands.map((strand) => ({ strand })) : [])]),
    ];
  }

  private items(): Item[] {
    return [...this.mine(), ...this.theirs()];
  }

  private item(): Item | undefined {
    return this.items()[this.selected];
  }

  private strands(): StrandView[] {
    return this.snapshot?.strands ?? [];
  }

  card(): StrandView | undefined {
    return this.item()?.strand;
  }

  async key(key: Key): Promise<"close" | undefined> {
    this.message = undefined;
    const card = this.card();
    const fold = this.item()?.fold;
    if (this.mode === "time") return this.timeKey(key);
    if (this.mode in prompts) return this.textKey(this.mode as Purpose, key);
    if (this.mode === "snooze") {
      this.mode = key.name === "t" ? "time" : "card";
      this.typed = "";
      const choice = snoozeChoices.find((candidate) => candidate.key === key.name);
      const until = choice?.until(this.now());
      if (until !== undefined && card) await this.act(() => this.actions.snooze(card.id, until), `Snoozed ${snoozedLabel({ snoozedUntil: until }, this.now())}`);
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
    if (this.mode === "ready") {
      this.mode = "card";
      const pr = card ? readyChoice(draftsOf(card), key.name) : undefined;
      if (pr && card) await this.act(() => this.actions.ready(card, pr.url), (said) => String(said));
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
      case "space":
      case " ":
        if (fold) this.toggle(fold);
        return undefined;
      case "return":
        if (fold) {
          this.toggle(fold);
          return undefined;
        }
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
      case "j":
      case "down": {
        const count = this.mine().length;
        const last = this.wide && this.selected < count ? count - 1 : this.items().length - 1;
        this.selected = Math.min(this.selected + 1, Math.max(0, last));
        return undefined;
      }
      case "k":
      case "up": {
        const count = this.mine().length;
        const first = this.wide && this.selected >= count ? count : 0;
        this.selected = Math.max(this.selected - 1, first);
        return undefined;
      }
      case "tab":
        this.side(this.selected < this.mine().length ? "others" : "mine");
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
      case "t":
      case "w":
        if (card) {
          this.mode = purposeKeys[key.name]!;
          this.typed = this.mode === "rename" ? card.name : this.mode === "title" ? (card.title ?? "") : "";
        }
        return undefined;
      case "x":
        if (card) this.mode = "forget";
        return undefined;
      case "d":
        if (card) await this.act(() => this.actions.done(card.id), `${card.name} is done`);
        return undefined;
      case "o": {
        const link = card ? openableLink(card) : undefined;
        if (!link) this.message = "Nothing on this strand links anywhere";
        else await this.act(() => this.actions.open(link), `Opened ${link.label ?? link.ref}`);
        return undefined;
      }
      case "R": {
        const drafts = card ? draftsOf(card) : [];
        if (!card || drafts.length === 0) this.message = "This strand has no draft pull request to mark ready";
        else if (drafts.length === 1) await this.act(() => this.actions.ready(card, drafts[0]!.url), (said) => String(said));
        else this.mode = "ready";
        return undefined;
      }
    }
    const numbered = this.items().flatMap((item, at) => (item.strand ? [at] : []));
    if (/^[1-9]$/.test(key.name) && Number(key.name) <= numbered.length) this.selected = numbered[Number(key.name) - 1]!;
    return undefined;
  }

  private toggle(fold: Fold): void {
    if (!this.opened.delete(fold.key)) this.opened.add(fold.key);
    this.selected = this.items().findIndex((item) => item.fold?.key === fold.key);
  }

  private under(strand: StrandView): StrandView[] {
    return this.tab ? [] : underOf(this.strands(), strand);
  }

  private tabLabel(): string {
    const handle = this.tab ? komuxTabHandle(this.tab.server, this.tab.tabId) : undefined;
    return this.strands().flatMap((strand) => strand.spaces).find((space) => space.handle === handle)?.label ?? "this tab";
  }

  private side(to: "mine" | "others"): void {
    const mine = this.mine().length;
    const count = this.items().length - mine;
    if (to === "others" && count === 0) return;
    if (to === "mine" && mine === 0) return;
    if (this.selected < mine) this.sideAt.mine = this.selected;
    else this.sideAt.others = this.selected - mine;
    this.selected = to === "mine" ? Math.min(this.sideAt.mine, mine - 1) : mine + Math.min(this.sideAt.others, count - 1);
  }

  private async textKey(purpose: Purpose, key: Key): Promise<undefined> {
    const card = this.card();
    if (key.name === "escape" || key.name === "ctrl+c") this.mode = "card";
    else if (key.name === "backspace") this.typed = this.typed.slice(0, -1);
    else if (key.name === "return") {
      this.mode = "card";
      const text = this.typed.trim();
      if (!card || (text === "" && purpose !== "move" && purpose !== "wait" && purpose !== "title")) return undefined;
      if (purpose === "add") await this.act(() => this.actions.add(card.id, text), `Added ${text} under ${card.name}`);
      else if (purpose === "note") await this.act(() => this.actions.note(card.id, text), "Note added");
      else if (purpose === "move") await this.act(() => this.actions.reparent(card.id, text), text === "" ? `${card.name} is at the top` : `${card.name} is under ${text}`);
      else if (purpose === "wait") await this.act(() => (text === "" ? this.actions.unblock(card.id) : this.actions.block(card.id, text)), text === "" ? `${card.name} no longer waits on other strands` : `${card.name} waits on ${text}`);
      else if (purpose === "title") await this.act(() => this.actions.title(card.id, text), text === "" ? `${card.name} has no title` : `Titled ${text}`);
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
        if (card) await this.act(() => this.actions.snooze(card.id, until), `Snoozed ${snoozedLabel({ snoozedUntil: until }, this.now())}`);
      }
    } else if (key.text) this.typed += key.text;
    return undefined;
  }

  view(width = 80, height = 40): string[] {
    const closing = keyLine([["esc", "close"]]);
    if (!this.snapshot) return ["", style.red(" ponpoko ✗  the service isn't running"), "", closing];
    const item = this.item();
    const card = item?.strand;
    if (!item && this.tab) return ["", style.text(style.bold(` ${this.tabLabel()}`)), "", style.muted(" ponpoko knows of no strand in this tab; ask its Claude to call ponpoko's status, or label the tab"), "", closing];
    if (!item) {
      return ["", style.text(style.bold(` ${this.unseen ? "✓ caught up" : "✓ clear"}`)), "", style.muted(this.unseen ? " nothing new is yours since you last caught up" : " nothing is going on"), "", closing];
    }
    const now = this.snapshot.now;
    const mineCount = this.mine().length;
    this.wide = width >= 130 && this.items().length > mineCount;
    const column = this.wide ? Math.floor((width - 3) / 2) : width;
    const heading = (title: string, count: number | undefined, paint: (text: string) => string = style.muted) => cells([[` ${title}`, paint], [count === undefined ? "" : ` ${count}`, style.muted]], column);
    const ids = new Set(this.mine().map((entry) => entry.strand!.id));
    const indent = (strand: StrandView) => (this.tab ? "  ".repeat(aboveOf(this.strands(), strand).filter((above) => ids.has(above.id)).length) : "");
    let index = 0;
    let number = 0;
    const row = (into: Listed[], strand: StrandView) => {
      const at = index++;
      const shown = ++number;
      const line = this.tab ? treeRow(strand, at === this.selected, shown, indent(strand), column, now) : deckRow(strand, at === this.selected, shown, column, now);
      into.push({ rows: [at], line });
    };
    const mine: Listed[] = [];
    if (this.unseen) mine.push({ line: heading("since you last caught up", mineCount, style.faint) }, { line: "" });
    for (const section of this.sections.filter((entry) => entry.side === "mine")) {
      if (mine.length > 0 && !this.unseen) mine.push({ line: "" });
      mine.push({ line: heading(section.title, section.counted ? section.strands.length : undefined, this.tab ? style.text : style.muted) });
      for (const strand of section.strands) row(mine, strand);
    }
    if (mineCount === 0) mine.push({ line: heading("your move", 0) }, { line: style.muted(cells([["  ✓ nothing is waiting on you"]], column)) });
    const theirs: Listed[] = [];
    for (const section of this.sections.filter((entry) => entry.side === "others")) {
      if (theirs.length > 0) theirs.push({ line: "" });
      theirs.push({ line: heading(section.title, section.strands.length) });
      for (const strand of section.strands) row(theirs, strand);
    }
    if (this.folds.length > 0) {
      if (theirs.length > 0) theirs.push({ line: "" });
      const foldPart = (fold: Fold, at: number): Part[] => {
        const open = this.opened.has(fold.key);
        const text = `${open ? "▾" : "▸"} ${fold.strands.length} ${fold.title}`;
        return [[at === this.selected ? "▎" : " ", style.accent], [text, (shown) => (at === this.selected ? style.selected(style.text(style.bold(shown))) : style.faint(shown))], "    "];
      };
      const closed = this.folds.every((fold) => !this.opened.has(fold.key));
      if (closed) {
        const ats = this.folds.map(() => index++);
        theirs.push({ rows: ats, line: cells(this.folds.flatMap((fold, at) => foldPart(fold, ats[at]!)), column) });
      } else {
        for (const fold of this.folds) {
          const at = index++;
          theirs.push({ rows: [at], line: cells(foldPart(fold, at), column) });
          if (this.opened.has(fold.key)) for (const strand of fold.strands) row(theirs, strand);
        }
      }
    }
    const detail = card ? this.detail(card, width, now) : this.foldDetail(item.fold!, width);
    const listRoom = Math.max(6, height - detail.length - 5);
    const list = this.wide
      ? sideBySide(scrolled(mine, this.selected, listRoom), scrolled(theirs, this.selected, listRoom), column)
      : scrolled([...mine, ...(theirs.length > 0 ? [{ line: "" }] : []), ...theirs], this.selected, listRoom);
    const footer = this.footer(card, item.fold, width);
    const body = [...list, "", ...detail];
    while (body.length < height - 3) body.push("");
    return [...body, "", this.message ? style.warn(` ${this.message}`) : ` ${style.enter("⏎")} ${style.text(style.bold(card ? this.where(card) : this.opened.has(item.fold!.key) ? "fold them away" : "show them"))}`, footer];
  }

  private where(card: StrandView): string {
    const target = goTarget(card, this.strands())?.player;
    const options = pickupOffer(card, this.strands());
    const place = goPlace(card, aboveOf(this.strands(), card));
    const open = target ? undefined : openTab(card);
    const github = mentionLink(card) ? "open the mention on GitHub" : !target && !open && reviewOf(card) && !tabOf(card) ? `open ${card.name} in ${reviewLayout()}` : undefined;
    return github ? github : target ? `go to ${target.who} in ${target.space ?? "its tab"}` : open ? `go to ${open.label}` : options?.resume ? `no one is on it; resume ${options.resume.who} or start a fresh Claude` : options?.dir ? `no one is on it; start a Claude at ${options.dir}` : place ? `open a tab at ${place.dir}` : "nowhere ponpoko knows of";
  }

  private footer(card: StrandView | undefined, fold: Fold | undefined, width: number): string {
    const ask = (text: string) => style.you(` ${text}`);
    const options = card ? pickupOffer(card, this.strands()) : undefined;
    if (this.mode === "snooze") return ask(snoozeLine());
    if (this.mode === "ready" && card) return ask(readyLine(draftsOf(card)));
    if (this.mode === "time") return ask(timeLine(this.typed, this.now()));
    if (this.mode === "forget" && card) return ask(`forget ${card.name}?  y yes   any other key no`);
    if (this.mode === "pickup" && options && this.snapshot) return ask(pickupLine(options, this.snapshot.now));
    if (this.mode in prompts) return ask(`${prompts[this.mode as Purpose]}: ${this.typed}▏   ⏎ save   esc cancel`);
    const side: [string, string][] = this.wide ? [["tab", "side"]] : [];
    if (!card || fold) return keyLine([["j k", "pick"], ...side, ["␣", "open"], ["esc", "close"]], width);
    return keyLine([["j k", "pick"], ...side, ...(startsAt(card) ? [["f", "fresh"] as [string, string]] : []), ...(openableLink(card) ? [["o", "open"] as [string, string]] : []), ...(draftsOf(card).length > 0 ? [["R", "mark ready"] as [string, string]] : []), ["d", "done"], ["z", "snooze"], ["x", "forget"], ["a", "add"], ["n", "note"], ["m", "move"], ["r", "rename"], ["t", "title"], ["w", "wait on"], ["esc", "close"]], width);
  }

  private foldDetail(fold: Fold, width: number): string[] {
    const stripe = (parts: Part[] = []) => style.raised(cells([[" ▎", style.faint], " ", ...parts], width));
    const one = fold.strands.length === 1;
    const what = fold.key === "blocked" ? `${one ? "waits" : "wait"} on other strands, or on the strands under ${one ? "it" : "them"}, with nothing of ${one ? "its" : "their"} own to do` : fold.key === "quiet" ? `${one ? "has" : "have"} nothing asked of anyone and no one on ${one ? "it" : "them"}` : one ? "is snoozed" : "are snoozed";
    return [stripe([[`${fold.strands.length} ${one ? "strand" : "strands"} ${what}`, style.text]]), stripe([[fold.strands.slice(0, 6).map((strand) => headline(strand).title).join(" · "), style.faint]])];
  }

  private detail(card: StrandView, width: number, now: number): string[] {
    const standing = standingOf(card, now);
    const stripe = (parts: Part[] = []) => style.raised(cells([[" ▎", standing.paint], " ", ...parts], width));
    const under = this.under(card);
    const tree = under.slice(0, 10).map((strand) => {
      const below = standingOf(strand, now);
      const indent = "  ".repeat(strand.depth - card.depth - 1);
      return stripe([indent, [`${below.glyph} `, below.paint], [fit(strand.name, Math.max(16, Math.floor(width * 0.3)) - indent.length), style.text], "  ", [below.text, below.paint], [below.age ? `  ·  ${below.age}` : "", style.faint]]);
    });
    const blockers = blockersOf(card, this.strands()).map((strand) => strand.name);
    const kept = card.own.whose === "you" && !standing.text.startsWith("snoozed") ? (card.unseen ? "new" : card.dismissedAt >= card.own.since ? "toast dismissed" : "seen") : "";
    return [
      stripe([[card.name, (text) => style.text(style.bold(text))], ...(card.title ? ["  ", [card.title, style.muted] as Part] : [])]),
      ...(card.above ?? []).map((above) => stripe([[`in ${above.kind && above.kind !== "loose" && above.kind !== "inbox" ? `${above.kind} ` : ""}${above.name}${above.title ? `  ${above.title}` : ""}`, style.faint]])),
      stripe(),
      stripe([[`${standing.glyph} `, standing.paint], [standing.text, standing.paint], [[standing.age, kept].filter(Boolean).map((text) => `  ·  ${text}`).join(""), style.faint]]),
      ...(blockers.length > 0 ? [stripe([[`waits on ${blockers.join(", ")}`, style.wait]])] : []),
      ...(card.notes.length > 0 ? wrap(`✎ ${card.notes.at(-1)!.text}`, width - 6).map((text) => stripe([[text, style.muted]])) : []),
      ...(under.length > 0 ? [stripe(), stripe([[`under it · ${under.length}`, style.faint]]), ...tree, ...(under.length > tree.length ? [stripe([[`+${under.length - tree.length} more`, style.faint]])] : [])] : []),
    ];
  }

  private async finish(): Promise<"close"> {
    if (this.snapshot) {
      for (const strand of this.snapshot.moves) if (this.dealt.has(strand.id) && this.unseen && strand.unseen) await this.actions.seen(strand.id).catch(() => undefined);
    }
    return "close";
  }

  private async act(action: () => Promise<unknown>, done?: string | ((result: unknown) => string)): Promise<boolean> {
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

function agentSide(strand: StrandView): StrandView | undefined {
  const latest = strand.open.filter((move) => move.player !== "you" && move.by.kind === "agent").sort((a, b) => b.from - a.from)[0];
  return latest && { ...strand, own: { ...strand.own, whose: "agent", since: latest.from, why: latest.what } };
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
    () => draw(),
    () => {
      draw();
      void reload();
    },
  );
  await reload();
  const ticker = setInterval(() => void reload(), 10_000);
  await done.promise;
  clearInterval(ticker);
  screen.close();
  return 0;
}

type Listed = { line: string; rows?: number[] };

function deckRow(strand: StrandView, picked: boolean, number: number, column: number, now: number): string {
  const standing = standingOf(strand, now);
  const asleep = (strand.snoozedUntil ?? 0) > now;
  const { title, what } = headline(strand);
  const why = whyOf(strand, now);
  const rest = Math.max(20, column - 15);
  const whyW = Math.max(12, Math.min(30, Math.floor(rest * 0.32)));
  const whatW = Math.max(8, Math.min(24, Math.floor(rest * 0.22)));
  const titleW = Math.max(8, rest - whyW - whatW);
  const line = cells(
    [
      [picked ? "▎" : " ", style.accent],
      [`${String(number).padStart(2)} `, style.faint],
      [`${standing.glyph} `, standing.paint],
      [cells([[title, (text) => (asleep ? style.faint(text) : style.text(style.bold(text)))]], titleW)],
      [what ? " · " : "   ", style.faint],
      [cells([[what, asleep ? style.faint : style.text]], whatW)],
      " ",
      [cells([[why.text, why.paint]], whyW)],
      [standing.age.padStart(4), style.faint],
      " ",
    ],
    column,
  );
  return picked ? style.selected(line) : line;
}

function treeRow(strand: StrandView, picked: boolean, number: number, indent: string, column: number, now: number): string {
  const standing = standingOf(strand, now);
  const asleep = (strand.snoozedUntil ?? 0) > now;
  const statusW = Math.max(16, Math.min(34, Math.floor(column * 0.42)));
  const name = cells(
    [[picked ? "▎" : " ", style.accent], [number <= 9 ? `${number} ` : "  ", style.faint], indent, [`${standing.glyph} `, standing.paint], [strand.name, (text) => (asleep ? style.faint(text) : style.text(picked ? style.bold(text) : text))], "  ", [strand.title ?? "", asleep ? style.faint : style.muted]],
    column - statusW - 8,
  );
  const line = name + "  " + cells([[standing.text, standing.paint]], statusW) + cells([[` ${standing.age.padStart(4)}`, style.faint]], 6);
  return picked ? style.selected(line) : line;
}

function scrolled(listed: Listed[], selected: number, room: number): string[] {
  const picked = listed.findIndex((entry) => entry.rows?.includes(selected));
  const start = picked < 0 ? 0 : Math.max(0, Math.min(picked - Math.floor(room / 2), listed.length - room));
  return listed.slice(start, start + room).map((entry) => entry.line);
}

function sideBySide(left: string[], right: string[], column: number): string[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, at) => {
    const line = left[at] ?? "";
    return `${line}${" ".repeat(Math.max(0, column - visible(line)))}${style.faint(" │ ")}${right[at] ?? ""}`;
  });
}

