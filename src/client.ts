import type { Snapshot } from "./core.ts";
import { socketPath } from "./paths.ts";
import type { Request, Response } from "./server.ts";

export class Down extends Error {}

export async function ask(request: Request, timeoutMs = 3000): Promise<unknown> {
  const response = await new Promise<Response>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    let connection: { end: () => void } | undefined;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection?.end();
      outcome();
    };
    const timer = setTimeout(() => settle(() => reject(new Down("ponpoko did not answer"))), timeoutMs);
    Bun.connect({
      unix: socketPath(),
      socket: {
        open: (socket) => void socket.write(`${JSON.stringify(request)}\n`),
        data(_socket, data) {
          chunks.push(new Uint8Array(data));
          if (!data.includes(10)) return;
          const received = Buffer.concat(chunks).toString();
          const newline = received.indexOf("\n");
          settle(() => resolve(JSON.parse(received.slice(0, newline)) as Response));
        },
        close: () => settle(() => reject(new Down("ponpoko closed the connection before answering"))),
        error: (_socket, error) => settle(() => reject(new Down(error.message))),
      },
    }).then(
      (socket) => {
        connection = socket;
        if (settled) socket.end();
      },
      (error: Error) => settle(() => reject(new Down(`ponpoko isn't running (${error.message})`))),
    );
  });
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

export async function state(): Promise<Snapshot> {
  return (await ask({ method: "state" })) as Snapshot;
}

export function watch(onChange: () => void, onClose: () => void): Promise<{ close: () => void }> {
  return Bun.connect({
    unix: socketPath(),
    socket: {
      open: (socket) => void socket.write(`${JSON.stringify({ method: "watch" })}\n`),
      data: () => onChange(),
      close: () => onClose(),
      error: () => onClose(),
    },
  }).then((socket) => ({ close: () => socket.end() }));
}
