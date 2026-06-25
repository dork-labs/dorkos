---
number: 283
title: WorkspaceProvider — a hexagonal port for server-managed isolated workspaces
status: accepted
created: 2026-06-16
spec: workspace-manager
superseded-by: null
---

# 283. WorkspaceProvider — a hexagonal port for server-managed isolated workspaces

## Status

Accepted (from spec: workspace-manager, DOR-84)

## Context

DorkOS needed isolated, one-per-unit-of-work checkouts so parallel agent sessions
(across any runtime) don't collide on files. The industry has converged on
home-rooted, unit-of-work-keyed workspaces populated by repo-owned hooks
(`research/20260611_workspace_strategy_runtimes_symphony.md`), and the only
missing DorkOS component was a workspace lifecycle manager. Crucially, the
runtime contract already carries a per-session working directory
(`SessionOpts.cwd` / `MessageOpts.cwd`), so binding a session to a workspace is
just `session.cwd = workspace.path`.

## Decision

Introduce a hexagonal `WorkspaceProvider` **port** (`packages/shared/src/workspace.ts`)
with `create` / `remove` / `isDirty`, mirroring the `AgentRuntime` and `Transport`
idiom: the interface lives in `@dorkos/shared`, implementations
(`worktree`, `clone`; later `container`/`remote`) live in
`apps/server/src/services/workspace/`, and a `WorkspaceManager` service composes a
provider + a port allocator + hooks + file-first persistence. The `Workspace`
entity is persisted **file-first write-through** (ADR-0043): a sidecar
`<key>.workspace.json` manifest is the source of truth, the SQLite `workspaces`
table is a derived cache, a reconciler syncs them. The `AgentRuntime` interface is
**unchanged** — binding is purely via `cwd`. Runtime-native worktree movement
(Claude Code's `EnterWorktree`) is explicitly a **non-goal**: the manager composes
with but never integrates or competes with it; a workspace-bound orchestrated
session treats its bound cwd as authoritative.

## Consequences

- **Positive:** zero `AgentRuntime` change; runtime-agnostic; reuses every
  established pattern (ADR-0043 persistence, `lib/boundary.ts` path safety, the
  config + reconciler idioms); a second provider (`clone`) already proves the
  port; the v2 naming layer (DOR-91) joins via the reserved `hostname`/`url`
  fields without migration; a future Symphony adoption is a config copy (hook
  names/semantics match).
- **Negative / trade-offs:** the dirty-state safety check shells out to git per
  workspace (acceptable at v1 scale); conservative cleanup refuses dirty
  workspaces, which can surprise a user who expects an unconditional delete
  (mitigated by an explicit force-confirm). Runtime-native worktrees remain
  invisible to the manager (Claude bug #36205 — hooks don't fire), reinforcing
  the non-goal.
