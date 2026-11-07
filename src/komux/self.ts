import { komuxHandle } from "./translate.ts";

export function komuxSelf(env: Record<string, string | undefined>): string | undefined {
  const paneId = Number(env.KOMUX_PANE_ID);
  if (!env.KOMUX_SERVER_ID || !env.KOMUX_PANE_ID || !Number.isInteger(paneId)) return undefined;
  return komuxHandle(env.KOMUX_SERVER_ID, paneId);
}
