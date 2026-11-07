# ponpoko

Keeps track of whose move each piece of your work is: yours, an agent's, or someone else's, such as a reviewer, CI, or another story.

Work is grouped into braids, usually one per story, and each braid holds strands: an agent's pane, a PR review, a question for a colleague. ponpoko hears komux, so while an agent works the move is the agent's, and when its turn ends the move is yours. Agents report the rest through ponpoko's MCP: what they're waiting on, when the wait ends, and what they're doing now.

```
ponpoko                  the command tab: every braid, its strands, and what ponpoko heard
ponpoko list             your moves, then everything else, printed once
ponpoko tray [--stream]  one line for komux's tray; --stream prints a new one as it changes
ponpoko deal [--unseen]  deal your oldest move as a card, for a komux popup
ponpoko serve            run the service (ponpoko.service runs this)
ponpoko setup [--yes]    install the service, komux plugin, skill and MCP
ponpoko mcp              the MCP server Claude Code talks to
ponpoko komux            the komux bridge, run by the komux plugin in each session
```

## Setup

```
bun install
bun link
ponpoko setup --yes
```

`ponpoko setup` lists each piece and whether it's in place: the `ponpoko.service` systemd user unit, the komux plugin in `~/.config/komux/plugins/`, the Claude Code skill, and the MCP. `--yes` installs what's missing, and `--remove` takes it all out again. It never edits komux's config; it prints the two lines to add there:

```ts
import ponpoko from "./plugins/ponpoko.ts";
plugins: [ponpoko()],
```

Give a komux layout `labels: { braid: "sc-{story}" }` so its tabs land in a braid. Agents in other tabs are listed as loose until you point their directory at a braid.

## In komux

- The tray shows how many moves are yours and how long the oldest has waited. Click it to open the command tab.
- **Alt m** deals your oldest move as a card. Enter goes to it, `s` or space skips to the next, `z` snoozes it, `x` forgets it.
- **Alt shift m** deals what changed since you last caught up.
- **Ctrl Space m** opens ponpoko's mode: `m` and `M` deal the same way, and `o` opens the command tab.

Pass `ponpoko({ deal, catchUp, leader })` to pick other keys.

In the command tab, `j`/`k` move between braids and strands, Enter goes to a strand, `o` opens the notebook page an agent's status points at in quoll, `z` snoozes, `n` adds a note to the braid, `x` forgets a strand, `p` points a directory at a braid, `c` marks a braid caught up, `?` lists the keys and glyphs, and `q` quits.

Glyphs: ● yours, ◐ an agent's, ⊘ waiting on someone or something, ◷ snoozed, ○ idle.

## Where things live

The service listens on `$XDG_RUNTIME_DIR/ponpoko/ponpoko.sock` and keeps its facts in SQLite under `$XDG_STATE_HOME/ponpoko/`.

## Development

```
bun test
bun check
```
