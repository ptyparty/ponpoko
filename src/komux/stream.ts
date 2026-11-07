import { z } from "zod";

const tab = z.object({
  id: z.number(),
  number: z.number().optional(),
  name: z.string(),
  dir: z.string(),
  labels: z.record(z.string(), z.string()).optional(),
  layout: z.string().optional(),
  args: z.record(z.string(), z.string()).optional(),
});
const agent = z.object({ paneId: z.number(), tabId: z.number(), state: z.string(), asking: z.boolean().optional(), name: z.string().optional(), sessionId: z.string().optional() });
const job = z.object({ id: z.number(), tabId: z.number(), name: z.string(), state: z.string(), code: z.number().nullable().optional(), agent: z.boolean().optional() });
const toast = z.object({ kind: z.string(), id: z.number(), tabId: z.number() });
const envelope = { session: z.string(), server: z.string().default("unknown"), at: z.number().optional() };

export const komuxLine = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("snapshot"), tabs: z.array(tab), agents: z.array(agent), jobs: z.array(job), toasts: z.array(toast).default([]) }),
  z.object({ ...envelope, type: z.literal("tab.opened"), tab }),
  z.object({ ...envelope, type: z.literal("tab.changed"), tab }),
  z.object({ ...envelope, type: z.literal("tab.closed"), tabId: z.number() }),
  z.object({ ...envelope, type: z.literal("focus"), tabId: z.number(), paneId: z.number() }),
  z.object({ ...envelope, type: z.literal("agent.state"), agent }),
  z.object({ ...envelope, type: z.literal("agent.gone"), paneId: z.number(), tabId: z.number() }),
  z.object({ ...envelope, type: z.literal("job.started"), job }),
  z.object({ ...envelope, type: z.literal("job.finished"), job }),
  z.object({ ...envelope, type: z.literal("job.closed"), jobId: z.number(), tabId: z.number() }),
  z.object({ ...envelope, type: z.literal("toast.shown"), toast }),
  z.object({ ...envelope, type: z.literal("toast.dismissed"), toast }),
]);

export type KomuxLine = z.infer<typeof komuxLine>;
export type KomuxTab = z.infer<typeof tab>;
export type KomuxAgent = z.infer<typeof agent>;
export type KomuxJob = z.infer<typeof job>;

export function subscribe(path: string, onLine: (line: KomuxLine) => void, onClose: () => void): Promise<{ close: () => void }> {
  let buffer = "";
  return Bun.connect({
    unix: path,
    socket: {
      data(_socket, data) {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const text of lines) {
          if (text.trim() === "") continue;
          try {
            const parsed = komuxLine.safeParse(JSON.parse(text));
            if (parsed.success) onLine(parsed.data);
          } catch {}
        }
      },
      close: () => onClose(),
      error: () => onClose(),
    },
  }).then((socket) => ({ close: () => socket.end() }));
}

export async function sendKomux(path: string, request: unknown, timeoutMs = 3000): Promise<{ ok: boolean; error?: string; result?: unknown }> {
  return new Promise((resolve) => {
    let received = "";
    const timer = setTimeout(() => resolve({ ok: false, error: "komux did not answer" }), timeoutMs);
    Bun.connect({
      unix: path,
      socket: {
        open: (socket) => void socket.write(`${JSON.stringify(request)}\n`),
        data(socket, data) {
          received += data.toString();
          const newline = received.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timer);
          socket.end();
          resolve(JSON.parse(received.slice(0, newline)));
        },
        error(_socket, error) {
          clearTimeout(timer);
          resolve({ ok: false, error: error.message });
        },
      },
    }).catch((error: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
  });
}
