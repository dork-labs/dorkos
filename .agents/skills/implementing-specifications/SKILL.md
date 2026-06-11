---
name: implementing-specifications
description: Implements a validated specification, keeps execution progress durable, and advances linked project work cleanly. Use when the user wants to execute a spec or replace the legacy `/spec:execute` workflow.
---

# Implementing Specifications

## Overview

This is the shared-skill replacement for the legacy Claude Code `/spec:execute` workflow.

Use it when a specification is already validated and the next job is disciplined implementation.

## Read First

Before acting, read:

- `.claude/skills/executing-specs/SKILL.md`

Load supporting files from `.claude/skills/executing-specs/` only on demand.

## Core Workflow

1. **Validate inputs**
   - confirm the specification exists
   - identify the feature slug
   - confirm task decomposition exists
2. **Choose a workspace**
   - if `git rev-parse --git-dir --git-common-dir` prints two different paths, the session is already in a secondary worktree — proceed in place
   - otherwise, when the checkout is shared with other active work (dirty tree, unrelated branch, another agent or session), offer an isolated git worktree before changing code
   - in this repo: `/worktree:create spec-<slug>` provisions dependencies and ports, and the EnterWorktree tool switches the session into it; where those are unavailable, plain `git worktree add` preserves the same discipline
   - record the worktree path in the implementation tracking file so completion can offer cleanup
3. **Scaffold or resume implementation tracking**
   - create or update `04-implementation.md`
   - persist progress incrementally, not only at the end
4. **Review the execution plan**
   - determine completed, in-progress, and pending work
   - identify dependency-aware batches or a safe sequential order
5. **Execute implementation**
   - if parallel agent work is explicitly requested and supported, use it carefully
   - otherwise execute sequentially
6. **Review outcomes**
   - check task completeness against the spec
   - check code quality after correctness
7. **Persist progress after each meaningful unit**
   - completed tasks
   - files changed
   - known issues
   - session summary
8. **Advance linked workflow**
   - if the spec is linked to a Linear issue, leave progress breadcrumbs when tooling is available
   - recommend the next completion step when implementation finishes

## Portability Rules

- Treat this skill as the portable replacement for `/spec:execute`.
- Do not assume task APIs, background agents, or slash commands exist.
- When those capabilities are unavailable, keep the same execution discipline using sequential work and manual progress tracking.
- Preserve the existing DorkOS spec file structure and terminology.

## Verification Rules

- Do not claim completion without running the relevant checks.
- Keep implementation tracking durable across long-running work.
- Prefer spec compliance review before code-style or polish review.
