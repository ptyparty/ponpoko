# ponpoko

Keeps track of whose move each line of your work is: yours, an agent's, or someone else's, such as a reviewer or CI.

Work is a tree of **strands**. A project holds stories, a story holds smaller strands, and any strand can split further. **Players** make **moves** on strands: you, Claude agents, failed jobs, and the people and machines you wait on. ponpoko hears komux, so while an agent works the move is the agent's, and when its turn ends a move opens for you. Agents report the rest through ponpoko's MCP: which strand they're on and what they're doing, what they're waiting on, and when a strand is done. A strand's moves stay as its record, so whoever picks it up next sees what was done.

```
ponpoko                  the command tab: every strand, whose move it is, and what ponpoko heard
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

Give a komux layout `labels: { strand: "sc-{story}" }` so agents in its tabs work on that strand. An agent elsewhere gets a loose strand of its own once it takes a turn, until it names a strand or you point its directory at one. A Claude you never prompt doesn't show up.

## In komux

- The tray shows how many moves are yours and how long the oldest has waited. Click it to open the command tab.
- **Alt m** deals your moves as a short list: anything a Claude is asking you first, then the newest, with Claudes only ready for a prompt last. Beside them, on the right when the popup is wide enough, it lists the strands agents are working, those waiting on others, and those snoozed; Tab, `h`/`l` or the arrow keys move between the two sides, and Enter goes to any of them. The picked card shows the strand's whole path, and the tree of strands under it with how each stands. `j`/`k` or `1`–`9` pick a card, Enter goes to it, `f` starts a fresh Claude on it, `d` marks it done, `z` snoozes it, `x` forgets it.
- **Ctrl Space m t** opens the deck on the current tab's strands: the tab's own strand and any strand an agent in it is on, each with the strands under it. Besides the deck's keys, `a` adds a strand under the picked one, `n` adds a note, `m` moves it under another strand and `r` renames it and `t` titles it; these work in the main deck too.
- **Alt shift m** deals what changed since you last caught up.
- **Ctrl Space m** opens ponpoko's mode: `m` and `M` deal the same way, and `o` opens the command tab.

Pass `ponpoko({ deal, catchUp, leader })` to pick other keys.

In the command tab, `j`/`k` move between strands, Enter goes to a strand, space shows its moves, `a` adds a strand under it, `m` moves it under another, `d` marks it done, `o` opens what its latest move links to (a notebook page in quoll), `z` snoozes (`t` then types a time such as `14:30`, `mon 9`, `2h` or `nov 12`, and `u` snoozes it till it moves again, such as when you prompt its Claude, or a strand right under it is done), `n` adds a note, `x` forgets it, `p` points its directory at a strand, `c` marks it caught up, `?` lists the keys and glyphs, and `q` quits.

Enter on a strand no one is on offers to resume the last Claude that worked on it, or to start a fresh one briefed with the strand's moves and links. Either way it opens the strand's project with its layout and wakes the Claude docked there. Only when that Claude is busy, or the layout has none, does it open a pane running `komux claude`; set `PONPOKO_CLAUDE` in komux's `env`, such as `komux claude --mode auto`, to run something else.

A strand ponpoko has no tab or directory for goes to the place of the nearest strand above it that has one, opened with that strand's layout.

When the tab a strand lives in already has a Claude in it, such as a story's Claude when you pick one of the story's smaller strands, Enter goes to that Claude instead of offering a new one. `f` starts a fresh Claude on a strand whenever you want one anyway, in the deck or the command tab.

Glyphs: ● yours, ◐ an agent's, ⊘ waiting on someone or something, ◷ snoozed, ○ nothing to do.

## Where things live

The service listens on `$XDG_RUNTIME_DIR/ponpoko/ponpoko.sock` and keeps its facts in SQLite under `$XDG_STATE_HOME/ponpoko/`.

## Development

```
bun test
bun check
```
