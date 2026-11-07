import type { StrandView } from "../core.ts";
import { sendKomux } from "./stream.ts";
import { komuxPlace } from "./translate.ts";

export type Control = (request: unknown) => Promise<{ ok: boolean; error?: string }>;

export async function goInKomux(strand: StrandView, braidDir: string | undefined, env = process.env, control?: Control): Promise<"focused" | "opened"> {
  const socket = env.KOMUX_SOCKET;
  if (!socket) throw new Error("go works from inside komux");
  const send = control ?? ((request: unknown) => sendKomux(socket, request));
  const place = komuxPlace(strand);
  if (place && strand.live && place.session === env.KOMUX_SESSION && place.server === env.KOMUX_SERVER_ID) {
    const focused = await send({ method: "pane.focus", params: { paneId: place.paneId } });
    if (!focused.ok) throw new Error(focused.error ?? "komux refused");
    return "focused";
  }
  const dir = strand.place?.dir ?? braidDir;
  if (!dir) throw new Error("ponpoko doesn't know where this strand lives");
  const opened = await send({ method: "project.open", params: { target: dir } });
  if (!opened.ok) throw new Error(opened.error ?? "komux refused");
  return "opened";
}
