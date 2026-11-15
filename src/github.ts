import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Review = { author: string; state: string; commit?: string; bot?: boolean };
export type PullRequest = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  assignees: string[];
  requested: string[];
  reviews: Review[];
  head?: string;
  public?: boolean;
};
export type Entry = { url: string; author: string; at: string; body: string; reacted: boolean };
export type Mentioned = { repo: string; number: number; title: string; url: string; entries: Entry[] };
export type Mention = { repo: string; number: number; title: string; prUrl: string; url: string; author: string; at: string };
export type Requested = { kind: "user" | "team" | "bot"; login: string };
export type OwnReview = { author: string; bot: boolean; state: string; commit?: string; at: string };
export type Thread = { author: string; resolved: boolean };
export type OwnPr = { repo: string; number: number; title: string; url: string; author: string; draft: boolean; branch: string; head?: string; requested: Requested[]; reviews: OwnReview[]; threads: Thread[] };
export type Pooled = { repo: string; number: number; title: string; url: string };
export type Inbox = {
  me: string;
  reviews: PullRequest[];
  mentioned: Mentioned[];
  mine?: OwnPr[];
  unreviewed?: Pooled[];
  complete?: { reviews: boolean; mentioned: boolean; mine?: boolean; pool?: boolean };
};

export type OwnState = { kind: "waiting"; who: string; whoKind: "person" | "machine"; what: string } | { kind: "yours"; what: string } | { kind: "draft"; what: string };

export const theTeam = "the team";

export type ReviewState =
  | { kind: "pool"; why: string }
  | { kind: "yours"; why: string }
  | { kind: "author"; why: string; author: string }
  | { kind: "gone"; why: string };

const openPrs = "is:open is:pr draft:false";

export function reviewState(pr: PullRequest, me: string): ReviewState {
  const mine = (login: string) => sameLogin(login, me);
  const decisive = pr.reviews.filter(isDecisive);
  const myLast = lastDecisive(pr, me);
  const pushed = myLast?.commit !== undefined && pr.head !== undefined && myLast.commit !== pr.head;
  if (pr.requested.some(mine)) return { kind: "yours", why: myLast ? "your review is asked for again" : "your review is asked for" };
  if (myLast?.state === "APPROVED") return { kind: "gone", why: "you approved it" };
  if (myLast?.state === "CHANGES_REQUESTED") return pushed ? { kind: "yours", why: `${pr.author} pushed since your review` } : { kind: "author", why: "addressing your review", author: pr.author };
  if (pr.assignees.some(mine)) return { kind: "yours", why: "assigned to you" };
  const others = pr.assignees.filter((login) => !mine(login));
  if (others.length > 0) return { kind: "gone", why: `${others.join(", ")} took it` };
  const latest = new Map<string, Review>();
  for (const review of decisive) if (!sameLogin(review.author, pr.author) && !review.bot && !isCopilot(review.author)) latest.set(review.author.toLowerCase(), review);
  const by = (state: string) => [...latest.values()].filter((review) => review.state === state).map((review) => review.author);
  const changers = by("CHANGES_REQUESTED");
  if (changers.length > 0) return { kind: "pool", why: `nobody assigned; changes requested by ${changers.join(", ")}` };
  const approvers = by("APPROVED");
  return { kind: "pool", why: approvers.length > 0 ? `nobody assigned; approved by ${approvers.join(", ")}` : "waiting for a reviewer" };
}

export function isCopilot(login: string): boolean {
  return /^copilot/i.test(login);
}

