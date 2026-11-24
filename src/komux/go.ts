import { aboveOf, underOf, type MoveView, type PlayerView, type StrandView } from "../core.ts";
import { prRef, storyCommand } from "../github.ts";
import { isBookkeeping, mentionLink, prAdapter } from "../inbox.ts";
import { sendKomux } from "./stream.ts";
import { isStory } from "../shortcut.ts";
import { forgetProjects, knownProjects, loadProjects, projectNamed, type Project } from "./projects.ts";
import { komuxPlace, komuxTabHandle, readKomuxTabHandle, readKomuxTabRef, type KomuxTabRef } from "./translate.ts";

export type Control = (request: unknown) => Promise<{ ok: boolean; error?: string; result?: unknown }>;

export type Landing = { how: "focused" | "opened"; tabDir?: string };

export async function goInKomux(strand: StrandView, strands: StrandView[], env = process.env, control?: Control): Promise<Landing> {
  const socket = env.KOMUX_SOCKET;
  if (!socket) throw new Error("go works from inside komux");
  const send = control ?? ((request: unknown) => sendKomux(socket, request));
  await loadProjects(env).catch(() => undefined);
  const target = goTarget(strand, strands, env);
  const place = target ? komuxPlace(target.player) : undefined;
  if (target && place && target.player.live && place.session === env.KOMUX_SESSION && place.server === env.KOMUX_SERVER_ID) {
    const tab = target.player.kind === "agent" ? await send({ method: "tab.focus", params: { tabId: place.tabId } }) : undefined;
    if (tab?.ok) return landed("focused", tab.result);
    const focused = await send({ method: "pane.focus", params: { paneId: place.paneId } });
    if (!focused.ok) throw new Error(focused.error ?? "komux refused");
    return landed("focused", focused.result);
  }
  const open = openTab(strand, env);
  if (open) {
    const focused = await send({ method: "tab.focus", params: { tabId: open.tabId } });
    if (!focused.ok) throw new Error(focused.error ?? "komux refused");
    return landed("focused", focused.result);
  }
  const review = reviewOf(strand);
  if (review && !tabOf(strand)) {
    const opened = await send({ method: "project.open", params: { repo: review.repo, layout: reviewLayout(env), args: { pr: String(review.number), strand: strand.path.join(" › ") } } });
    if (!opened.ok) throw new Error(opened.error ?? "komux refused");
    return landed("opened", opened.result);
  }
  const unhoused = unhousedStory(strand, strands, env);
  if (unhoused) throw new Error(noStoryDir(unhoused));
  const where = goPlace(strand, aboveOf(strands, strand), env);
  if (!where) throw new Error("ponpoko doesn't know where this strand lives");
  const opened = await send({ method: "project.open", params: { target: where.dir, ...layoutAt(where.tab, where.dir) } });
  if (!opened.ok) throw new Error(opened.error ?? "komux refused");
  return landed("opened", opened.result);
}

function landed(how: Landing["how"], result: unknown): Landing {
  const tabDir = typeof result === "object" && result !== null && "tabDir" in result && typeof result.tabDir === "string" ? result.tabDir : undefined;
  return { how, ...(tabDir ? { tabDir } : {}) };
}

export function reviewOf(strand: StrandView): { repo: string; number: number } | undefined {
  if (strand.kind !== "review") return undefined;
  const link = strand.links.find((candidate) => candidate.adapter === prAdapter);
  return link ? prRef(link.ref) : undefined;
}

export function reviewLayout(env: Record<string, string | undefined> = process.env): string {
  return env.PONPOKO_REVIEW_LAYOUT || "pr-review";
}

export function goTarget(strand: StrandView, strands: StrandView[] = [], env: Record<string, string | undefined> = process.env): { player: PlayerView; move: MoveView } | undefined {
  const home = homeDir(strand, env);
  const unhoused = unhousedStory(strand, strands, env);
  for (const move of strand.open) {
    const player = move.answers ?? move.by;
    const place = komuxPlace(player);
    if (player.live && place && ((home ? within(place.dir, home) : !unhoused) || player.id === strand.agent?.id || move.id.startsWith("activity:"))) return { player, move };
  }
  if (strands.length === 0 || unhoused || openTab(strand, env)) return undefined;
  const options = pickup(strand, env);
  const dir = options?.resume?.dir ?? options?.dir ?? goPlace(strand, aboveOf(strands, strand), env)?.dir;
  return dir ? claudeIn([strand, ...aboveOf(strands, strand), ...strands], dir, env) : undefined;
}

