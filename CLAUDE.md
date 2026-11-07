Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`

## Layout

- `src/events.ts`: the facts ponpoko records. They never change once written, and hold references, not text.
- `src/store.ts`: the SQLite file of facts, in `$XDG_STATE_HOME/ponpoko/`.
- `src/model.ts`: braids and strands, rebuilt by replaying the facts.
- `src/komux.ts`: reads komux's event streams and turns what it sees into facts.
- `src/core.ts`: the service's logic, testable without sockets; `src/server.ts` puts it on `$XDG_RUNTIME_DIR/ponpoko/ponpoko.sock`, and `src/client.ts` talks to it.
- `src/render.ts`: the rows `ponpoko list` prints and the command tab draws.

## Testing

- Test the service through `Ponpoko` in `src/core.ts` with a `Store(":memory:")`, feeding it komux lines.
