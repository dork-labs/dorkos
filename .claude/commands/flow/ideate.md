---
description: '/flow IDEATE stage — shape a brief into a structured ideation artifact'
category: workflow
allowed-tools: Read, Grep, Glob, Task, TaskOutput, Write, Edit, AskUserQuestion, Bash(git:*), Bash(npx:*), Bash(python3:*), Bash(mkdir:*)
argument-hint: '<task-brief-or-path-to-notes>'
---

# /flow:ideate

IDEATE the work described by: $ARGUMENTS

Read `.claude/skills/ideating-features/SKILL.md` and follow its process exactly.
It is the IDEATE stage of the `/flow` engine; the next stage is SPECIFY
(`/flow:specify`).

The ideation document scaffold is externalized at
`.agents/flow/templates/docs/ideation.md` — produce that shape.

When the work is tracked, route every tracker read/write through the
`linear-adapter` skill (`.agents/flow/skills/linear-adapter/SKILL.md`); never
call a tracker directly from this command. If the work is untracked or no
adapter is available, skip tracker projection silently.