function claudeIn(strands: StrandView[], dir: string, env: Record<string, string | undefined>): { player: PlayerView; move: MoveView } | undefined {
  for (const strand of strands) {
    for (const move of strand.open) {
      const player = move.answers ?? move.by;
      const place = komuxPlace(player);
      if (player.kind === "agent" && player.live && place?.dir === dir && place.session === env.KOMUX_SESSION && place.server === env.KOMUX_SERVER_ID) return { player, move };
    }
  }
  return undefined;
}

export function openTab(strand: StrandView, env: Record<string, string | undefined> = process.env): { tabId: number; label: string } | undefined {
  for (const space of strand.spaces) {
    const tab = space.handle ? readKomuxTabHandle(space.handle) : undefined;
    if (tab && tab.server === env.KOMUX_SERVER_ID) return { tabId: tab.tabId, label: space.label };
  }
  return undefined;
}

export function tabStrands(strands: StrandView[], server: string, tabId: number): StrandView[] {
  const handle = komuxTabHandle(server, tabId);
  const here = (strand: StrandView) =>
    strand.spaces.some((space) => space.handle === handle) ||
    strand.open.some((move) => {
      const place = komuxPlace(move.answers ?? move.by);
      return place?.server === server && place.tabId === tabId;
    });
  const found = new Set(strands.filter(here).map((strand) => strand.id));
  const roots = strands.filter((strand) => found.has(strand.id) && !aboveOf(strands, strand).some((above) => found.has(above.id)));
  return roots.flatMap((root) => [root, ...underOf(strands, root)]);
}

export function goPlace(strand: StrandView, above: StrandView[], env: Record<string, string | undefined> = process.env): { dir: string; tab?: KomuxTabRef } | undefined {
  if (unhousedStory(strand, [strand, ...above], env)) return undefined;
  const home = homeDir(strand, env);
  for (const at of [strand, ...above]) {
    const tab = tabOf(at);
    const last = lastDir(at);
    const dir = ownDir(at) ?? storyProject(at, env)?.dir ?? (last && (!home || within(last, home)) ? last : undefined);
    if (dir) return { dir, ...(tab ? { tab } : {}) };
  }
  if (strand.dir) return { dir: strand.dir };
  const project = [strand, ...above].map((at) => projectOf(at, env)).find(Boolean);
  return project ? { dir: project.dir } : undefined;
}

export function projectOf(strand: { name: string }, env: Record<string, string | undefined> = process.env): Project | undefined {
  return projectNamed(strand.name, knownProjects(env));
}

function storyProject(strand: { name: string; kind?: string }, env: Record<string, string | undefined>): Project | undefined {
  return isStory(strand) ? projectOf(strand, env) : undefined;
}

export function homeDir(strand: StrandView, env: Record<string, string | undefined> = process.env): string | undefined {
  const own = ownDir(strand);
  if (own) return own;
  const nearest = nearestStory(strand);
  const story = nearest ? projectOf(nearest, env) : undefined;
  if (!story) return undefined;
  return strand.dir && within(strand.dir, story.dir) ? strand.dir : story.dir;
}

export function unhousedStory(strand: StrandView, strands: StrandView[], env: Record<string, string | undefined> = process.env): string | undefined {
  for (const at of [strand, ...aboveOf(strands, strand)]) {
    if (ownDir(at) || openTab(at, env)) return undefined;
    if (!isStory(at)) continue;
    if (at.kind === "epic" || projectOf(at, env)) return undefined;
    const worked = workedIn(at);
    const borrowed = aboveOf(strands, at).some((above) => {
      const dir = ownDir(above) ?? projectOf(above, env)?.dir ?? workedIn(above);
      return dir !== undefined && worked !== undefined && within(worked, dir);
    });
    return worked === undefined || borrowed ? at.name : undefined;
  }
  return undefined;
}

