---
number: 312
title: Timestamp identifiers and id-keyed manifests for new ADRs and specs
status: draft
created: 2026-07-03
spec: merge-conflict-prevention
superseded-by: null
---

# 312. Timestamp identifiers and id-keyed manifests for new ADRs and specs

## Status

Draft (auto-extracted from spec: merge-conflict-prevention)

## Context

The collision root cause is a single shared mutable `nextNumber` counter allocated at author-time
on divergent branches: two branches each read the same value and both allocate it. This is
branch-level, not a runtime race, so locking cannot fix it. Dense-sequential numbering is the only
property that forces the counter; the numeric handle itself is not the problem. Sequential ADR/spec
numbers otherwise buy a short cross-reference handle, chronological order, and directory sort order.

## Decision

New ADRs and specs receive a `YYMMDD-HHMMSS` (UTC, second precision) id that the creating process
stamps from its own clock, reading no shared state. The two manifests become objects keyed by id
with no `nextNumber` field. The ~260 existing 4-digit numbered artifacts are frozen and keep their
numbers (never renumbered). Legacy ids (start `0`) sort before timestamp ids (start `2`).
Generating the manifest from per-file frontmatter was considered and deferred to a future
simplification.

## Consequences

### Positive

- Identifier allocation is coordination-free, so collisions are impossible regardless of ordering.
- Different manifest keys are non-overlapping and auto-merge with git's default driver.
- Chronological sort is preserved; no renumbering churn and no broken cross-references.

### Negative

- Two id formats coexist (numeric legacy + timestamp), and the new handle is longer/less pretty.
- Any consumer that parses a manifest as an array or by numeric `number` must handle both shapes.
