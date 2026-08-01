---
id: 260801-003050
title: A duplicate manifest never registers — relocation requires the incumbent path to give the manifest up
status: proposed
created: 2026-08-01
spec: mesh-identity-integrity
superseded-by: null
---

# 260801-003050. A duplicate manifest never registers — relocation requires the incumbent path to give the manifest up

## Status

Proposed

## Context

`.dork/agent.json` is git-tracked, so every clone and linked worktree of an agent's repo carries the same manifest ULID — on the DorkOS machine, ten checkouts share one id. `AgentRegistry.upsert` resolved an id conflict by rewriting `projectPath` to the newcomer, so the last directory a scan visited silently became the agent: its `@handle` stopped resolving, `responseMode` fell back to `'always'`, and room membership 404'd, flipping back on the next scan (DOR-790). The alternative fix — minting ids machine-locally instead of trusting committed manifests — was rejected: the ULID is load-bearing for relay routing subjects, `tasks.agent_id`, `a2a.agent_id`, and persisted bindings, so re-minting is a migration program, not a fix.

## Decision

We keep trusting git-committed manifest ids, and we make relocation conditional: a registration carrying an already-registered id from a different path succeeds only if the incumbent path no longer holds a readable manifest with that id. While it does, the newcomer is a duplicate — it never registers, never moves the row, and the refusal is a damped structured warning, not an exception. When the incumbent manifest is gone, the move is a true relocation and proceeds with a log line. Scanner traversal is sorted so the same disk always yields the same outcome.

## Consequences

### Positive

- A copied or worktree checkout can no longer steal a live agent's identity, and the failure mode changes from silent oscillation to one visible warning.
- A user who genuinely moves an agent's directory keeps working, including the edge where a worktree outlives its deleted primary checkout — no special-casing of worktrees.
- Blast radius is two mesh-layer seams; relay subjects, tasks, a2a, and all path-keyed room identity are untouched.

### Negative

- The conflict check reads the incumbent's manifest from disk at registration time — a small I/O cost on every id-conflicting upsert, and a stale-read window if the manifest is being edited concurrently.
- Duplicate checkouts remain unregistered rather than becoming distinct agents; someone who _wants_ a clone to be its own agent must re-init its identity deliberately.
