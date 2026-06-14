---
number: 280
title: Externalize State and Run a Fresh Session per Issue
status: proposed
created: 2026-06-14
spec: unified-workflow-system
superseded-by: null
---

# 280. Externalize State and Run a Fresh Session per Issue

## Status

Proposed

## Context

Frontier models suffer context rot well before the window fills, and goal fidelity erodes across repeated lossy compactions, so a multi-issue orchestrator that lets one session grow degrades over a long drain.

## Decision

The orchestrator is code with no LLM context. Each issue runs in a fresh `claude` session (a Pulse run) and each stage in a fresh subagent, handed a compact brief (issue AC + ~200-token prior-stage summaries + the one input artifact + pointers); subagents return short summaries then are discarded. Durable memory is externalized (`flow-state.json`, `04-implementation.md`, `execution.log.jsonl`, `flow-history.tsv`) plus the tracker. Per-stage token budgets and a 0.65 effective-window compaction trigger bound each stage; auto-compaction is only a within-stage seatbelt.

## Consequences

### Positive

- Context discipline falls out of the stateless architecture rather than a compaction feature.
- Each issue is independently resumable; the model is amnesiac by design.

### Negative

- Per-issue session spin-up cost.
- Correctness depends on faithful handoff artifacts between stages.
