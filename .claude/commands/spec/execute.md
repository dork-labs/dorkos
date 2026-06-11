---
description: Implement a validated specification by orchestrating concurrent agents
category: validation
allowed-tools: Task, TaskOutput, Read, Write, Edit, Grep, Glob, Bash(jq:*), Bash(grep:*), Bash(cat:*), Bash(echo:*), Bash(date:*), Bash(mkdir:*), Bash(git rev-parse:*), Bash(git branch --show-current:*), Bash(git status:*), EnterWorktree, TaskCreate, TaskList, TaskGet, TaskUpdate, AskUserQuestion
argument-hint: '<path-to-spec-file>'
---

# Implement Specification

Implement the specification at: $ARGUMENTS

Read `.claude/skills/executing-specs/SKILL.md` and follow its process exactly.

The skill uses supporting files in `.claude/skills/executing-specs/` — read them on demand as instructed by the skill, not upfront.

## Linear Integration (Optional — Spec-Linear Bridge)

Before starting execution, check the spec's `01-ideation.md` or `02-specification.md` frontmatter for a `linear-issue:` field. If present:

1. **At start**: Post a breadcrumb comment to the linked Linear issue:

   ```
   **Spec Progress** — [date]
   **Phase:** Execution Started
   **Spec:** `specs/{slug}/`
   **Document:** `specs/{slug}/02-specification.md`
   **Next:** Implementation in progress — [N] tasks to complete
   ```

2. **At completion** (all tasks done): Post a completion comment and prompt for `/linear:done`:
   ```
   **Spec Progress** — [date]
   **Phase:** Implementation Complete
   **Spec:** `specs/{slug}/`
   **Next:** Run `/linear:done [issue-id]` to close the loop
   ```
   Display to the user: _"Spec complete. Linked to [issue-id]. Run `/linear:done [issue-id]` to close the loop."_

If no `linear-issue:` field exists, or Linear MCP tools are unavailable, skip silently. Linear integration is always optional.
