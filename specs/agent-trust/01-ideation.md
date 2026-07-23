# Ideation: Agent Trust

- **Slug:** agent-trust
- **Date:** 2026-07-23
- **Tracker:** DOR-428 (project: Agents as First-Class Operators, phase 3)

## Intent

Phase 3 of the agents-as-operators program: agents that can do anything a user can do need a trust model that mirrors the user's, plus sharper gates on destructive and self-modifying operations. Today an agent authenticates exactly like the human (no attribution, no capping), tier declarations on capabilities are inert metadata, approvals exist only as the marketplace's bespoke confirmation-token flow, and the destructive-scenario evals cannot run with full OS isolation.

## Ideation of record

`research/20260722_agents-as-first-class-operators.md` §3 Pillar 4 (governance: least-privilege identity, destructive-op gating, audit, the Notion "every run logged, visible, reversible" bar) and §4 (testing: Docker isolation tier). Prior art: the `isSystem` protection pattern, the marketplace confirmation-token trust boundary, ActivityService as audit sink, ADR 260723-050220 (the invoke endpoint as the enforcement choke point), the eval-harness spec's planned-but-unbuilt `docker` isolation tier and Phase-5 CI cadence (DOR-357).

## Decisions carried into SPECIFY

1. Tier enforcement lands at the capability choke points (invoke endpoint + both MCP registrations), reading the registry's existing tier declarations; routes are untouched in phase 3.
2. The approval primitive generalizes the marketplace confirmation-token flow into a core service; marketplace migrates onto it rather than keeping a parallel bespoke flow.
3. Agent identity is a per-agent scoped token minted by DorkOS, delivered to spawned sessions through the runtime env seam, attributing Activity events; the human's credentials remain the transport auth (identity ≠ transport auth in phase 3 — enforcement of per-agent capability ceilings is declared but applied only at the choke points).
4. The Docker eval tier reuses the `smoke:docker` substrate per the eval-harness spec; eval CI cadence is label-gated smoke per-PR + nightly full, per that spec's Phase 5.
