import type { MoveView, PlayerView, StrandView } from "../core.ts";
import { sendKomux } from "./stream.ts";
import { komuxPlace } from "./translate.ts";

export type Control = (request: unknown) => Promise<{ ok: boolean; error?: string }>;

export async function goInKomux(strand: StrandView, env = process.env, control?: Control): Promise<"focused" | "opened"> {
  const socket = env.KOMUX_SOCKET;
  if (!socket) throw new Error("go works from inside komux");
  const send = control ?? ((request: unknown) => sendKomux(socket, request));
  const target = goTarget(strand);
  const place = target ? komuxPlace(target.player) : undefined;
  if (target && place && target.player.live && place.session === env.KOMUX_SESSION && place.server === env.KOMUX_SERVER_ID) {
    const tab = target.player.kind === "agent" && !needsYou(strand, target.move) ? await send({ method: "tab.focus", params: { tabId: place.tabId } }) : undefined;
    if (tab?.ok) return "focused";
    const focused = await send({ method: "pane.focus", params: { paneId: place.paneId } });
    if (!focused.ok) throw new Error(focused.error ?? "komux refused");
    return "focused";
  }
  const dir = strand.dir ?? lastDir(strand);
  if (!dir) throw new Error("ponpoko doesn't know where this strand lives");
  const opened = await send({ method: "project.open", params: { target: dir } });
  if (!opened.ok) throw new Error(opened.error ?? "komux refused");
  return "opened";
}

export function goTarget(strand: StrandView): { player: PlayerView; move: MoveView } | undefined {
  for (const move of strand.open) {
    const player = move.answers ?? move.by;
    if (player.live && komuxPlace(player)) return { player, move };
  }
  return undefined;
}

function lastDir(strand: StrandView): string | undefined {
  for (const move of [...strand.recent].reverse()) {
    const dir = komuxPlace(move.answers ?? move.by)?.dir;
    if (dir) return dir;
  }
  return undefined;
}

function needsYou(strand: StrandView, move: MoveView): boolean {
  return move.player === "you" && (move.what === "asking you" || move.what === "waiting on you" || strand.unseen);
}
