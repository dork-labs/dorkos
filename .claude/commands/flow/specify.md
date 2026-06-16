---
description: '/flow SPECIFY stage — turn an ideation artifact into a validated specification'
category: workflow
allowed-tools: Read, Grep, Glob, Task, TaskOutput, Write, Edit, AskUserQuestion, Bash(git:*), Bash(node:*), Bash(npx:*), Bash(python3:*), Bash(mkdir:*)
argument-hint: '<path-to-01-ideation.md>'
---

# /flow:specify

SPECIFY the work from the ideation artifact at: $ARGUMENTS

Read `.agents/flow/skills/specifying-work/SKILL.md` and follow its process
exactly. It is the SPECIFY stage of the `/flow` engine (absorbs `/ideate-to-spec`
and `/spec:create`); the next stage is DECOMPOSE (`/flow:decompose`).

The specification and draft-ADR scaffolds are externalized under
`.agents/flow/templates/docs/` — produce those shapes.

When the work is tracked, route every tracker read/write through the
`linear-adapter` skill (`.agents/flow/skills/linear-adapter/SKILL.md`); never
call a tracker directly from this command. If the work is untracked or no
adapter is available, skip tracker projection silently.
