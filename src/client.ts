import type { Snapshot } from "./core.ts";
import { socketPath } from "./paths.ts";
import type { Request, Response } from "./server.ts";

export class Down extends Error {}

export async function ask(request: Request, timeoutMs = 3000): Promise<unknown> {
  const response = await new Promise<Response>((resolve, reject) => {
    let received = "";
    const timer = setTimeout(() => reject(new Down("ponpoko did not answer")), timeoutMs);
    Bun.connect({
      unix: socketPath(),
      socket: {
        open: (socket) => void socket.write(`${JSON.stringify(request)}\n`),
        data(socket, data) {
          received += data.toString();
          const newline = received.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timer);
          socket.end();
          resolve(JSON.parse(received.slice(0, newline)) as Response);
        },
        error(_socket, error) {
          clearTimeout(timer);
          reject(new Down(error.message));
        },
      },
    }).catch((error: Error) => {
      clearTimeout(timer);
      reject(new Down(`ponpoko isn't running (${error.message})`));
    });
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
