---
number: 275
title: Gate Human Involvement by Uncertainty via the Calibration Ladder
status: draft
created: 2026-06-14
spec: unified-workflow-system
superseded-by: null
---

# 275. Gate Human Involvement by Uncertainty via the Calibration Ladder

## Status

Draft (auto-extracted from spec: unified-workflow-system)

## Context

An autonomous-until-review engine needs a principled rule for proceeding vs. asking. Too eager produces noise; too confident ships wrong calls. Stage-gating involvement is too coarse — a trivial item should flow through while a consequential one stops.

## Decision

At each decision point the agent walks a five-row ladder and acts on the first match: (0) a hard floor — irreversible/outward-facing/secrets-spend/scope-change → always ask, even at full confidence; (1) reversible + confident → proceed silently; (2) sticky + uncertain → ask; (3) reversible + uncertain → routed by stage bias at the frozen-spec cut line (intent stages ask, execution stages proceed-and-log); (4) sticky + confident → proceed but announce. "Confident" and "reversible" are evidence-based. Non-obvious calls leave an auditable trail; answers are written where the evidence-test finds them next time.

## Consequences

### Positive

- One rule yields emergent per-stage sensitivity ("IDEATE asks freely, EXECUTE asks rarely").
- Honest and auditable; "learning from answers" needs no separate store.

### Negative

- Depends on the agent's judgment of confident/reversible; mis-calibration surfaces as noise or wrong proceeds.
- Requires consistent assumption-logging discipline to stay auditable.
