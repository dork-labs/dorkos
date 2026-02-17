---
description: Implement a validated specification by orchestrating concurrent agents
category: validation
allowed-tools: Task, TaskOutput, Read, Write, Edit, Grep, Glob, Bash(jq:*), Bash(grep:*), Bash(cat:*), Bash(echo:*), Bash(date:*), Bash(mkdir:*), TaskCreate, TaskList, TaskGet, TaskUpdate, AskUserQuestion
argument-hint: '<path-to-spec-file>'
---

# Implement Specification

Implement the specification at: $ARGUMENTS

Read `.claude/skills/executing-specs/SKILL.md` and follow its process exactly.

The skill uses supporting files in `.claude/skills/executing-specs/` — read them on demand as instructed by the skill, not upfront.
