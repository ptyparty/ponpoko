---
name: ponpoko
description: Tells ponpoko, the user's tracker of whose move each strand of work is, what komux can't see — which strand you're working on and what you're doing on it, that you're waiting on a person, on Copilot or CI, or on the user for a live test, that a strand is done or splits into smaller ones — and answers "what should I be doing?" from the strands waiting on the user. Use when you start or switch work, hand work to someone or something other than the user and stop, when that wait ends, when you finish a piece of work or break one up, and when the user asks what needs them, what's waiting, or what changed.
---

# Reporting to ponpoko

ponpoko tracks the user's work as **strands**, lines of work that nest: a project holds stories, and a story holds smaller strands. Each strand is named by its path, such as `ptyparty › ponpoko › review findings › 4`. ponpoko already hears komux: while you work the move is yours, and when your turn ends it's the user's. Tell it what it can't see, through the ponpoko MCP tools.

## When to report

- **You start on a piece of work, or switch to another:** call `status` with `text`, one line on what you're doing now, and `strand` set to its path, plus the notebook page with the detail if there is one. A path resolves near the strand you're on first, so `review findings › 4` finds the one in your project. A path that matches nothing is made under the strand you're on; start it with `›`, as in `› sc-1250`, to make it at the top. Add `title` to give the strand a longer title, such as the story's full name, or to change the one it has.
- **You move between steps:** call `status` again, leaving `strand` out. Each call is a move in the strand's record, so keep them to real steps, not every edit.
- **You open a pull request for the strand, or push to one:** call `status` with `pr` set to its URL. ponpoko then watches its reviews: the strand waits on Copilot, the requested reviewers or the team while a review is pending, and comes back to the user when it's approved or gets comments. Don't report those review waits yourself. A story's pull request is also linked without this when its branch names the story, such as `sc-52751/partner-services`.
- **You're waiting on someone or something other than the user:** call `wait` with `who`, `kind` (`machine` or `person`) and `what`:
  - CI or a deploy: `who: "CI"`, `kind: "machine"`
  - a person's answer: `who: "Sam"`, `kind: "person"`
- **The user has to do something komux can't see,** such as test in a browser: call `wait` with `who: "you"`, `kind: "you"` and what they need to do.
- **The wait is over:** call `wait` again with `over: true` and the same `who`; `kind` and `what` can be left out. With only `over: true` and the strand, every wait on someone or something on that strand ends.
- **A build or job you start is for another strand than the one you're on,** such as a child strand's build run from the story's tab: start it as `ponpoko for "<strand path>" -- <command>`, or set `PONPOKO_STRAND` in its environment and run `ponpoko for -- <command>`. While it runs, that strand waits on the job instead of showing as the user's move.
- **A strand can't go on until another strand lands,** such as a story blocked on another story, and the user tells you so: call `wait` with `on` set to the other strand's path, such as `on: "sc-1240"`, and no `who`, `kind` or `what`. The strand waits on it until it's done and then becomes the user's move. If it stops waiting before then, call `wait` with the same `on` and `over: true`. When your turn ends while a wait you reported is open, on a person, a machine or a strand, the strand keeps waiting rather than becoming the user's move.
- **A strand is finished:** call `done`.
- **The work splits,** such as the items of a list in a notebook page: call `split` with `names`, under the strand they belong to. A name can be `{ name, title }` to title its strand.
- **A review is waiting on the user,** such as a repo in the story whose changes they haven't reviewed in remax yet: prepare a named tour of it for later, as `remax guide tour` describes, then call `split` under the strand you're on with `{ name, tour: { repo, name } }`, where `repo` is the checkout you passed to remax with `-C` and `name` is the tour's name. Name the strand for what the user does, such as `review gadgets`, and give it a `title` that says which change it is, such as `review merlin: consolidation toggle`. It becomes the user's move, and going to it from ponpoko opens the tour in the remax in the tab it takes them to. The user marks it done once they've reviewed it, so don't call `done` on it yourself.
- **You've reached critical code mid-work,** such as a new data model, a public interface or a tricky algorithm: bring the user an early look rather than waiting until you're done. Snapshot and tour just those hunks as `remax guide tour` describes under "An early look at critical code", split a strand with the tour as above, and keep working on your own strand while `remax watch` brings their notes in. Don't wait on the review.

**Title every strand you make for the user.** Whenever `status` or `split` makes a strand the user will see, give it a `title` that says what it's about, such as `review merlin: consolidation toggle` or the story's full name. ponpoko's screens lead each row with the nearest title, so a strand named `review merlin` or `PR 3` with no title says nothing about which change it is.

If a path you pass to `done` doesn't exist, ponpoko's error names the nearest strand it knows; check it and call again with that path.

Keep lines short and free of code, customer data and secrets: ponpoko keeps them.

## Answering the user

- "What should I be doing?" or "what needs me?": call `moves` and summarise, oldest first.
- About one story or piece of work: call `strand` with its path, or leave it out for the one you're on.
- "What changed while I was away?": call `changes` with a time.