export function ownState(pr: OwnPr, required = 1): OwnState {
  const humans = pr.reviews.filter((review) => !review.bot && !isCopilot(review.author) && !sameLogin(review.author, pr.author)).sort((a, b) => a.at.localeCompare(b.at));
  const verdicts = new Map<string, OwnReview>();
  for (const review of humans) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) verdicts.set(review.author.toLowerCase(), review);
  const users = pr.requested.filter((request) => request.kind === "user" && !isCopilot(request.login));
  const asked = (login: string) => users.some((request) => sameLogin(request.login, login));
  const pushedSince = (review: OwnReview) => review.commit !== undefined && pr.head !== undefined && review.commit !== pr.head;
  const open = (by?: (login: string) => boolean) => pr.threads.filter((thread) => !thread.resolved && !sameLogin(thread.author, pr.author) && (by ? by(thread.author) : true)).length;
  const threads = (count: number) => (count > 0 ? ` · ${plural(count, "thread")}` : "");
  const changers = [...verdicts.values()].filter((review) => review.state === "CHANGES_REQUESTED").sort((a, b) => a.at.localeCompare(b.at));
  const outstanding = changers.filter((review) => !asked(review.author) && !pushedSince(review));
  if (outstanding.length > 0) return { kind: "yours", what: `${names(outstanding)} requested changes${threads(open())}` };
  const again = changers.at(-1);
  if (again) return { kind: "waiting", who: again.author, whoKind: "person", what: "re-review" };
  if (pr.requested.some((request) => isCopilot(request.login))) return { kind: "waiting", who: "Copilot", whoKind: "machine", what: "reviewing" };
  const approvals = [...verdicts.values()].filter((review) => review.state === "APPROVED");
  if (approvals.length >= required && users.length === 0) return { kind: "yours", what: `approved by ${names(approvals)} · merge it` };
  const copilot = pr.reviews.filter((review) => isCopilot(review.author)).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  const copilotOpen = open(isCopilot);
  if (copilot && !pushedSince(copilot) && copilotOpen > 0) return { kind: "yours", what: `Copilot left ${plural(copilotOpen, "comment")}` };
  const commenters = humans.filter((review) => review.state === "COMMENTED" && !verdicts.has(review.author.toLowerCase()) && !pushedSince(review) && open((login) => sameLogin(login, review.author)) > 0);
  const commented = open((login) => commenters.some((review) => sameLogin(review.author, login)));
  if (commenters.length > 0) return { kind: "yours", what: `${names(commenters.reverse())} left comments${threads(commented)}` };
  const user = users[0];
  if (user) return { kind: "waiting", who: user.login, whoKind: "person", what: humans.some((review) => sameLogin(review.author, user.login)) ? "re-review" : "reviewing" };
  if (pr.draft) return { kind: "draft", what: "draft" };
  return { kind: "waiting", who: theTeam, whoKind: "person", what: `${approvals.length} of ${Math.max(required, approvals.length)} reviews` };
}