function ownDir(strand: StrandView): string | undefined {
  return tabOf(strand)?.dir ?? strand.links.find((link) => link.adapter === "dir")?.ref;
}

function workedIn(strand: StrandView): string | undefined {
  if (strand.agent) return komuxPlace(strand.agent)?.dir;
  for (const move of [...strand.recent].reverse()) if (move.by.kind === "agent") return komuxPlace(move.by)?.dir;
  return undefined;
}

export function noStoryDir(story: string): string {
  return `${story} has no story directory yet`;
}

export function noStoryDirHint(story: string): string {
  return canMakeStoryDir(story) ? `${noStoryDir(story)}; make one` : noStoryDir(story);
}

export function makeStoryDirAsk(story: string): string {
  return `${noStoryDir(story)} · y make it and open it   any other key no`;
}

export function cantMakeStoryDir(story: string): string {
  return `${noStoryDir(story)}; set stories.newCommand in ponpoko's config to make one from here`;
}

function nearestStory(strand: StrandView): { name: string; kind?: string } | undefined {
  return [strand, ...strand.above].find((at) => isStory(at));
}

function within(dir: string, home: string): boolean {
  return dir === home || dir.startsWith(`${home.replace(/\/+$/, "")}/`);
}

export function tabOf(strand: StrandView): KomuxTabRef | undefined {
  const link = strand.links.filter((candidate) => candidate.adapter === "komux").sort((a, b) => a.at - b.at).at(-1);
  return link ? readKomuxTabRef(link.ref) : undefined;
}

function layoutAt(tab: KomuxTabRef | undefined, dir: string): { layout?: string; args?: Record<string, string> } {
  if (!tab || tab.dir !== dir) return {};
  return { ...(tab.layout ? { layout: tab.layout } : {}), ...(tab.args ? { args: tab.args } : {}) };
}

function lastDir(strand: StrandView): string | undefined {
  for (const move of [...strand.recent].reverse()) {
    const dir = komuxPlace(move.answers ?? move.by)?.dir;
    if (dir) return dir;
  }
  return strand.agent ? komuxPlace(strand.agent)?.dir : undefined;
}

export type Pickup = { resume?: { session: string; dir: string; who: string; at: number }; dir?: string };

export function pickup(strand: StrandView, env: Record<string, string | undefined> = process.env): Pickup | undefined {
  if (goTarget(strand, [], env) || (strand.own.whose === undefined && !strand.own.quiet)) return undefined;
  return startsAt(strand, env);
}

export function startsAt(strand: StrandView, env: Record<string, string | undefined> = process.env): Pickup | undefined {
  const home = homeDir(strand, env);
  const last = [...strand.recent].reverse().find((move) => {
    const player = move.answers ?? move.by;
    const dir = komuxPlace(player)?.dir;
    return player.kind === "agent" && player.resume && dir && (!home || within(dir, home));
  });
  const holder = strand.agent?.resume && komuxPlace(strand.agent)?.dir ? strand.agent : undefined;
  const agent = holder ?? (last ? (last.answers ?? last.by) : undefined);
  const place = agent ? komuxPlace(agent) : undefined;
  const worked = [...strand.recent].reverse().find((move) => (move.answers ?? move.by).id === agent?.id);
  const at = worked ? (worked.until ?? worked.from) : holder ? (holder.gone ?? holder.joined) : 0;
  const resume = agent && place ? { session: agent.resume!, dir: place.dir, who: agent.who, at } : undefined;
  const dir = home ?? strand.dir ?? resume?.dir ?? lastDir(strand) ?? projectOf(strand, env)?.dir;
  if (!resume && !dir) return undefined;
  return { ...(resume ? { resume } : {}), ...(dir ? { dir } : {}) };
}

export function needsStoryDir(strand: StrandView, strands: StrandView[], env: Record<string, string | undefined> = process.env): string | undefined {
  if (mentionLink(strand) || (reviewOf(strand) && !tabOf(strand))) return undefined;
  return goTarget(strand, strands, env) || openTab(strand, env) ? undefined : unhousedStory(strand, strands, env);
}

