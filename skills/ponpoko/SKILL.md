---
name: ponpoko
description: Tells ponpoko, the user's tracker of whose move each piece of work is, what komux can't see — that you're waiting on a person, on Copilot or CI, on another story, or on the user for a live test, and what you're working on now — and answers "what should I be doing?" from its list of moves waiting on the user. Use when you hand work to someone or something other than the user and stop, when that wait ends, when you start a long stretch of work worth a status line, and when the user asks what needs them, what's waiting, or what changed.
---

# Reporting to ponpoko

ponpoko already hears komux: when your turn ends it counts as the user's move, and while you work it's yours. Report only what it can't see, through the ponpoko MCP tools.

## When to report

- **You're waiting on someone or something other than the user.** Call `report` with a strand named for what you wait on, `whose` set to `person` or `machine`, `who` naming them, and a short reason:
  - a Copilot or human review of a PR: strand `PR #821 review`, `whose: "machine"`, `who: "Copilot"`
  - CI or a deploy: strand `CI on PR #821`, `whose: "machine"`, `who: "CI"`
  - another story: strand `blocked on SC-1240`, `whose: "machine"`, `who: "SC-1240"`
  - a person's answer: strand `question for Sam`, `whose: "person"`, `who: "Sam"`
- **The user has to do something komux can't see,** such as test in a browser: report on your own strand (leave `strand` out) with `whose: "you"` and the reason.
- **The wait is over:** report the same strand with `whose: "done"`.
- **You start a long stretch of work:** call `status` with one line on what you're doing now, and the notebook page that holds the detail if there is one. Update it as you move between steps.

Keep reasons short and free of code, customer data and secrets: ponpoko keeps them.

## Answering the user

- "What should I be doing?" or "what needs me?": call `moves` and summarise, oldest first.
- About one story or piece of work: call `braid`.
- "What changed while I was away?": call `changes` with a time.
