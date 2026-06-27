---
number: 287
title: Composable Reconciler Registry and Scheduler
status: proposed
created: 2026-06-25
spec: flow-triage-feeds-loop
superseded-by: null
---

# 287. Composable Reconciler Registry and Scheduler

## Status

Proposed (extracted from spec: flow-triage-feeds-loop)

## Context

The `/flow` loop is a single monolithic drain that carries one issue vertically through all
stages (the Pulse `flow-drain` prose loop and `/flow auto`), coupling concerns that want
different cadences and priorities (claiming work vs detecting a reply vs recovering a stall
vs hygiene). There is no reconciler registry, no scheduler, and no per-loop config anywhere
in the running system (charter G5, gap). The single-responsibility logic already exists as
pure, tested oracles (`selectDispatch`, `shouldRespondToComment`, `recoverOrphan`,
`evaluateAutoMerge`), but they are invoked ad hoc by prose, not as registered loops.

## Decision

Replace the monolith with a typed **reconciler registry + generic scheduler**. Each
reconciler implements one interface (`id`, `priority`, a config block, `isDue`, `run`), wraps
an existing oracle, and is added or removed by registering or disabling it in a `loops` config
map. The scheduler walks the registry in priority order each tick, runs every enabled and due
reconciler, and resolves same-item contention by priority (recovery before dispatch). v1
lands the typed interface, registry, scheduler, and `loops` config as a tested promotion
surface and rewrites the prose drain to follow the registry order; the unattended runner that
executes it continuously is the P5 server build.

## Consequences

### Positive

- Single-responsibility, idempotent loops with per-loop cadence and priority; pluggable by
  config (add = register, remove = disable), satisfying charter G5.
- The existing oracles become the reconcilers' decision functions; no new decision logic, and
  the registry is the same contract the P5 server promotes unchanged.

### Negative

- A scheduler and registry to build, test, and maintain.
- In v1 the registry is still prose-driven (the LLM follows the order); the true autonomous
  runner is deferred to P5, so the win is structural clarity now, full automation later.
