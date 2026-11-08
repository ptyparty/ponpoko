import { slug, type Knowledge } from "./core.ts";
import type { Fact } from "./events.ts";
import { pendingMentions, prName, reviewState, type Inbox } from "./github.ts";
import { isBookkeeping, you } from "./model.ts";

export const source = "github";
export const githubPlayer = "github";
export const reviewsId = "github:reviews";
export const mentionsId = "github:mentions";
export const prAdapter = "github";
export const stateAdapter = "github-state";

type Desired = { player: string; who?: string; what: string; with?: { id: string; who: string }; link?: { ref: string; label: string } };
type Want = { id: string; parent: string; kind: "review" | "mention"; name: string; title: string; url: string; key: string; wanted: boolean; desired?: Desired; done?: string };

const tops = {
  [reviewsId]: { name: "reviews", title: "Pull requests waiting for a review" },
  [mentionsId]: { name: "mentions", title: "Mentions on GitHub you haven't answered" },
};

export function reviewId(pr: { repo: string; number: number }): string {
  return `github:review:${pr.repo}#${pr.number}`;
}

export function mentionId(pr: { repo: string; number: number }): string {
  return `github:mention:${pr.repo}#${pr.number}`;
}

export function personId(login: string): string {
  return `person:${slug(login)}`;
}

export { isBookkeeping };

export function inboxFacts(knowledge: Knowledge, inbox: Inbox, newId: (prefix: string) => string): Fact[] {
  return new Reconciler(knowledge, newId, inbox.complete ?? { reviews: true, mentioned: true }).run([...reviewWants(inbox), ...mentionWants(inbox)]);
}

function reviewWants(inbox: Inbox): Want[] {
  return inbox.reviews.map((pr) => {
    const state = reviewState(pr, inbox.me);
    const base = { id: reviewId(pr), parent: reviewsId, kind: "review" as const, name: prName(pr.repo, pr.number), title: pr.title, url: pr.url, key: `${state.kind}:${pr.head ?? ""}:${state.why}`, wanted: state.kind === "yours" };
    switch (state.kind) {
      case "gone":
        return { ...base, done: state.why };
      case "pool":
        return { ...base, desired: { player: githubPlayer, who: "GitHub", what: state.why } };
      case "yours":
        return { ...base, desired: { player: you, what: state.why } };
      case "author":
        return { ...base, desired: { player: personId(state.author), who: state.author, what: state.why } };
    }
  });
}

function mentionWants(inbox: Inbox): Want[] {
  return inbox.mentioned.map((pr) => {
    const pending = pendingMentions(pr, inbox.me);
    const latest = pending[0];
    const base = { id: mentionId(pr), parent: mentionsId, kind: "mention" as const, name: prName(pr.repo, pr.number), title: pr.title, url: pr.url, key: latest?.url ?? "answered", wanted: latest !== undefined };
    if (!latest) return { ...base, done: "you answered" };
    const others = new Set(pending.map((mention) => mention.author.toLowerCase())).size - 1;
    const what = others > 0 ? `mentioned you, as did ${others} more` : "mentioned you";
    return { ...base, desired: { player: you, with: { id: personId(latest.author), who: latest.author }, what, link: { ref: latest.url, label: "the mention" } } };
  });
}

export function isPooled(strand: { kind?: string; open: { player: string; source: string }[] }): boolean {
  return strand.kind === "review" && strand.open.some((move) => move.player === githubPlayer && move.source === source);
}

export function assignFacts(strand: { id: string; open: { id: string; player: string; source: string }[] }, newId: (prefix: string) => string): Fact[] {
  return [
    ...strand.open.filter((move) => move.source === source).map((move): Fact => ({ type: "move.closed", move: move.id })),
    { type: "move.opened", move: newId("m"), strand: strand.id, player: you, what: "assigned to you" },
  ];
}

export function mentionLink(strand: { kind?: string; open: { links: { adapter: string; ref: string; label?: string; at: number }[] }[]; recent: { links: { adapter: string; ref: string; label?: string; at: number }[] }[] }) {
  if (strand.kind !== "mention") return undefined;
  return [...strand.open, ...strand.recent].flatMap((move) => move.links).filter((link) => link.adapter === prAdapter).sort((a, b) => a.at - b.at).at(-1);
}

class Reconciler {
  private readonly facts: Fact[] = [];
  private readonly live: Map<string, Knowledge["strands"][number]>;
  private readonly closed: Map<string, Knowledge["closed"][number]>;
  private readonly players: Set<string>;

  constructor(
    private readonly knowledge: Knowledge,
    private readonly newId: (prefix: string) => string,
    private readonly complete: { reviews: boolean; mentioned: boolean },
  ) {
    this.live = new Map(knowledge.strands.map((strand) => [strand.id, strand]));
    this.closed = new Map(knowledge.closed.map((strand) => [strand.id, strand]));
    this.players = new Set(knowledge.players.map((player) => player.id));
  }

