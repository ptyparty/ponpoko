# ponpoko

Keeps track of whose move each line of your work is: yours, an agent's, or someone else's, such as a reviewer or CI.

Work is a tree of **strands**. A project holds stories, a story holds smaller strands, and any strand can split further. **Players** make **moves** on strands: you, Claude agents, failed jobs, and the people and machines you wait on. ponpoko hears komux, so while an agent works the move is the agent's, and when its turn ends a move opens for you. Agents report the rest through ponpoko's MCP: which strand they're on and what they're doing, what they're waiting on, and when a strand is done. A strand's moves stay as its record, so whoever picks it up next sees what was done.

```
ponpoko                  the command tab: a map of the work, the reviews and the mentions
ponpoko tab --reviews    the command tab, starting on Reviews
ponpoko epic ID          an epic's stories as boxes and arrows by what blocks what; --mermaid prints them for a notebook, --refresh brings in what Shortcut has that ponpoko lacks
ponpoko list             your moves, then everything else, printed once
ponpoko tray [--stream]  one line for komux's tray; --stream prints a new one as it changes
ponpoko tray --unreviewed [--stream]
                         the tray's count of team pull requests nobody has reviewed yet
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

Give a komux layout `labels: { strand: "sc-{story}" }` so agents in its tabs work on that strand, once the strand exists. A tab whose label names no strand, or that has no label, makes nothing on its own: a quick look at a repo leaves no trace. Its Claude's turns start counting once it says what it's working on through ponpoko's `status`, which makes the strand if needed, or once you add the strand (`a`) or point the tab's directory at one (`p`). A Claude you never prompt doesn't show up, and a docked Claude that wakes and settles before you've ever prompted it isn't your move, so opening an epic's tab by accident leaves the epic alone.

## In komux

- The tray shows how many moves are yours and how long the oldest has waited. Click it to open the command tab.
- A second tray chip, "to review", shown once `github.reviewQuery` is set in the config, counts the team's pull requests nobody has taken or reviewed yet, green up to 2, yellow from 3, orange from 6 and red from 10. Click it to open the command tab on the reviews.
- **Alt m** opens the deck, the to-do list. Each row leads with the nearest strand above it that has a title, usually the story's, then which strand the move is on, such as "Keep consolidation out of the Agents Directory · PR 3 merlin". Your moves are grouped by what you'll do: "Claude replied: go read it", "review" (a remax tour ready for you, your own pull request approved or with comments, a review or mention that's yours) and "pick up" (no one on it, a strand under it finished, a Claude ready for a prompt), newest first in each. Beside them, on the right when the popup is wide enough, the rest is grouped by who has it: agents (including one waiting on its own build, as "claude · on its build"), your pull requests out for review, people, and machines. Strands that only wait on other strands, and snoozed ones, fold into one line each; Enter or space opens a fold. The review pool stays out of the deck. Tab, `h`/`l` or the arrow keys move between the two sides, and Enter goes to any row. The picked card shows the strand's whole path, and the tree of strands under it with how each stands. `j`/`k` or `1`–`9` pick a card, Enter goes to it, `f` starts a fresh Claude on it, `o` opens its pull request or link, `R` marks its draft pull request ready, `d` marks it done, `z` snoozes it, `x` forgets it.
- **Ctrl Space m t** opens the deck on the current tab's strands: the tab's own strand and any strand an agent in it is on, each with the strands under it. Besides the deck's keys, `a` adds a strand under the picked one, `n` adds a note, `m` moves it under another strand and `r` renames it and `t` titles it; these work in the main deck too.
- **Alt shift m** deals what changed since you last caught up.
- **Ctrl Space m** opens ponpoko's mode: `m` and `M` deal the same way, `o` opens the command tab, and `r` opens it on the reviews.

Pass `ponpoko({ deal, catchUp, leader })` to pick other keys.

The command tab is the map: what's in flight and how it fits together. It has three areas, switched with `1`, `2`, `3` or Tab, and `/` searches names and titles across all three; Enter on a result goes to its row.

- **Work** holds every top-level strand but the reviews and mentions. An epic (a strand Shortcut says is an epic) gets a section with its stories under it; everything else at the top goes under "Other work". Each story is one line: its title, its id, who has it anywhere under it, how long, and its tab. Your moves stand out by their ●, not by moving to the top, so things stay where you left them. A story's own strands stay folded, shown as `▸3` after its tab; space opens them. Stories inside a story show under it. A chain of stories queued behind one another, each waiting on the one before, folds into one "then: … → …" line under the first. Snoozed strands sit at the end of their section. Moving a strand under an epic with `m` moves it on the map too.
- Enter on an epic's header opens its dependency view (also `ponpoko epic sc-52633`): the epic's stories as boxes coloured by state (done, in review or waiting on someone, yours, an agent's, ready to start, not started), laid out left to right by what blocks what, with a key along the top and stories with no dependencies in a row of their own at the end. Arrows show only direct dependencies, where two arrows cross the horizontal one runs straight through, and boxes are ordered to cross as few arrows as possible; the picked story's line below lists all it waits on and unblocks. The arrow keys move between boxes and the view scrolls when it's wider or taller than the screen. Enter goes to the story, `w` makes it wait on another strand, `s` starts a planned one, `o` opens it in Shortcut, `r` refreshes the epic from Shortcut, `m` copies the graph as mermaid, and esc goes back.
- **Reviews** has your own open pull requests and where each stands, then other people's that nobody has reviewed yet (those assigned to you marked ●, internal repos first and public ones folded, newest first), then those already reviewed and still open: waiting on the author after you asked for changes, or approved by someone else.
- **Mentions** lists the mentions waiting on you.

The picked strand's card sits beside the list on a wide screen and below it otherwise. The footer says what Enter does and shows only the keys that apply to the picked row; `?` lists them all. Enter goes to a strand, or on your pull request that's approved, opens it on GitHub to merge. `a` adds a strand under it, `m` moves it under another, `w` makes it wait on another, `d` marks it done, `o` opens its pull request on GitHub, or else what its latest move links to (a notebook page in quoll), `R` marks its draft pull request ready for review, `y` takes a review nobody has, `z` snoozes (`t` then types a time such as `14:30`, `mon 9`, `2h` or `nov 12`, and `0` snoozes it till woken: until it moves again, such as when you prompt its Claude, a strand is added under it, or a strand right under it or one it waits on is done), `n` adds a note, `x` forgets it, `p` points its directory at a strand, `f` starts a fresh Claude, `c` marks it caught up, `l` shows the log, and `q` quits. `m` and `w` show the whole tree to pick from.

Enter on a strand no one is on offers to resume the last Claude that worked on it, or to start a fresh one briefed with the strand's moves and links. Either way it opens the strand's project with its layout and wakes the Claude docked there. Only when that Claude is busy, or the layout has none, does it open a pane running `komux claude`; set `PONPOKO_CLAUDE` in komux's `env`, such as `komux claude --mode auto`, to run something else.

Going to a strand prefers its own tab and place over its parent's. A strand ponpoko has no tab or directory for opens the komux project named like it, such as `~/work/stories/sc-52596` for `sc-52596`, even when no tab for it is open yet; failing that it goes to the place of the nearest strand above it that has one, so a story under an epic opens the story's directory, not the epic's. ponpoko finds the projects from `projects.roots` in komux's config, or from `PONPOKO_PROJECT_ROOTS` (globs separated by `:`) when that's set.

A story with no place of its own (no tab, directory or project, and no Claude of its own except in a directory that belongs to a strand above it) never borrows its epic's place. Going to it, or to a strand under it, says it has no story directory. If `stories.newCommand` in `~/.config/ponpoko/config.json` names a command, `{story}` replaced by the story's name, Enter offers to run it and `y` does, then opens the komux project named for the story:

```json
{ "stories": { "newCommand": ["make-story-dir", "{story}"] } }
```

A build an agent runs from one strand's tab for another strand can say which it's for: `ponpoko for "sc-52734 › consolidation toggle" -- scripts/build`, or `PONPOKO_STRAND` in its environment with `ponpoko for -- scripts/build`. Run as a komux job, it tells ponpoko that job belongs to that strand, so the strand waits on the build ("claude · on its build" in the deck) instead of showing as your move, and the agent stays on its own strand. If ponpoko is down or doesn't know the strand, `ponpoko for` says so and runs the command anyway.

When the tab a strand lives in already has a Claude in it, such as a story's Claude when you pick one of the story's smaller strands, Enter goes to that Claude instead of offering a new one. `f` starts a fresh Claude on a strand whenever you want one anyway, in the deck or the command tab.

## Epics from Shortcut

When ponpoko sees a strand Shortcut says is an epic, the bridge brings in, once, the epic's stories that are ready to be worked on, as strands under it titled from Shortcut, and their "blocks" links as waits between the strands that exist. ponpoko is for executing work that's ready, so a story still being considered, such as one in Backlog or In Review, stays out unless you or an agent make its strand yourselves.

Which stories come in goes by their workflow state in Shortcut: a state whose whole name is one of `shortcut.readyStates` in `~/.config/ponpoko/config.json` (ignoring case; `["Ready", "Ready for Development"]` by default), any started state (such as In Progress or In Development, since that's work being done), and done states, which come in done so the epic view can show them. For example `{ "shortcut": { "readyStates": ["Ready", "On Deck"] } }`. A story that waits on one Shortcut says blocks it, and that blocker isn't in ponpoko yet (not ready, or in another epic), waits on it by name, such as "waiting on sc-52741 (not ready yet)", so it doesn't read as ready to start; the next refresh turns that into a wait on the blocker's strand once it comes in, or ends it once Shortcut has it done. After that ponpoko's own strands and waits are what count. `r` in the epic view, or `ponpoko epic ID --refresh`, brings in again what Shortcut has and ponpoko lacks: missing stories, and blocking links as waits. It never removes a strand or a wait, never brings back a wait you removed or a story you forgot, never changes a done strand beyond adding links, reuses story strands ponpoko already has (moving one under the epic only when it sits at the top), and says what it changed, such as "2 new stories, 5 new dependencies". It also drops stories it brought in earlier that are no longer ready and that nobody has touched: still planned, made by the import, with no moves, notes, strands under them or links of their own. Those are forgotten the usual way, and come back once they're ready. Epics imported under an earlier rule get one such refresh automatically.

A story that comes in from Shortcut is planned until someone takes a turn on it or on a strand under it, or you start it with `s`: it shows on the map, but it's nobody's move, so it stays out of the deck and the yours count. Stories done in Shortcut come in done. Each story links to its Shortcut page.

`ponpoko epic ID --mermaid` prints the epic's stories and dependencies as a mermaid `flowchart LR` block, with a class per state, for a notebook.

## Reviews and mentions from GitHub

`ponpoko komux` asks GitHub through `gh` every two minutes, so `gh` must be logged in. Pull requests that want a review sit under a `reviews` strand, and open pull requests where someone mentioned you and you haven't answered sit under `mentions`.

- A review nobody has taken waits on GitHub and stays out of the deck. Enter on it asks whether to assign yourself first (`y`), or just open it (`o`).
- A review assigned to you, or one asking for your review, is yours. Once you request changes it waits on the author until they push, and approving it finishes it. So does someone else taking it, or the pull request closing.
- Enter on a review opens its repository in komux's `pr-review` layout with the `pr` and `strand` arguments, and goes back to that tab while it's open. Set `PONPOKO_REVIEW_LAYOUT` to use another layout.
- A mention is yours until you reply or react to it. Enter opens it on GitHub.
- Marking a review or mention done keeps it done until it changes: a push, a new request for your review, or a new mention.

### Your own pull requests

ponpoko also watches your own open pull requests, once one is linked to a strand. An agent links it by calling `status` with the pull request's URL, and ponpoko links a story strand by itself to an open pull request of yours whose branch names it, such as `sc-52751/partner-services` for `sc-52751`. A story spanning several repositories can link several.

- While a review is pending, the strand waits on the reviewer: `Copilot · reviewing`, `Sam · reviewing`, or `the team · 0 of 1 reviews` for a ready pull request nobody has reviewed yet. A draft nobody is reviewing waits on no one.
- An approval, changes requested, a reviewer's comments, or Copilot's comments make it your move with what happened: `approved by Sam · merge it`, `Sam requested changes · 3 threads`, `Copilot left 4 comments`.
- Pushing after changes were requested waits on that reviewer again (`Sam · re-review`), and pushing past Copilot's comments, or resolving them, goes back to waiting on the team.
- Once the pull request is merged or closed, its moves end; the strand isn't marked done.
- ponpoko only acts when a pull request's state changes, so moves you or agents make in between stay as they are. When it starts waiting on a reviewer, it closes finished turns on the strand and any wait an agent reported on the same review.

### Configuration

Which pull requests count as waiting for a review comes from `~/.config/ponpoko/config.json` (or the file `PONPOKO_CONFIG` names):

```json
{ "github": { "reviewQuery": "is:open is:pr org:my-org draft:false -label:dependencies", "unreviewed": { "yellow": 3, "orange": 6, "red": 10 } } }
```

Without `reviewQuery`, only reviews assigned to you or requesting you show up, and the "to review" chip isn't shown. `unreviewed` sets the counts at which the chip turns yellow, orange and red. The bridge polling GitHub writes the count to `$XDG_RUNTIME_DIR/ponpoko/unreviewed.json`, and the chip greys out when that's more than ten minutes old. Set `PONPOKO_GITHUB=off` in komux's `env` to stop asking GitHub.

Glyphs: ● yours, ◐ an agent's, ⊘ waiting on someone or something, ◷ snoozed, ○ nothing to do.

## Where things live

The service listens on `$XDG_RUNTIME_DIR/ponpoko/ponpoko.sock` and keeps its facts in SQLite under `$XDG_STATE_HOME/ponpoko/`.

## Development

```
bun test
bun check
```
