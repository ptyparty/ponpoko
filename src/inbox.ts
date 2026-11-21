import { slug, type Knowledge } from "./core.ts";
import type { Fact, To } from "./events.ts";
import { ownState, pendingMentions, prName, prRef, reviewState, samePr, theTeam, type Inbox, type OwnPr } from "./github.ts";
import { isBookkeeping, you } from "./model.ts";
import { storyNumber } from "./shortcut.ts";

export const source = "github";
export const githubPlayer = "github";
export const reviewsId = "github:reviews";
export const mentionsId = "github:mentions";
export const prAdapter = "github";
export const stateAdapter = "github-state";
export const ownStateAdapter = "github-pr-state";
export const repoAdapter = "github-repo-state";
export const team = "group:team";
export const copilot = "service:copilot";

type Desired = { to: To; who?: string; what: string; kind: string; from?: { id: string; who: string }; link?: { ref: string; label: string } };
type Want = { id: string; parent: string; kind: "review" | "mention"; name: string; title: string; url: string; key: string; wanted: boolean; desired?: Desired; done?: string; public?: boolean };

const tops = {
  [reviewsId]: { name: "reviews", title: "Pull requests waiting for a review" },
  [mentionsId]: { name: "mentions", title: "Mentions on GitHub you haven't answered" },
};

export function isReviewId(strand: string): boolean {
  return strand.startsWith("github:review:");
}

export function reviewId(pr: { repo: string; number: number }): string {
  return `github:review:${pr.repo}#${pr.number}`;
}

export function mentionId(pr: { repo: string; number: number }): string {
  return `github:mention:${pr.repo}#${pr.number}`;
}

export function personId(login: string): string {
  return `person:${slug(login)}`;
}

export function prStrandId(pr: { repo: string; number: number }): string {
  return `pr:${pr.repo}#${pr.number}`;
}

export type Checkouts = Map<string, string>;

export { isBookkeeping };

export function inboxFacts(knowledge: Knowledge, inbox: Inbox, newId: (prefix: string) => string, checkouts: Checkouts = new Map()): Fact[] {
  return [...new Reconciler(knowledge, newId, inbox.complete ?? { reviews: true, mentioned: true }).run([...reviewWants(inbox), ...mentionWants(inbox)]), ...ownFacts(knowledge, inbox, newId, checkouts)];
}

function githubRequests(knowledge: Knowledge, strand: string) {
  return (knowledge.requests ?? []).filter((request) => request.strand === strand && request.source === source);
}

function answer(knowledge: Knowledge, strand: string, as: "done" | "withdrawn" = "done"): Fact[] {
  const open = githubRequests(knowledge, strand);
  return open.length > 0 ? [{ type: "said", requests: [], replies: open.map((request) => ({ request: request.id, as })) }] : [];
}

function party(knowledge: Knowledge, id: string, kind: "person" | "group" | "service", name: string, facts: Fact[]): void {
  if (id === you || (knowledge.parties ?? []).includes(id) || facts.some((fact) => fact.type === "party.known" && fact.party === id)) return;
  facts.push({ type: "party.known", party: id, kind, name });
}

export type OwnPrView = { url: string; repo: string; number: number; title: string; branch: string; draft: boolean; state: "waiting" | "yours" | "draft" | "closed"; who?: string; what: string; approved?: true };

const parsedPrs = new WeakMap<object, OwnPrView[]>();

export function ownPrs(strand: { links: { adapter: string; ref: string; at: number }[] }): OwnPrView[] {
  const cached = parsedPrs.get(strand.links);
  if (cached) return cached;
  const views = readOwnPrs(strand.links);
  parsedPrs.set(strand.links, views);
  return views;
}

export function prsOn(strand: { links: { adapter: string; ref: string; at: number }[]; childPrLinks?: { strand?: string; adapter: string; ref: string; at: number }[] }): OwnPrView[] {
  return [...ownPrs(strand), ...readOwnPrs(strand.childPrLinks ?? [])];
}

function readOwnPrs(links: { adapter: string; ref: string; at: number }[]): OwnPrView[] {
  return latestPrStates(links).map((entry) => entry.view);
}

type StateLink = { strand?: string; adapter: string; ref: string; at: number };

