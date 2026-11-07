Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`

## Layout

- `src/events.ts`: the facts ponpoko records. They never change once written, and hold references, not text.
- `src/store.ts`: the SQLite file of facts, in `$XDG_STATE_HOME/ponpoko/`.
- `src/model.ts`: braids and strands, rebuilt by replaying the facts.
- `src/core.ts`: the service, a knowledge base of braids, strands and moves, testable without sockets; `src/server.ts` puts it on `$XDG_RUNTIME_DIR/ponpoko/ponpoko.sock`, and `src/client.ts` talks to it. The service knows nothing of komux: a place is opaque to it beyond its adapter, handle and directory, and it has no idea of going anywhere.
- `src/komux/`: everything komux. `bridge.ts` is `ponpoko komux`, which the komux plugin runs once per session: it reads that session's event stream, turns it into facts through `translate.ts`, tells the service which strands and tabs are open, and sets tab badges. `go.ts` focuses a pane or opens a tab, only ever in the komux session it runs in. `self.ts` gives the MCP the agent's own place handle.
- `src/render.ts`: the rows `ponpoko list` prints and the command tab draws.
- `src/tab.ts`: the command tab. `TabController` holds its keys and state, so it tests without a terminal; `src/screen.ts` is the small raw-terminal layer it draws through.
- `src/deal.ts`: the deck card `ponpoko deal` shows in a komux popup. `Dealer` holds its keys and hand.
- `src/setup.ts`: `ponpoko setup`: the `ponpoko.service` user unit, the komux plugin dropped in `~/.config/komux/plugins/`, the skill link (`src/links.ts` is copied from quoll) and the MCP. It never edits komux's config.
- `src/mcp.ts`: `ponpoko mcp`, the MCP server agents report through (`report`, `status`) and ask (`moves`, `braid`, `changes`). It learns the agent's pane from `KOMUX_SESSION` and `KOMUX_PANE_ID`.
- `skills/ponpoko/`: the agent skill.

## Testing

- Test the service through `Ponpoko` in `src/core.ts` with a `Store(":memory:")`. `src/test-harness.ts` wires a bridge to an in-memory service, so tests can feed it komux lines.
