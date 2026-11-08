import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Review = { author: string; state: string; commit?: string };
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
};
export type Entry = { url: string; author: string; at: string; body: string; reacted: boolean };
export type Mentioned = { repo: string; number: number; title: string; url: string; entries: Entry[] };
export type Mention = { repo: string; number: number; title: string; prUrl: string; url: string; author: string; at: string };
export type Inbox = { me: string; reviews: PullRequest[]; mentioned: Mentioned[]; complete?: { reviews: boolean; mentioned: boolean } };

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
  const approvers = [...new Set(decisive.filter((review) => review.state === "APPROVED" && !sameLogin(review.author, pr.author)).map((review) => review.author))];
  return { kind: "pool", why: approvers.length > 0 ? `nobody assigned; approved by ${approvers.join(", ")}` : "waiting for a reviewer" };
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

const prFields =
  "title number url author { login } repository { nameWithOwner } assignees(first: 20) { nodes { login } } reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login } } } } reviews(last: 50) { nodes { state author { login } commit { oid } } } commits(last: 1) { nodes { commit { oid } } }";
const entryFields = "url createdAt body author { login } reactionGroups { viewerHasReacted }";

const reviewsMax = 50;
const mentionsMax = 20;
const reviewsQuery = `query($q: String!) { search(query: $q, type: ISSUE, first: ${reviewsMax}) { nodes { ... on PullRequest { ${prFields} } } } }`;
const mentionsQuery = `query($q: String!) { search(query: $q, type: ISSUE, first: ${mentionsMax}) { nodes { ... on PullRequest { title number ${entryFields} repository { nameWithOwner } comments(last: 100) { nodes { ${entryFields} } } reviews(last: 50) { nodes { url createdAt: submittedAt body author { login } reactionGroups { viewerHasReacted } } } reviewThreads(last: 50) { nodes { comments(last: 20) { nodes { ${entryFields} } } } } } } } }`;

export type Gh = (args: string[]) => Promise<string>;

export async function runGh(args: string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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
  const [found, mentioned] = await Promise.all([Promise.all(searches.map((q) => graphql(gh, reviewsQuery, q))), graphql(gh, mentionsQuery, `is:pr is:open mentions:${me}`)]);
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
    complete: { reviews: [...found, reviewed].every((nodes) => nodes.length < reviewsMax), mentioned: mentioned.length < mentionsMax },
  };
}

export function configFile(env: Record<string, string | undefined> = process.env): string {
  return env.PONPOKO_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ponpoko", "config.json");
}

export function reviewQuery(file = configFile()): string | undefined {
  if (!existsSync(file)) return undefined;
  const config = JSON.parse(readFileSync(file, "utf8")) as { github?: { reviewQuery?: unknown } };
  const query = config.github?.reviewQuery;
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
    reviews: (node.reviews?.nodes ?? []).flatMap((review: Node) => (review?.author?.login ? [{ author: review.author.login, state: review.state, ...(review.commit?.oid ? { commit: review.commit.oid } : {}) }] : [])),
    ...(node.commits?.nodes?.[0]?.commit?.oid ? { head: node.commits.nodes[0].commit.oid } : {}),
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

export async function assignMe(url: string, gh: Gh = runGh): Promise<void> {
  await gh(["pr", "edit", url, "--add-assignee", "@me"]);
}