function names(reviews: OwnReview[]): string {
  return [...new Set(reviews.map((review) => review.author))].join(", ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function isUnreviewed(pr: PullRequest): boolean {
  return pr.assignees.length === 0 && !pr.reviews.some((review) => isDecisive(review) && !review.bot && !isCopilot(review.author) && !sameLogin(review.author, pr.author));
}

function isDecisive(review: Review): boolean {
  return review.state === "APPROVED" || review.state === "CHANGES_REQUESTED";
}

function lastDecisive(pr: PullRequest, me: string): Review | undefined {
  return pr.reviews.filter((review) => isDecisive(review) && sameLogin(review.author, me)).at(-1);
}

export function pendingMentions(pr: Mentioned, me: string): Mention[] {
  const mine = (entry: Entry) => sameLogin(entry.author, me);
  const myLatest = pr.entries.filter(mine).reduce((latest, entry) => (entry.at > latest ? entry.at : latest), "");
  return pr.entries
    .filter((entry) => !mine(entry) && !entry.reacted && entry.at > myLatest && mentionsUser(entry.body, me))
    .map((entry) => ({ repo: pr.repo, number: pr.number, title: pr.title, prUrl: pr.url, url: entry.url, author: entry.author, at: entry.at }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function mentionsUser(body: string, me: string): boolean {
  const escaped = me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w/-])@${escaped}(?![\\w-])`, "i").test(body);
}

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function prRef(url: string): { repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return match ? { repo: match[1]!, number: Number(match[2]) } : undefined;
}

export function prName(repo: string, number: number): string {
  return `${repo.split("/").at(-1)}#${number}`;
}

export function samePr(a: string, b: string): boolean {
  const left = prRef(a);
  const right = prRef(b);
  return left !== undefined && right !== undefined && left.number === right.number && left.repo.toLowerCase() === right.repo.toLowerCase();
}

const prFields =
  "title number url author { login } repository { nameWithOwner isPrivate } assignees(first: 20) { nodes { login } } reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login } } } } reviews(last: 50) { nodes { state author { __typename login } commit { oid } } } commits(last: 1) { nodes { commit { oid } } }";
const ownFields =
  "title number url isDraft headRefName author { login } repository { nameWithOwner } reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } } } } reviews(last: 50) { nodes { state submittedAt author { __typename login } commit { oid } } } reviewThreads(last: 100) { nodes { isResolved comments(first: 1) { nodes { author { login } } } } } commits(last: 1) { nodes { commit { oid } } }";
const entryFields = "url createdAt body author { login } reactionGroups { viewerHasReacted }";

const reviewsMax = 50;
const mentionsMax = 20;
const mineMax = 50;
const reviewsQuery = `query($q: String!) { search(query: $q, type: ISSUE, first: ${reviewsMax}) { nodes { ... on PullRequest { ${prFields} } } } }`;
const mineQuery = `query($q: String!) { search(query: $q, type: ISSUE, first: ${mineMax}) { nodes { ... on PullRequest { ${ownFields} } } } }`;
const mentionsQuery = `query($q: String!) { search(query: $q, type: ISSUE, first: ${mentionsMax}) { nodes { ... on PullRequest { title number ${entryFields} repository { nameWithOwner } comments(last: 100) { nodes { ${entryFields} } } reviews(last: 50) { nodes { url createdAt: submittedAt body author { login } reactionGroups { viewerHasReacted } } } reviewThreads(last: 50) { nodes { comments(last: 20) { nodes { ${entryFields} } } } } } } } }`;

export type Gh = (args: string[]) => Promise<string>;

export async function runGh(args: string[]): Promise<string> {
  const child = Bun.spawn([Bun.which("gh", { PATH: process.env.PATH ?? "" }) ?? "gh", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`gh ${args[0]} failed: ${err.trim().split("\n")[0] || `exit ${code}`}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function graphql(gh: Gh, query: string, q: string): Promise<unknown[]> {
  const body = JSON.parse(await gh(["api", "graphql", "-F", `q=${q}`, "-f", `query=${query}`])) as { data?: { search?: { nodes?: unknown[] } }; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`GitHub: ${body.errors[0]!.message}`);
  return body.data?.search?.nodes ?? [];
}

export async function fetchInbox(gh: Gh = runGh, poolQuery = reviewQuery()): Promise<Inbox> {
  const me = (await gh(["api", "user", "--jq", ".login"])).trim();
  if (!me) throw new Error("gh doesn't say who you are");
  const searches = [...(poolQuery ? [`${poolQuery} -author:${me}`] : []), `${openPrs} assignee:${me}`, `${openPrs} review-requested:${me}`, `${openPrs} reviewed-by:${me}`];
  const [found, mentioned, mine] = await Promise.all([Promise.all(searches.map((q) => graphql(gh, reviewsQuery, q))), graphql(gh, mentionsQuery, `is:pr is:open mentions:${me}`), graphql(gh, mineQuery, `is:pr is:open author:${me}`)]);
  const poolComplete = poolQuery ? found[0]!.length < reviewsMax : true;
  const pool = poolQuery ? found[0]!.flatMap((node) => readPullRequest(node) ?? []).filter((pr) => !sameLogin(pr.author, me)) : undefined;
  const reviewed = found.pop()!;
  const requested = new Set(found.at(-1)!.flatMap((node) => readPullRequest(node)?.url ?? []));
  const reviews = new Map<string, PullRequest>();
  for (const node of found.flat()) {
    const pr = readPullRequest(node);
    if (!pr || sameLogin(pr.author, me) || reviews.has(pr.url)) continue;
    reviews.set(pr.url, requested.has(pr.url) && !pr.requested.some((login) => sameLogin(login, me)) ? { ...pr, requested: [...pr.requested, me] } : pr);
  }
  for (const node of reviewed) {
    const pr = readPullRequest(node);
    if (pr && !sameLogin(pr.author, me) && !reviews.has(pr.url) && lastDecisive(pr, me)?.state === "CHANGES_REQUESTED") reviews.set(pr.url, pr);
  }
  return {
    me,
    reviews: [...reviews.values()],
    mentioned: mentioned.flatMap((node) => readMentioned(node) ?? []),
    mine: mine.flatMap((node) => readOwnPr(node) ?? []),
    ...(pool ? { unreviewed: pool.filter(isUnreviewed).map(({ repo, number, title, url }) => ({ repo, number, title, url })) } : {}),
    complete: { reviews: [...found, reviewed].every((nodes) => nodes.length < reviewsMax), mentioned: mentioned.length < mentionsMax, mine: mine.length < mineMax, pool: poolComplete },
  };
}

export function configFile(env: Record<string, string | undefined> = process.env): string {
  return env.PONPOKO_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ponpoko", "config.json");
}

function readConfig(file: string): { github?: { reviewQuery?: unknown; unreviewed?: unknown } } {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as { github?: { reviewQuery?: unknown; unreviewed?: unknown } };
}

export type Thresholds = { yellow: number; orange: number; red: number };
export const defaultThresholds: Thresholds = { yellow: 3, orange: 6, red: 10 };

export function unreviewedThresholds(file = configFile()): Thresholds {
  const given = readConfig(file).github?.unreviewed;
  if (typeof given !== "object" || given === null) return defaultThresholds;
  const pick = (key: keyof Thresholds) => {
    const value = (given as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : defaultThresholds[key];
  };
  return { yellow: pick("yellow"), orange: pick("orange"), red: pick("red") };
}

export function reviewQuery(file = configFile()): string | undefined {
  const query = readConfig(file).github?.reviewQuery;
  return typeof query === "string" && query.trim() !== "" ? query.trim() : undefined;
}

type Node = Record<string, any>;

function readPullRequest(raw: unknown): PullRequest | undefined {
  const node = raw as Node;
  if (typeof node?.url !== "string" || typeof node.number !== "number") return undefined;
  const logins = (nodes: Node[] | undefined) => (nodes ?? []).flatMap((entry) => (typeof entry?.login === "string" ? [entry.login] : []));
  return {
    repo: node.repository?.nameWithOwner ?? prRef(node.url)?.repo ?? "",
    number: node.number,
    title: node.title ?? "",
    url: node.url,
    author: node.author?.login ?? "ghost",
    assignees: logins(node.assignees?.nodes),
    requested: logins((node.reviewRequests?.nodes ?? []).map((request: Node) => request?.requestedReviewer)),
    reviews: (node.reviews?.nodes ?? []).flatMap((review: Node) =>
      review?.author?.login ? [{ author: review.author.login, state: review.state, ...(review.commit?.oid ? { commit: review.commit.oid } : {}), ...(review.author.__typename === "Bot" ? { bot: true } : {}) }] : [],
    ),
    ...(node.commits?.nodes?.[0]?.commit?.oid ? { head: node.commits.nodes[0].commit.oid } : {}),
    ...(node.repository?.isPrivate === false ? { public: true } : {}),
  };
}

function readOwnPr(raw: unknown): OwnPr | undefined {
  const node = raw as Node;
  if (typeof node?.url !== "string" || typeof node.number !== "number") return undefined;
  const requested = (node.reviewRequests?.nodes ?? []).flatMap((request: Node): Requested[] => {
    const reviewer = request?.requestedReviewer;
    if (reviewer?.__typename === "Team") return [{ kind: "team", login: reviewer.name ?? theTeam }];
    if (typeof reviewer?.login !== "string") return [];
    return [{ kind: reviewer.__typename === "Bot" ? "bot" : "user", login: reviewer.login }];
  });
  return {
    repo: node.repository?.nameWithOwner ?? prRef(node.url)?.repo ?? "",
    number: node.number,
    title: node.title ?? "",
    url: node.url,
    author: node.author?.login ?? "ghost",
    draft: node.isDraft === true,
    branch: node.headRefName ?? "",
    ...(node.commits?.nodes?.[0]?.commit?.oid ? { head: node.commits.nodes[0].commit.oid } : {}),
    requested,
    reviews: (node.reviews?.nodes ?? []).flatMap((review: Node): OwnReview[] =>
      review?.author?.login ? [{ author: review.author.login, bot: review.author.__typename === "Bot", state: review.state, at: review.submittedAt ?? "", ...(review.commit?.oid ? { commit: review.commit.oid } : {}) }] : [],
    ),
    threads: (node.reviewThreads?.nodes ?? []).map((thread: Node): Thread => ({ resolved: thread?.isResolved === true, author: thread?.comments?.nodes?.[0]?.author?.login ?? "ghost" })),
  };
}

function readMentioned(raw: unknown): Mentioned | undefined {
  const node = raw as Node;
  if (typeof node?.url !== "string" || typeof node.number !== "number") return undefined;
  const entry = (item: Node): Entry[] =>
    typeof item?.url === "string" ? [{ url: item.url, author: item.author?.login ?? "ghost", at: item.createdAt ?? "", body: item.body ?? "", reacted: (item.reactionGroups ?? []).some((group: Node) => group?.viewerHasReacted) }] : [];
  return {
    repo: node.repository?.nameWithOwner ?? prRef(node.url)?.repo ?? "",
    number: node.number,
    title: node.title ?? "",
    url: node.url,
    entries: [...entry(node), ...(node.comments?.nodes ?? []).flatMap(entry), ...(node.reviews?.nodes ?? []).flatMap(entry), ...(node.reviewThreads?.nodes ?? []).flatMap((thread: Node) => (thread?.comments?.nodes ?? []).flatMap(entry))],
  };
}

const lookupQuery = "query($url: URI!) { viewer { id } resource(url: $url) { ... on PullRequest { id } } }";
const assignMutation = "mutation($id: ID!, $userId: ID!) { addAssigneesToAssignable(input: {assignableId: $id, assigneeIds: [$userId]}) { clientMutationId } }";

export async function assignMe(url: string, gh: Gh = runGh): Promise<void> {
  const found = JSON.parse(await gh(["api", "graphql", "-F", `url=${url}`, "-f", `query=${lookupQuery}`])) as { data?: { viewer?: { id?: string }; resource?: { id?: string } | null }; errors?: { message: string }[] };
  if (found.errors?.length) throw new Error(`GitHub: ${found.errors[0]!.message}`);
  const userId = found.data?.viewer?.id;
  const id = found.data?.resource?.id;
  if (!userId || !id) throw new Error(`GitHub doesn't know the pull request ${url}`);
  const done = JSON.parse(await gh(["api", "graphql", "-F", `id=${id}`, "-F", `userId=${userId}`, "-f", `query=${assignMutation}`])) as { errors?: { message: string }[] };
  if (done.errors?.length) throw new Error(`GitHub: ${done.errors[0]!.message}`);
}

export async function markReady(url: string, gh: Gh = runGh): Promise<void> {
  if (!prRef(url)) throw new Error(`${url} isn't a pull request`);
  await gh(["pr", "ready", url]);
}
