---
description: The /flow engine — one PM-agnostic workflow from capture to done. Routes to a stage, advances a work item, or (P2) drives the autonomous loop.
category: flow
allowed-tools: Read, Glob, Grep, SlashCommand, Task, TaskList, TaskGet, AskUserQuestion
argument-hint: '[stage | work-item | auto]'
---

# /flow — the workflow engine

One canonical stage model, run two ways: manually via these commands, or
autonomously through a PM tool. Resolve and route: $ARGUMENTS

## Stage model (command ↔ stage)

| Stage     | Command           | Skill               |
| --------- | ----------------- | ------------------- |
| CAPTURE   | `/flow:capture`   | `capturing-work`    |
| TRIAGE    | `/flow:triage`    | `triaging-work`     |
| IDEATE    | `/flow:ideate`    | `ideating-features` |
| SPECIFY   | `/flow:specify`   | `specifying-work`   |
| DECOMPOSE | `/flow:decompose` | `decomposing-work`  |
| EXECUTE   | `/flow:execute`   | `executing-specs`   |
| VERIFY    | `/flow:verify`    | `verifying-work`    |
| REVIEW    | — (human gate)    | —                   |
| DONE      | `/flow:done`      | `closing-work`      |

All tracker I/O routes through the `linear-adapter` skill.

## Routing

- **A stage name** (e.g. `/flow specify`) → invoke that stage's `/flow:<stage>` command.
- **A work item or spec path** → determine its current stage from its `stage/*`
  label (via `linear-adapter`) or its spec artifacts, then advance one stage.
- **`auto`** → drain the ready queue autonomously to the human-review gate.
  _(Lands in P2: `/flow auto` + the Pulse-seated loop. Until then, advance manually.)_

Choose the next action and invoke the matching `/flow:<stage>` command; when the
stage is ambiguous, ask.
