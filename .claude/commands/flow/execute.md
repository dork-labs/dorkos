---
description: Run the EXECUTE stage — implement a validated spec by orchestrating concurrent agents
category: flow
allowed-tools: Task, TaskOutput, Read, Write, Edit, Grep, Glob, Bash(jq:*), Bash(grep:*), Bash(cat:*), Bash(echo:*), Bash(date:*), Bash(mkdir:*), Bash(git rev-parse:*), Bash(git branch --show-current:*), Bash(git status:*), EnterWorktree, TaskCreate, TaskList, TaskGet, TaskUpdate, AskUserQuestion
argument-hint: '<path-to-spec-file>'
---

# /flow:execute — EXECUTE stage

Implement the specification at: $ARGUMENTS

Read `.claude/skills/executing-specs/SKILL.md` and follow its process exactly.

The skill uses supporting files in `.claude/skills/executing-specs/` — read them
on demand as instructed by the skill, not upfront.

All tracker I/O (the `agent/claimed` claim, the In Progress transition,
breadcrumbs) routes through the `linear-adapter` skill — this command never
touches a tracker string directly.
