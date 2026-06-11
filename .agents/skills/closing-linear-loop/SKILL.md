---
name: closing-linear-loop
description: Reports completion on a Linear issue, closes the loop, and checks what should happen next at the project level. Use when the user wants to mark work done, close an issue, or replace the legacy `/linear:done` workflow.
---

# Closing Linear Loop

## Overview

This is the shared-skill replacement for the legacy Claude Code `/linear:done` workflow.

Use it when the user is intentionally declaring that an issue is complete and wants the loop advanced correctly.

## Read First

Before acting, read:

- `.claude/skills/linear-loop/SKILL.md`
- `.claude/skills/linear-loop/config.json`

These define completion routing, loop continuity, project transitions, and the monitor follow-up rules.

## Process

1. Identify the issue to close:
   - use the explicitly provided issue ID when present
   - otherwise infer only from strong local context
   - ask a short bounded question if the target issue is still ambiguous
2. Build a completion summary:
   - what changed
   - relevant files or spec links when applicable
   - any follow-up work or monitor creation
3. Add the completion comment to the issue.
4. Move the issue to Done and update agent-state labels per the loop conventions.
5. Create follow-up monitor work when required by the issue type.
6. Read the issue’s `## On Completion` section when present.
7. Run a project pulse check using the Loop Continuity rules from `linear-loop/SKILL.md`.
8. Clean up the workspace when applicable:
   - if the work ran in a dedicated git worktree (check the spec's `04-implementation.md`, or the current directory) and its branch is merged, offer `/worktree:remove <branch> --delete-branch`
   - if the session is currently inside that worktree (`git rev-parse --git-dir --git-common-dir` prints two different paths), leave it first — ExitWorktree, or return to the main checkout — before removing
9. Report what was closed, what follow-up was created, and what the next recommended loop action is.

## Guardrails

- Do not close an issue casually; this is an intentional workflow.
- Do not skip the project pulse check unless the issue has no project context and no clear parent flow.
- If the issue description contains explicit completion routing, prefer it over generic defaults.
- If Linear tooling is unavailable, explain the limitation clearly.