export function latestPrStates<T extends StateLink>(links: T[]): { link: T; view: OwnPrView; key: string }[] {
  const latest = new Map<string, { link: T; view: OwnPrView; key: string }>();
  for (const link of links) {
    if (link.adapter !== ownStateAdapter) continue;
    const view = readOwnPrView(link.ref);
    if (!view) continue;
    const key = stateKey(link.strand, view.url);
    if ((latest.get(key)?.link.at ?? -1) <= link.at) latest.set(key, { link, view, key });
  }
  return [...latest.values()];
}

function stateKey(strand: string | undefined, url: string): string {
  return `${strand ?? ""} ${prKey(url)}`;
}

export function readOwnPrView(ref: string): OwnPrView | undefined {
  try {
    const view = JSON.parse(ref) as OwnPrView;
    return typeof view?.url === "string" && typeof view.state === "string" ? view : undefined;
  } catch {
    return undefined;
  }
}

function prKey(url: string): string {
  const ref = prRef(url);
  return ref ? `${ref.repo.toLowerCase()}#${ref.number}` : url;
}

export function unwatchedPrs(knowledge: Knowledge): string[] {
  const watched = new Set(knowledge.links.filter((link) => link.adapter === ownStateAdapter).flatMap((link) => readOwnPrView(link.ref)?.url ?? []).map(prKey));
  const live = new Set(knowledge.strands.map((strand) => strand.id));
  return knowledge.links.filter((link) => link.adapter === prAdapter && link.strand && live.has(link.strand) && !link.strand.startsWith("github:") && prRef(link.ref) && !watched.has(prKey(link.ref))).map((link) => link.ref);
}

const openPrStrandsOf = new WeakMap<Knowledge, Set<string>>();

export function hasOpenPr(knowledge: Knowledge, strand: string): boolean {
  let strands = openPrStrandsOf.get(knowledge);
  if (!strands) {
    strands = new Set(latestPrStates(knowledge.links.filter((link) => link.strand)).flatMap((entry) => (entry.view.state !== "closed" ? [entry.link.strand!] : [])));
    openPrStrandsOf.set(knowledge, strands);
  }
  return strands.has(strand);
}

export function prLinkIds(knowledge: Knowledge): string[] {
  return knowledge.links.filter((link) => link.adapter === prAdapter && link.strand !== undefined && !link.strand.startsWith("github:")).map((link) => link.id);
}

export function branchStrand(knowledge: Knowledge, branch: string): string | undefined {
  const wanted = branch.toLowerCase();
  const found = knowledge.strands.filter((strand) => {
    if (strand.id.startsWith("github:") || storyNumber(strand.name) === undefined) return false;
    const name = strand.name.toLowerCase();
    let at = wanted.indexOf(name);
    while (at >= 0) {
      const before = wanted[at - 1];
      const after = wanted[at + name.length];
      if ((before === undefined || !/[a-z0-9]/.test(before)) && (after === undefined || !/[a-z0-9]/.test(after))) return true;
      at = wanted.indexOf(name, at + 1);
    }
    return false;
  });
  return found.length === 1 ? found[0]!.id : undefined;
}


