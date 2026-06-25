---
number: 284
title: The DorkOS server is the workspace port authority (contiguous block allocation)
status: accepted
created: 2026-06-16
spec: workspace-manager
superseded-by: null
---

# 284. The DorkOS server is the workspace port authority (contiguous block allocation)

## Status

Accepted (from spec: workspace-manager, DOR-84; folds in DOR-85)

## Context

Parallel worktrees need collision-free dev ports. The pre-existing flow derives
ports client-side by hashing the branch name (`cksum % 150` in
`.claude/scripts/worktree-setup.sh`), which collides as worktrees multiply
(birthday paradox at ~7–8), papered over by a linear-probe of peer `.env` files.
Port isolation is an unsolved gap across the industry; only Conductor solves it
natively (a contiguous block per workspace injected as env). DorkOS has a
persistent server and the competitors do not — so it can own allocation.

## Decision

The server allocates a **contiguous port block** per workspace from a pool
(`config.workspace.portBase`, step `portBlockSize`, default 4250/10) by reading
the lowest-free base from the workspace cache; disjoint blocks make collisions
**structurally impossible** (no hashing, no probing). The three named dev ports
derive by fixed offset (`DORKOS_PORT = base+0`, `VITE_PORT = base+1`,
`SITE_PORT = base+2`) so the **existing env contract is preserved** — no app
changes. On provisioning, the manager writes the block into the workspace `.env`
(replacing the hash logic for managed workspaces). The hash-mod-150 path in
`worktree-setup.sh` is **retained as the offline fallback** for plain `gtr`
worktrees that are not server-managed: the server is the authority _when present_;
the script never hard-depends on it.

## Consequences

- **Positive:** eliminates the port-collision class for managed workspaces;
  preserves the `DORKOS_PORT`/`VITE_PORT`/`SITE_PORT` contract (zero consumer
  changes); the block leaves room (size 10) for future services; works identically
  for every runtime.
- **Negative / trade-offs:** allocation reads the cache, so it assumes the cache
  is consistent (the reconciler guarantees this); the gtr hash fallback remains a
  second code path until non-managed worktrees are retired. A future change to the
  offset mapping would be a contract change requiring coordination with the apps'
  env reads.
