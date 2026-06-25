---
description: Run the DECOMPOSE stage — break a validated spec into tasks and mirror them into the tracker
category: flow
allowed-tools: Read, Task, TaskOutput, Write, Bash(mkdir:*), Bash(cat:*), Bash(grep:*), Bash(echo:*), Bash(basename:*), Bash(date:*), TaskCreate, TaskList, TaskGet, TaskUpdate
argument-hint: '<path-to-spec-file>'
---

# /flow:decompose — DECOMPOSE stage

Decompose the specification at: $ARGUMENTS

Read `.claude/skills/decomposing-work/SKILL.md` and follow its process exactly.

All tracker I/O (the plan-checklist mirror, the `stage/decompose` transition,
breadcrumbs) routes through the `linear-adapter` skill — this command never
touches a tracker string directly.
