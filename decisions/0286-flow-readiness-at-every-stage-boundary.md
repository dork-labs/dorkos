---
number: 286
title: Readiness Is Produced at Every Stage Boundary
status: proposed
created: 2026-06-25
spec: flow-triage-feeds-loop
superseded-by: null
---

# 286. Readiness Is Produced at Every Stage Boundary

## Status

Proposed (extracted from spec: flow-triage-feeds-loop)

## Context

The dispatch policy makes the `agent/ready` label an unconditional eligibility requirement
(`packages/flow/src/dispatch.ts:222`), but no stage skill applies it: the `linear-adapter`
asserts "TRIAGE applies `agent/ready`" while `triaging-work` never does. The loop therefore
starves the moment any seeded ready items are consumed (charter G3, gap; live evidence: 34
Triage + 19 Backlog, 0 in flight). `selectDispatch` also returns a bare `[]` with no way to
distinguish "queue genuinely done" from "starved with shapeable work behind the gate."

## Decision

Every shaping stage applies the readiness marker its successor needs: `triaging-work`
applies `agent/ready` (and the `stage/*` label) on Accept for both routes (simple -> EXECUTE
as a task, complex -> IDEATE), and `decomposing-work` applies it to the execute-ready tasks
it emits; the `linear-adapter` prose is reconciled so its asserted contract is fulfilled. A
typed `classifyDispatchOutcome` returns `{ picked, eligibleCount, starved, shapeableCount }`
and is wired into every mode so an empty-but-shapeable queue is surfaced, never silent. Under
the full-autonomy posture (charter G2), readiness is applied to all accepted work;
simple-vs-complex selects the path, not whether readiness is applied.

## Consequences

### Positive

- The loop has fuel produced by the pipeline itself; autonomy stops being starved by design.
- Starvation becomes a visible, actionable state ("0 ready, N shapeable: run a triage pass?")
  rather than a silent stop.

### Negative

- Readiness must be produced consistently at every boundary; a stage that forgets re-starves
  the loop, so a stage-boundary readiness assertion test is required.
- Applying readiness broadly (not gating on simple-vs-complex) means complex work enters the
  dispatchable set and will hit shaping-stage questions, raising the importance of the
  question-routing path (ADR-0289).