export function pickupOffer(strand: StrandView, strands: StrandView[], env: Record<string, string | undefined> = process.env): Pickup | undefined {
  if (mentionLink(strand) || (reviewOf(strand) && !tabOf(strand)) || unhousedStory(strand, strands, env)) return undefined;
  return goTarget(strand, strands, env) || openTab(strand, env) ? undefined : pickup(strand, env);
}

export async function makeStoryDir(story: string, command: string[] | undefined = storyCommand(story), env = process.env, control?: Control): Promise<string> {
  const socket = env.KOMUX_SOCKET;
  if (!socket) throw new Error("making a story directory works from inside komux");
  if (!command) throw new Error("set stories.newCommand in ponpoko's config to make story directories");
  const send = control ?? ((request: unknown) => sendKomux(socket, request));
  const made = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([made.exited, new Response(made.stdout).text(), new Response(made.stderr).text()]);
  if (code !== 0) throw new Error(`${command[0]}: ${err.trim() || out.trim() || `exit ${code}`}`);
  forgetProjects();
  const project = projectNamed(story, await loadProjects(env));
  if (!project) throw new Error(`${command.join(" ")} ran, but komux has no project named ${story}; check projects.roots in komux's config`);
  const opened = await send({ method: "project.open", params: { target: project.dir } });
  if (!opened.ok) throw new Error(opened.error ?? "komux refused");
  return project.dir;
}

export function canMakeStoryDir(story: string): boolean {
  return storyCommand(story) !== undefined;
}

export function claudeCommand(env: Record<string, string | undefined> = process.env): string[] {
  const words = (env.PONPOKO_CLAUDE ?? "").trim().split(/\s+/).filter((word) => word !== "");
  return words.length > 0 ? words : ["komux", "claude"];
}

export function brief(strand: StrandView): string {
  const path = strand.path.join(" › ");
  const moves = strand.recent.map((move) => `- ${move.player === "you" ? "you" : move.by.who}: ${move.what}${move.links.map((link) => ` (${link.adapter} ${link.ref})`).join("")}`);
  const links = strand.links.filter((link) => link.adapter !== "dir" && !isBookkeeping(link)).map((link) => `- ${link.adapter} ${link.ref}`);
  return [
    `You're picking up the strand "${path}" in ponpoko${strand.title ? `: ${strand.title}` : ""}.`,
    ...(moves.length > 0 ? ["", "Its moves so far, oldest first:", ...moves] : []),
    ...(links.length > 0 ? ["", "It links to:", ...links] : []),
    ...strand.notes.map((note) => `Note: ${note.text}`),
    "",
    `Call ponpoko's status tool with strand "${path}" as you start, then carry on from where the work stopped. Ask me before doing anything the moves don't make clear.`,
  ].join("\n");
}

export async function pickUpInKomux(strand: StrandView, how: "resume" | "fresh", env = process.env, control?: Control): Promise<void> {
  const socket = env.KOMUX_SOCKET;
  if (!socket) throw new Error("picking a strand up works from inside komux");
  const send = control ?? ((request: unknown) => sendKomux(socket, request));
  await loadProjects(env).catch(() => undefined);
  const options = how === "fresh" ? startsAt(strand, env) : pickup(strand, env);
  const resume = how === "resume" ? options?.resume : undefined;
  if (how === "resume" && !resume) throw new Error("no Claude on this strand to resume");
  const dir = resume?.dir ?? options?.dir;
  if (!dir) throw new Error("ponpoko doesn't know where this strand lives");
  const docked = await send({ method: "claude.start", params: { target: dir, ...layoutAt(tabOf(strand), dir), ...(resume ? { resume: resume.session } : { prompt: brief(strand) }) } });
  if (docked.ok) return;
  if (!/^(busy|none):/.test(docked.error ?? "")) throw new Error(`komux refused: ${docked.error ?? "no reason"}; it may need restarting to start Claude for ponpoko`);
  const command = [...claudeCommand(env), ...(resume ? ["--resume", resume.session] : ["--prompt", brief(strand)])];
  const pane = await send({ method: "pane.open", params: { command, cwd: dir, placement: "right", name: "claude" } });
  if (!pane.ok) throw new Error(`komux refused: ${pane.error ?? "no reason"}`);
}