function ownFacts(knowledge: Knowledge, inbox: Inbox, newId: (prefix: string) => string, checkouts: Checkouts): Fact[] {
  if (!inbox.mine) return [];
  const facts: Fact[] = [];
  const live = new Map(knowledge.strands.map((strand) => [strand.id, strand]));
  const closed = new Map(knowledge.closed.map((strand) => [strand.id, strand]));
  const prLinks = knowledge.links.filter((link) => link.adapter === prAdapter && link.strand && live.has(link.strand) && !link.strand.startsWith("github:") && !link.strand.startsWith("pr:"));
  const stateLinks = knowledge.links.filter((link) => link.adapter === ownStateAdapter && link.strand && live.has(link.strand));
  const currentStates = new Map(latestPrStates(stateLinks).map((entry) => [entry.key, entry.link]));
  const stateOf = (strand: string, url: string) => currentStates.get(stateKey(strand, url));
  const setState = (strand: string, current: Knowledge["links"][number] | undefined, view: OwnPrView) => {
    const ref = JSON.stringify(view);
    if (current?.ref === ref) return;
    if (current) facts.push({ type: "link.removed", link: current.id });
    facts.push({ type: "link.added", link: newId("l"), strand, adapter: ownStateAdapter, ref });
  };
  const explicit = (pr: OwnPr) => prLinks.filter((link) => samePr(link.ref, pr.url)).sort((a, b) => a.at - b.at).at(-1)?.strand;
  const storyOf = (pr: OwnPr): string | undefined => explicit(pr) ?? checkouts.get(pr.branch) ?? branchStrand(knowledge, pr.branch) ?? branchStrand(knowledge, pr.title);
  const react = (strand: string, pr: OwnPr, view: OwnPrView) => {
    facts.push(...answer(knowledge, strand));
    if (view.state === "draft" || view.state === "closed") return;
    const to = view.state === "yours" ? ({ role: "owner", strand } as To) : reviewer(knowledge, view.who!, facts);
    const request = newId("r");
    facts.push({ type: "said", requests: [{ request, strand, to, what: view.what, kind: view.state === "yours" ? "pr" : "review", ref: pr.url }], replies: [] });
  };
  const lastState = (strand: string) => latestPrStates(knowledge.links.filter((link) => link.strand === strand))[0]?.view;
  const forgotten = new Set((knowledge.forgotten ?? []).map((entry) => entry.name));
  const seen = new Set<string>();
  for (const pr of inbox.mine) {
    seen.add(prKey(pr.url));
    const strand = prStrandId(pr);
    const story = storyOf(pr);
    if (closed.has(strand)) {
      if (lastState(strand)?.state !== "closed") continue;
      facts.push({ type: "strand.reopened", strand });
      for (const link of knowledge.links.filter((candidate) => candidate.strand === strand && candidate.adapter === ownStateAdapter)) facts.push({ type: "link.removed", link: link.id });
    } else if (!live.has(strand)) {
      if (forgotten.has(prName(pr.repo, pr.number))) continue;
      facts.push({ type: "strand.made", strand, name: prName(pr.repo, pr.number), ...(story ? { parent: story } : {}), kind: "pr" });
      facts.push({ type: "link.added", link: newId("l"), strand, adapter: prAdapter, ref: pr.url, label: prName(pr.repo, pr.number) });
      facts.push({ type: "strand.role", strand, role: "owner", by: you });
    } else if (story && live.get(strand)!.parent !== story && (live.get(strand)!.parent === undefined || explicit(pr) === story)) facts.push({ type: "strand.parented", strand, parent: story });
    if (live.get(strand)?.title !== pr.title) facts.push({ type: "strand.titled", strand, kind: "pr", title: pr.title });
    const state = ownState(pr);
    const view: OwnPrView = { url: pr.url, repo: pr.repo, number: pr.number, title: pr.title, branch: pr.branch, draft: pr.draft, state: state.kind, ...(state.kind === "waiting" ? { who: state.who } : {}), what: state.what, ...(state.kind === "yours" && state.approved ? { approved: true as const } : {}) };
    const current = stateOf(strand, pr.url);
    const before = current ? readOwnPrView(current.ref) : undefined;
    setState(strand, current, view);
    if (before && before.state === view.state && before.who === view.who && before.what === view.what) continue;
    react(strand, pr, view);
  }
  if (inbox.complete?.mine === false) return facts;
  for (const link of stateLinks) {
    const before = readOwnPrView(link.ref);
    if (!before || before.state === "closed" || seen.has(prKey(before.url)) || stateOf(link.strand!, before.url) !== link) continue;
    const view: OwnPrView = { ...before, state: "closed", what: "merged or closed" };
    delete view.approved;
    delete view.who;
    setState(link.strand!, link, view);
    facts.push(...answer(knowledge, link.strand!));
    if (link.strand!.startsWith("pr:")) facts.push({ type: "strand.done", strand: link.strand!, why: "merged or closed" });
  }
  return facts;
}

function reviewer(knowledge: Knowledge, who: string, facts: Fact[]): To {
  if (who === "Copilot") {
    party(knowledge, copilot, "service", "Copilot", facts);
    return { service: copilot };
  }
  if (who === theTeam) {
    party(knowledge, team, "group", "team", facts);
    return { group: team };
  }
  party(knowledge, personId(who), "person", who, facts);
  return { person: personId(who) };
}

