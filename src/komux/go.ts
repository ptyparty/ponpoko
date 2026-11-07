import { aboveOf, type MoveView, type PlayerView, type StrandView } from "../core.ts";
import { sendKomux } from "./stream.ts";
import { komuxPlace, readKomuxTabRef, type KomuxTabRef } from "./translate.ts";

export type Control = (request: unknown) => Promise<{ ok: boolean; error?: string }>;

export async function goInKomux(strand: StrandView, strands: StrandView[], env = process.env, control?: Control): Promise<"focused" | "opened"> {
  const socket = env.KOMUX_SOCKET;
  if (!socket) throw new Error("go works from inside komux");
  const send = control ?? ((request: unknown) => sendKomux(socket, request));
  const target = goTarget(strand, strands, env);
  const place = target ? komuxPlace(target.player) : undefined;
  if (target && place && target.player.live && place.session === env.KOMUX_SESSION && place.server === env.KOMUX_SERVER_ID) {
    const tab = target.player.kind === "agent" ? await send({ method: "tab.focus", params: { tabId: place.tabId } }) : undefined;
    if (tab?.ok) return "focused";
    const focused = await send({ method: "pane.focus", params: { paneId: place.paneId } });
    if (!focused.ok) throw new Error(focused.error ?? "komux refused");
    return "focused";
  }
  const where = goPlace(strand, aboveOf(strands, strand));
  if (!where) throw new Error("ponpoko doesn't know where this strand lives");
  const opened = await send({ method: "project.open", params: { target: where.dir, ...layoutAt(where.tab, where.dir) } });
  if (!opened.ok) throw new Error(opened.error ?? "komux refused");
  return "opened";
}

export function goTarget(strand: StrandView, strands: StrandView[] = [], env: Record<string, string | undefined> = process.env): { player: PlayerView; move: MoveView } | undefined {
  for (const move of strand.open) {
    const player = move.answers ?? move.by;
    if (player.live && komuxPlace(player)) return { player, move };
  }
  if (strands.length === 0) return undefined;
  const options = pickup(strand);
  const dir = options?.resume?.dir ?? options?.dir ?? goPlace(strand, aboveOf(strands, strand))?.dir;
  return dir ? claudeIn([...aboveOf(strands, strand), ...strands], dir, env) : undefined;
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

export function goPlace(strand: StrandView, above: StrandView[]): { dir: string; tab?: KomuxTabRef } | undefined {
  for (const at of [strand, ...above]) {
    const tab = tabOf(at);
    const dir = tab?.dir ?? at.links.find((link) => link.adapter === "dir")?.ref ?? lastDir(at);
    if (dir) return { dir, ...(tab ? { tab } : {}) };
  }
  return strand.dir ? { dir: strand.dir } : undefined;
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
  return undefined;
}

export type Pickup = { resume?: { session: string; dir: string; who: string; at: number }; dir?: string };

export function pickup(strand: StrandView): Pickup | undefined {
  if (goTarget(strand) || strand.own.whose === undefined) return undefined;
  return startsAt(strand);
}

export function startsAt(strand: StrandView): Pickup | undefined {
  const last = [...strand.recent].reverse().find((move) => {
    const player = move.answers ?? move.by;
    return player.kind === "agent" && player.resume && komuxPlace(player)?.dir;
  });
  const agent = last ? (last.answers ?? last.by) : undefined;
  const place = agent ? komuxPlace(agent) : undefined;
  const resume = last && agent && place ? { session: agent.resume!, dir: place.dir, who: agent.who, at: last.until ?? last.from } : undefined;
  const dir = tabOf(strand)?.dir ?? strand.dir ?? resume?.dir ?? lastDir(strand);
  if (!resume && !dir) return undefined;
  return { ...(resume ? { resume } : {}), ...(dir ? { dir } : {}) };
}

export function pickupOffer(strand: StrandView, strands: StrandView[], env: Record<string, string | undefined> = process.env): Pickup | undefined {
  return goTarget(strand, strands, env) ? undefined : pickup(strand);
}

export function claudeCommand(env: Record<string, string | undefined> = process.env): string[] {
  const words = (env.PONPOKO_CLAUDE ?? "").trim().split(/\s+/).filter((word) => word !== "");
  return words.length > 0 ? words : ["komux", "claude"];
}

export function brief(strand: StrandView): string {
  const path = strand.path.join(" › ");
  const moves = strand.recent.map((move) => `- ${move.player === "you" ? "you" : move.by.who}: ${move.what}${move.links.map((link) => ` (${link.adapter} ${link.ref})`).join("")}`);
  const links = strand.links.filter((link) => link.adapter !== "dir").map((link) => `- ${link.adapter} ${link.ref}`);
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
  const options = how === "fresh" ? startsAt(strand) : pickup(strand);
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
