---
name: ponpoko
description: Tells ponpoko, the user's tracker of what's asked of whom on each strand of work, what komux can't see — what you're doing on your strand, that you need something from a person, CI or the user (a live test), that a strand is done or splits into smaller ones — and answers "what should I be doing?" from the requests waiting on the user. Use when you start work or move between steps, need something from someone other than the user and stop, when that answer comes, when you finish a piece of work or break one up, and when the user asks what needs them, what's waiting, or what changed.
---

# Reporting to ponpoko

ponpoko tracks the user's work as **strands**, lines of work that nest: a project holds stories, and a story holds smaller strands. Each strand is named by its path, such as `ptyparty › ponpoko › review findings › 4`. Whose move a strand is comes from its unanswered **requests**.

ponpoko already hears komux. The user's prompt is a request to you, and your turn end answers it. A turn end whose reply toasts in full asks the user to read it; `KOMUX: BRIEF TOAST` and `KOMUX: NO TOAST` ask nothing. Tell ponpoko only what it can't see, through the ponpoko MCP tools.

## Your strand

You are the agent on one strand: the one your komux tab is on, or the first one you name if your tab has none. You can work on that strand and on any strand under it. Naming a strand outside it is refused, because that work belongs to another Claude. Tell the user and suggest starting a fresh Claude on it from ponpoko. Once your strand is done, the next one you name becomes yours.

## When to report

- **You start on a piece of work, or move between steps:** call `status` with `text`, one line on what you're doing now, plus the notebook page with the detail if there is one. Set `strand` to work on a strand under yours. A path resolves near your strand first, so `review findings › 4` finds the one in your project, and a path that matches nothing is made under your strand. Add `title` to give the strand a longer title, such as the story's full name, or to change the one it has. The line shows while you work, so keep the calls to real steps, not every edit.
- **You open a pull request for the strand, or push to one:** call `status` with `pr` set to its URL. ponpoko then watches its reviews and asks the reviewers and the user what each step needs. Don't report those review waits yourself. A story's pull request is also linked without this when its branch names the story, such as `sc-52751/partner-services`.
- **You need something from someone ponpoko can't see:** call `ask` with `who`, `kind` and `what`:
  - CI or a deploy: `who: "CI"`, `kind: "machine"`
  - a person's answer, such as in Slack: `who: "Sam"`, `kind: "person"`
  - a group: `who: "the team"`, `kind: "group"`
- **The user has to do something komux can't see,** such as test in a browser: call `ask` with `who: "you"`, `kind: "you"` and what they need to do.
- **The answer comes:** call `ask` again with `over: true` and the same `who`; `kind` and `what` can be left out. With only `over: true` and the strand, everything you asked on that strand is answered. What you ask stays open through your turn ends until you, or the user, answer it.
- **A build or job you start is for another strand than the one you're on,** such as a child strand's build run from the story's tab: start it as `ponpoko for "<strand path>" -- <command>`, or set `PONPOKO_STRAND` in its environment and run `ponpoko for -- <command>`. While it runs, it shows on that strand.
- **A strand can't go on until another strand lands,** such as a story blocked on another story, and the user tells you so: call `ask` with `on` set to the other strand's path, such as `on: "sc-1240"`, and no `who`, `kind` or `what`. When that strand is done, ponpoko asks the user to pick this one up. If it stops waiting before then, call `ask` with the same `on` and `over: true`.
- **A strand is finished:** call `done`. Once every strand under a parent is done, ponpoko asks the user to close the parent.
- **The work splits,** such as the items of a list in a notebook page: call `split` with `names`, under the strand they belong to. A name can be `{ name, title }` to title its strand. A split-off strand asks nothing of anyone until someone works on it.
- **A review is waiting on the user,** such as a repo in the story whose changes they haven't reviewed in remax yet: prepare a named tour of it for later, as `remax guide tour` describes, then call `split` under your strand with `{ name, tour: { repo, name } }`, where `repo` is the checkout you passed to remax with `-C` and `name` is the tour's name. Name the strand for what the user does, such as `review gadgets`, and give it a `title` that says which change it is, such as `review merlin: consolidation toggle`. It asks the user to review it, and going to it from ponpoko opens the tour in the remax in the tab it takes them to. The user marks it done once they've reviewed it, so don't call `done` on it yourself.
- **You've reached critical code mid-work,** such as a new data model, a public interface or a tricky algorithm: bring the user an early look rather than waiting until you're done. Snapshot and tour just those hunks as `remax guide tour` describes under "An early look at critical code", split a strand with the tour as above, and keep working on your own strand while `remax watch` brings their notes in. Don't wait on the review.

**Title every strand you make for the user.** Whenever `status` or `split` makes a strand the user will see, give it a `title` that says what it's about, such as `review merlin: consolidation toggle` or the story's full name. ponpoko's screens lead each row with the nearest title, so a strand named `review merlin` or `PR 3` with no title says nothing about which change it is.

If a path you pass to `done` doesn't exist, ponpoko's error names the nearest strand it knows; check it and call again with that path.

Keep lines short and free of code, customer data and secrets: ponpoko keeps them.

## Epics

- To show an epic's stories and what blocks what in a notebook page, run `ponpoko epic sc-1234 --mermaid` and paste its `flowchart LR` block. It reflects ponpoko's strands and waits, which start from Shortcut's "blocks" links and then follow what you and the user record. `ponpoko epic sc-1234 --refresh` first brings in stories and links Shortcut has that ponpoko lacks.
- A story ponpoko brought in from Shortcut is planned, and isn't the user's move until someone works on it; calling `status` on it starts it.

## Answering the user

- "What should I be doing?" or "what needs me?": call `moves` and summarise, oldest first.
- About one story or piece of work: call `strand` with its path, or leave it out for the one you're working on.
- Everything open on a strand and under it, with who asked and since when: call `requests`.
- "What changed while I was away?": call `changes` with a time.
