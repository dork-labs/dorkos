---
number: 278
title: Filesystem-Canonical Artifacts with ID-Only Bidirectional Provenance
status: proposed
created: 2026-06-14
spec: unified-workflow-system
superseded-by: null
---

# 278. Filesystem-Canonical Artifacts with ID-Only Bidirectional Provenance

## Status

Proposed

## Context

Four state models drifted because each held its own copy of where work was. Duplicating prose (specs, research, ADRs) into the tracker would reintroduce exactly that drift.

## Decision

The filesystem is canonical — research, specs, and ADRs live once on disk. The tracker stores pointers plus state plus conversation only, and state is derived from artifact events. Back-links are bidirectional but ID-only (stable, low-churn). A spec's anchor to the tracker is 1:1 (one issue OR one project); multiplicity is normalized into `03-tasks.json` per-task `issue` plus typed relations. A flat `issues: […]` frontmatter list is rejected.

## Consequences

### Positive

- One copy of prose means the two can't disagree on content; links are stable and low-churn.
- Status-sync has a single authoritative target per spec.

### Negative

- Requires discipline that the tracker never accretes a second prose copy.
- The provenance block and 03-tasks.json schema must carry the normalized mapping.
