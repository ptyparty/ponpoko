import { describe, expect, test } from "bun:test";
import type { Socket } from "bun";
import { Ponpoko } from "./core.ts";
import { answering, flush, send } from "./server.ts";
import { Store } from "./store.ts";

function fakeSocket(room: number[]) {
  const written: number[] = [];
  let ended = false;
  const socket = {
    data: { buffer: "", pending: [] as Uint8Array[], ending: false },
    write(chunk: Uint8Array) {
      const take = Math.min(chunk.length, room.shift() ?? chunk.length);
      written.push(...chunk.subarray(0, take));
      return take;
    },
    end() {
      ended = true;
    },
  };
  return { socket: socket as unknown as Socket<typeof socket.data>, text: () => new TextDecoder().decode(new Uint8Array(written)), ended: () => ended };
}

describe("answering over the socket", () => {
  test("sends the rest of a long answer when the socket drains, then closes", () => {
    const { socket, text, ended } = fakeSocket([5, 0, 4]);
    socket.data.ending = true;
    send(socket, "hello wörld and more\n");
    expect(text()).toBe("hello");
    expect(ended()).toBe(false);
    flush(socket);
    expect(text()).toBe("hello");
    flush(socket);
    expect(text()).toBe("hello wö");
    flush(socket);
    expect(text()).toBe("hello wörld and more\n");
    expect(ended()).toBe(true);
  });

  test("keeps a watcher open after writing", () => {
    const { socket, text, ended } = fakeSocket([]);
    send(socket, '{"changed":true}\n');
    expect(text()).toBe('{"changed":true}\n');
    expect(ended()).toBe(false);
  });

  test("answers every request in a chunk before closing, and ignores lines after that", () => {
    const { socket, text, ended } = fakeSocket([]);
    const handlers = answering(new Ponpoko(new Store(":memory:")), new Set());
    handlers.data(socket, '{"method":"add","params":{"name":"one"}}\n{"method":"add","params":{"name":"two"}}\n');
    expect(text().split("\n").filter(Boolean)).toHaveLength(2);
    expect(ended()).toBe(true);
    handlers.data(socket, '{"method":"state"}\n');
    expect(text().split("\n").filter(Boolean)).toHaveLength(2);
  });

  test("a client that half-closes still gets the whole answer before it's closed", () => {
    const { socket, text, ended } = fakeSocket([3, 0, 0]);
    const handlers = answering(new Ponpoko(new Store(":memory:")), new Set());
    handlers.data(socket, '{"method":"changes","params":{"since":0}}\n');
    handlers.end(socket);
    expect(ended()).toBe(false);
    handlers.drain(socket);
    expect(ended()).toBe(true);
    expect(JSON.parse(text())).toMatchObject({ ok: true });
  });
});