  run(wants: Want[]): Fact[] {
    const seen = new Set(wants.map((want) => want.id));
    const kept = new Set(wants.filter((want) => this.want(want)).map((want) => want.parent));
    for (const strand of this.live.values()) {
      const review = strand.id.startsWith("github:review:");
      const ours = review || strand.id.startsWith("github:mention:");
      if (ours && !seen.has(strand.id) && (review ? this.complete.reviews : this.complete.mentioned)) {
        this.facts.push({ type: "strand.done", strand: strand.id, why: review ? "no longer waiting for a review" : "no longer open" });
      } else if (strand.parent && !seen.has(strand.id) && strand.parent in tops) kept.add(strand.parent);
    }
    for (const top of Object.keys(tops)) this.top(top, kept.has(top));
    return this.facts;
  }

  private want(want: Want): boolean {
    const live = this.live.has(want.id);
    const closed = this.closed.has(want.id);
    const hidden = !live && !closed && this.knowledge.links.some((link) => link.strand === want.id);
    const key = this.stateLink(want.id);
    if (closed) {
      const reopen = want.desired !== undefined && want.wanted && key?.ref !== want.key;
      this.setState(want.id, key, want.key);
      if (!reopen) return false;
      this.top(want.parent, true);
      this.facts.push({ type: "strand.reopened", strand: want.id });
    } else if (live || hidden) {
      if (want.done) {
        this.closeOurs(want.id);
        this.setState(want.id, key, want.key);
        this.facts.push({ type: "strand.done", strand: want.id, why: want.done });
        return false;
      }
      this.top(want.parent, true);
      const strand = this.live.get(want.id);
      if (strand && strand.parent !== want.parent) this.facts.push({ type: "strand.parented", strand: want.id, parent: want.parent });
      if (strand && strand.title !== want.title) this.facts.push({ type: "strand.titled", strand: want.id, kind: want.kind, title: want.title });
      if (key?.ref === want.key) return true;
    } else {
      if (!want.desired) return false;
      this.top(want.parent, true);
      this.facts.push({ type: "strand.made", strand: want.id, name: want.name, parent: want.parent, kind: want.kind });
      this.facts.push({ type: "strand.titled", strand: want.id, kind: want.kind, title: want.title });
      this.facts.push({ type: "link.added", link: this.newId("l"), strand: want.id, adapter: prAdapter, ref: want.url, label: want.name });
    }
    this.setState(want.id, key, want.key);
    this.move(want.id, want.desired!);
    return true;
  }

  private move(strand: string, desired: Desired): void {
    const open = this.knowledge.open.filter((move) => move.strand === strand && move.until === undefined);
    const ours = open.filter((move) => move.source === source);
    const same = (move: (typeof open)[number]) => move.player === desired.player && move.what === desired.what && (move.with ?? undefined) === desired.with?.id;
    if (ours.length === 1 && same(ours[0]!)) return;
    for (const move of ours) this.facts.push({ type: "move.closed", move: move.id });
    if (desired.player !== you) for (const move of open) if (move.player === you && move.source !== source) this.facts.push({ type: "move.closed", move: move.id });
    this.join(desired.player, desired.player === githubPlayer ? "machine" : "person", desired.who);
    if (desired.with) this.join(desired.with.id, "person", desired.with.who);
    const id = this.newId("m");
    this.facts.push({ type: "move.opened", move: id, strand, player: desired.player, ...(desired.with ? { with: desired.with.id } : {}), what: desired.what });
    if (desired.link) this.facts.push({ type: "link.added", link: this.newId("l"), move: id, adapter: prAdapter, ref: desired.link.ref, label: desired.link.label });
  }

  private join(player: string, kind: "machine" | "person", who: string | undefined): void {
    if (player === you || this.players.has(player) || !who) return;
    this.players.add(player);
    this.facts.push({ type: "player.joined", player, kind, who, adapter: source });
  }

  private closeOurs(strand: string): void {
    for (const move of this.knowledge.open) if (move.strand === strand && move.until === undefined && move.source === source) this.facts.push({ type: "move.closed", move: move.id });
  }

  private stateLink(strand: string): Knowledge["links"][number] | undefined {
    return this.knowledge.links.filter((link) => link.strand === strand && link.adapter === stateAdapter).sort((a, b) => a.at - b.at).at(-1);
  }

  private setState(strand: string, current: Knowledge["links"][number] | undefined, key: string): void {
    if (current?.ref === key) return;
    if (this.facts.some((fact) => fact.type === "link.added" && fact.strand === strand && fact.adapter === stateAdapter)) return;
    if (current) this.facts.push({ type: "link.removed", link: current.id });
    this.facts.push({ type: "link.added", link: this.newId("l"), strand, adapter: stateAdapter, ref: key });
  }

  private top(id: string, wanted: boolean): void {
    const live = this.live.has(id);
    const closed = this.closed.has(id);
    const made = this.facts.some((fact) => (fact.type === "strand.made" || fact.type === "strand.reopened") && fact.strand === id);
    if (wanted && !live && !made) {
      if (closed) this.facts.push({ type: "strand.reopened", strand: id });
      else {
        const { name, title } = tops[id as keyof typeof tops];
        this.facts.push({ type: "strand.made", strand: id, name, kind: "inbox" });
        this.facts.push({ type: "strand.titled", strand: id, title });
      }
      this.live.set(id, { id, name: tops[id as keyof typeof tops].name } as Knowledge["strands"][number]);
    } else if (!wanted && live && !made) {
      this.facts.push({ type: "strand.done", strand: id, why: "nothing waiting" });
      this.live.delete(id);
    }
  }
}
