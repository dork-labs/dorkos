---
name: implementing-specifications
description: Implements a validated specification, keeps execution progress durable, and advances linked project work cleanly. Use when the user wants to implement or execute a validated specification.
---

# Implementing Specifications

## Overview

Disciplined implementation of an already-validated specification: durable progress tracking, dependency-aware ordering, and verification before completion claims. This skill is self-contained and portable across harnesses. When the external `/flow` plugin is loaded, its EXECUTE stage skill supersedes this one.

## Core Workflow

### 1. Validate inputs

- Confirm the spec exists: `specs/<slug>/02-specification.md` (derive `<slug>` from the path)
- Confirm task decomposition exists: `specs/<slug>/03-tasks.json` (or `03-tasks.md`)
- If tasks are missing, stop and decompose the spec into tasks first

### 2. Choose a workspace

- If `git rev-parse --git-dir --git-common-dir` prints two different paths, the session is already in a secondary worktree — proceed in place
- Otherwise, when the checkout is shared with other active work (dirty tree, unrelated branch, another agent or session, a dev server that must stay undisturbed), offer an isolated git worktree before changing code
- In this repo: `/worktree:create spec-<slug>` provisions dependencies and ports, and the EnterWorktree tool switches the session into it; where those are unavailable, plain `git worktree add` preserves the same discipline
- Record the worktree path and branch in `04-implementation.md` so completion can offer cleanup

### 3. Scaffold or resume implementation tracking

`specs/<slug>/04-implementation.md` is the durable execution record. Structure:

- Header: feature name, status (In Progress / Complete), start date, last-updated date, progress count (`Tasks Completed: X / TOTAL`)
- One `### Session N - <date>` section per working session — on resume, find the last session header and append `### Session N+1`
- Per session: **Tasks Completed** (one line per task), **Files Modified/Created** (deduplicated), **Known Issues**

Scaffold this file **before** implementing anything; persist to it incrementally, not only at the end. It is what makes work resumable after interruption or context loss.

### 4. Build the execution plan

- Classify tasks: completed (skip), in-progress (resume), pending
- Group pending tasks into dependency-aware batches: a task joins a batch only when everything it depends on is in an earlier batch; tasks touching the same files never share a batch
- No safe grouping = sequential order

### 5. Execute batch by batch

- Within a batch, tasks may run in parallel where the harness supports parallel agents; otherwise run them sequentially — the batching still gives a safe order
- On a task failure: retry, or skip it and mark dependent tasks blocked, or stop for the user — never silently continue past a failure a later task depends on

### 6. Review per batch (holistic, two stages)

After each batch, review the batch as a whole — batch-level review, not per-task ceremony:

- **Stage 1 — spec compliance:** does the diff implement everything the batch's tasks asked, nothing extra, no misread requirements? Read the actual code; never trust an implementer's report
- **Stage 2 — code quality** (only after Stage 1 passes): project conventions, tests, error handling — in this repo, dispatch per the `requesting-code-review` skill
- Fix Critical/Important findings before starting the next batch

### 7. Persist after every batch

Append the batch's completed tasks, changed files, and known issues to `04-implementation.md` and update the progress count — incremental writes, not an end-of-run summary.

### 8. Finalize

- Set `04-implementation.md` status to Complete; verify the task count matches the total
- Update the spec manifest status (in this repo: `node --experimental-strip-types --disable-warning=ExperimentalWarning .claude/scripts/spec-manifest-ops.ts update-status <slug> implemented --quiet`)
- If the spec is linked to a tracker issue, leave progress breadcrumbs when tooling is available, and recommend the next completion step (commit, PR, docs reconciliation, worktree cleanup after merge)

## Portability Rules

- Do not assume task APIs, background agents, or slash commands exist; when they don't, keep the same discipline with sequential work and manual tracking
- Preserve the existing DorkOS spec file structure and terminology (`01-ideation.md`, `02-specification.md`, `03-tasks.json`, `04-implementation.md`)

## Verification Rules

- Do not claim completion without running the relevant checks (see the `verification-before-completion` skill: full test runs via `pnpm test -- --run`, scoped via `pnpm vitest run <path>`)
- Keep implementation tracking durable across long-running work
- Prefer spec compliance review before code-style or polish review
