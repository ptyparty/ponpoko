import { describe, expect, test } from "bun:test";
import type { Socket } from "bun";
import { flush, send } from "./server.ts";

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
});