function reviewWants(inbox: Inbox): Want[] {
  return inbox.reviews.map((pr) => {
    const state = reviewState(pr, inbox.me);
    const base = { id: reviewId(pr), parent: reviewsId, kind: "review" as const, name: prName(pr.repo, pr.number), title: pr.title, url: pr.url, key: `${state.kind}:${pr.head ?? ""}:${state.why}`, wanted: state.kind === "yours", ...(pr.public ? { public: true } : {}) };
    switch (state.kind) {
      case "gone":
        return { ...base, done: state.why };
      case "pool":
        return { ...base, desired: { to: { group: team }, who: "team", what: state.why, kind: "review" } };
      case "yours":
        return { ...base, desired: { to: { person: you }, what: state.why, kind: "review" } };
      case "author":
        return { ...base, desired: { to: { person: personId(state.author) }, who: state.author, what: state.why, kind: "review" } };
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
    return { ...base, desired: { to: { person: you }, from: { id: personId(latest.author), who: latest.author }, what, kind: "mention", link: { ref: latest.url, label: "the mention" } } };
  });
}

export function isPooled(strand: { kind?: string; open: { player: string; source: string }[] }): boolean {
  return strand.kind === "review" && strand.open.some((move) => (move.player === githubPlayer || move.player === team) && move.source === source);
}

export function assignFacts(strand: { id: string; open: { id: string; player: string; source: string; kind?: string }[]; requests?: { id: string; source: string }[] }): Fact[] {
  const asked = (strand.requests ?? []).filter((request) => request.source === source);
  return [
    ...strand.open.filter((move) => move.source === source && !asked.some((request) => request.id === move.id)).map((move): Fact => ({ type: "move.closed", move: move.id })),
    ...(asked.length > 0 ? [{ type: "said" as const, requests: [], replies: asked.map((request) => ({ request: request.id, as: "progress" as const, by: you })) }] : []),
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

  constructor(
    private readonly knowledge: Knowledge,
    private readonly newId: (prefix: string) => string,
    private readonly complete: { reviews: boolean; mentioned: boolean },
  ) {
    this.live = new Map(knowledge.strands.map((strand) => [strand.id, strand]));
    this.closed = new Map(knowledge.closed.map((strand) => [strand.id, strand]));
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
    const shown = this.wantShown(want);
    if (shown && want.public && !this.knowledge.links.some((link) => link.strand === want.id && link.adapter === repoAdapter)) this.facts.push({ type: "link.added", link: this.newId("l"), strand: want.id, adapter: repoAdapter, ref: "public" });
    return shown;
  }

  private wantShown(want: Want): boolean {
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
    const open = githubRequests(this.knowledge, strand);
    const key = JSON.stringify(desired.to);
    const taken = (request: (typeof open)[number]) => request.progress?.by === you && "group" in request.to && "person" in desired.to && desired.to.person === you;
    const same = (request: (typeof open)[number]) => taken(request) || (request.what === desired.what && JSON.stringify(request.to) === key && request.from === desired.from?.id);
    if (open.length === 1 && same(open[0]!)) return;
    this.closeOurs(strand);
    if ("group" in desired.to) party(this.knowledge, desired.to.group, "group", desired.who ?? desired.to.group, this.facts);
    if ("person" in desired.to && desired.to.person !== you) party(this.knowledge, desired.to.person, "person", desired.who ?? desired.to.person, this.facts);
    if (desired.from) party(this.knowledge, desired.from.id, "person", desired.from.who, this.facts);
    const id = this.newId("r");
    this.facts.push({ type: "said", requests: [{ request: id, strand, to: desired.to, what: desired.what, kind: desired.kind, ...(desired.from ? { from: desired.from.id } : {}) }], replies: [] });
    if (desired.link) this.facts.push({ type: "link.added", link: this.newId("l"), move: id, adapter: prAdapter, ref: desired.link.ref, label: desired.link.label });
  }

  private closeOurs(strand: string): void {
    for (const move of this.knowledge.open) if (move.strand === strand && move.until === undefined && move.source === source) this.facts.push({ type: "move.closed", move: move.id });
    this.facts.push(...answer(this.knowledge, strand));
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
