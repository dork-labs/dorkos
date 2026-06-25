---
description: Run the DONE stage — report completion, close the work item, and check project follow-ups
category: flow
allowed-tools: Read, Grep, Glob, Bash(git rev-parse:*), Bash(git status:*), ExitWorktree, AskUserQuestion
argument-hint: '[issue-id]'
---

# /flow:done — DONE stage

Close the loop for: $ARGUMENTS

Read `.claude/skills/closing-work/SKILL.md` and follow its process exactly.

DONE runs only after the human-review gate (REVIEW) has approved. All tracker I/O
(the completion comment, the Done transition, the `agent/completed` label,
follow-up creation, the project pulse check) routes through the `linear-adapter`
skill — this command never touches a tracker string directly.
