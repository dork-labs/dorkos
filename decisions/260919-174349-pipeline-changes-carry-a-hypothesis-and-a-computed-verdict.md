---
id: 260919-174349
title: Pipeline changes carry a hypothesis and a computed verdict
status: accepted
created: 2026-09-19
spec: null
superseded-by: null
---

# 260919-174349. Pipeline changes carry a hypothesis and a computed verdict

## Status

Accepted (operator decision, 2026-09-19). Design: `plans/ci-steward-plan.md`; evidence:
`research/20260919_ci-pipeline-deep-review.md`.

## Context

The CI pipeline changed about 13 times a week, about 94 times in 14 weeks, and each change was
well documented. None was checked afterwards: 0 had a planned post-rollout measurement, and 3
results found by accident contradicted their change. Nothing recorded pipeline performance, so
every incident was re-measured from scratch and the same failure classes recurred 3 to 15
times. The pipeline only grew (typecheck runs up to 7 times per change) because no gate had a
price. With merges fully autonomous (ADR 260919-174348), the pipeline is the only gate, so it
must be able to tell whether its own changes worked.

## Decision

We will treat every pipeline change as an experiment and have code decide the result:

- **A ledger entry per change,** `ci/ledger/<id>-<slug>.md`, carrying a hypothesis: one metric
  from the catalogue (`ci/metrics.yaml`), its baseline, a target and an after-window. Only
  `kind: hygiene` is exempt. A PR that touches a gate source must add or edit an entry; a
  `typecheck` step checks it (advisory for its first week, then blocking by allowlist expiry).
- **Intent on `main`, observations on an append-only data branch.** Hand-owned `ci/` files
  state what we want; the daily collector writes what happened to `ci-steward-data`, so nothing
  the system generates needs a PR.
- **Verdicts are computed, never written by a model or by hand.** After the window, code
  returns `inconclusive` (confounders or too little data), `verified` or `failed`, with the SLO
  movement beside it. Those words are rejected as a status on `main`.
- **Facts are generated, not copied.** The census derives gate facts from the workflow YAML and
  fails on drift, including the required-checks lists in the docs.
- **The steward may change gates, never the steward or the judge.** Unattended changes are
  fenced off from the engine, the definitions, the review and the ratchets.

## Consequences

### Positive

- "Did it help?" gets an answer for every change, including the ones that obviously helped.
- The constraint to work on next is chosen by a fixed precedence over measured SLOs, not by
  argument.
- Documentation of the required set and gate facts cannot silently drift from the YAML.

### Negative

- Every pipeline PR costs one more file and a hypothesis, which is friction on small fixes
  (hence `kind: hygiene`).
- Until phase 1 ships the collector, baselines are hand-copied with a `baseline_source:`, and
  no verdict exists yet: phase 0 records hypotheses it cannot judge.
- Many early verdicts will be `inconclusive` (overlapping changes, small samples), and the
  report has to say so rather than round it to a win.
