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

We keep trusting git-committed manifest ids, and we make relocation an explicit, guarded verb. `AgentRegistry` stays a pure DB adapter whose `upsert` never moves a row on an id conflict — it returns a `'duplicate-id'` result, evaluated **before any mutation**, so a refused registration also never fires the delete-the-path-incumbent branch (the ordering that would otherwise let a branch switch destroy a registered agent and register nothing). The discovery layer resolves the conflict by reading the incumbent path's manifest with errno discipline: `ENOENT`/`ENOTDIR` or a different id there means the path gave the manifest up — a true relocation, performed via an explicit `relocate` call; the same id still readable there means the newcomer is a duplicate and never registers; **any other read failure means refuse and change nothing**, because treating a transient `EACCES`/`EIO` as "gone" would transfer the identity irreversibly. Refusals are visible: one aggregated structured warning per id per scan, naming every rejected path. A directory that contains a manifest is never surfaced as a new-agent candidate — the Register affordance would mint a fresh ULID and overwrite the git-tracked manifest — so making a clone its own agent stays a deliberate re-init, never a scan-surface click.

## Consequences

### Positive

- A copied or worktree checkout can no longer steal a live agent's identity, and the failure mode changes from silent oscillation to one visible aggregated warning.
- A user who genuinely moves an agent's directory keeps working, including the edge where a worktree outlives its deleted primary checkout — no special-casing of worktrees, and a transient filesystem error can never hand the identity over.
- Blast radius is two mesh-layer seams (`upsert`'s contract plus the discovery-side check); relay subjects, tasks, a2a, and all path-keyed room identity are untouched, and the registry stays synchronous and I/O-free.

### Negative

- The conflict check reads the incumbent's manifest from disk at registration time — a small I/O cost on every id-conflicting registration.
- Duplicate checkouts remain unregistered and invisible to the candidate surface; someone who wants a clone to be its own agent must re-init its identity deliberately (remove or regenerate the manifest).
- `syncFromDisk` and every registration caller must handle a refusal result honestly — the "found and synced" contract gains a third outcome.
