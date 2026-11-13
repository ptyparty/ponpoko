Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`

## Layout

- `src/events.ts`: the facts ponpoko records. They never change once written, and hold references, not text.
- `src/store.ts`: the SQLite file of facts, in `$XDG_STATE_HOME/ponpoko/`.
- `src/model.ts`: strands (a tree of lines of work), players, the moves players make on strands, and links, rebuilt by replaying the facts. Whose move a strand is comes from its open moves, rolled up to the strands above.
- `src/core.ts`: the service, a knowledge base of strands, players and moves, testable without sockets; `src/server.ts` puts it on `$XDG_RUNTIME_DIR/ponpoko/ponpoko.sock`, and `src/client.ts` talks to it. The service knows nothing of komux: a place is opaque to it beyond its adapter, handle and directory, and it has no idea of going anywhere.
- `src/komux/`: everything komux. `bridge.ts` is `ponpoko komux`, which the komux plugin runs once per session: it reads that session's event stream, turns agent turns and failed jobs into moves through `translate.ts`, tells the service which players and tabs are present, sets tab badges, and titles `sc-*` strands from Shortcut through `src/shortcut.ts`, which reads `SHORTCUT_TOKEN` from komux's environment. `go.ts` focuses a pane or opens a tab, and picks a strand up by resuming or starting a Claude, only ever in the komux session it runs in. `self.ts` gives the MCP the agent's own place handle.
- `src/github.ts`: asks GitHub through `gh` for pull requests waiting for a review and unanswered mentions, and decides each review's state. `src/inbox.ts` turns that into strands under the `reviews` and `mentions` inbox strands (recorded with source `github`, reacting only when a strand's state changes), and the bridge polls it every two minutes, or about 15 seconds after something happens on a review (a turn in its pr-review tab, or the tab closing). Going to a review opens komux's `pr-review` layout by repo.
- `src/remax.ts`: opens the remax tour a strand links to, through `remax do` aimed at the komux tab go landed in.
- `src/render.ts`: the rows `ponpoko list` prints and the command tab draws.
- `src/tab.ts`: the command tab. `TabController` holds its keys and state, so it tests without a terminal; `src/screen.ts` is the small raw-terminal layer it draws through.
- `src/deal.ts`: the deck `ponpoko deal` shows in a komux popup. `Dealer` holds its keys and hand.
- `src/when.ts`: reads a typed snooze time such as `14:30`, `mon 9`, `2h` or `nov 12`.
- `src/setup.ts`: `ponpoko setup`: the `ponpoko.service` user unit, the komux plugin dropped in `~/.config/komux/plugins/`, the skill link (`src/links.ts` is copied from quoll) and the MCP. It never edits komux's config.
- `src/mcp.ts`: `ponpoko mcp`, the MCP server agents report through (`status`, `wait`, `done`, `split`) and ask (`moves`, `strand`, `changes`). It learns the agent's pane from `KOMUX_SESSION` and `KOMUX_PANE_ID`.
- `skills/ponpoko/`: the agent skill.

## Testing

- Test the service through `Ponpoko` in `src/core.ts` with a `Store(":memory:")`. `src/test-harness.ts` wires a bridge to an in-memory service, so tests can feed it komux lines.
