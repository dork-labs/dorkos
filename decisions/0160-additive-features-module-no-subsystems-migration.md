---
number: 160
title: Introduce Additive features.ts Without Migrating subsystems.ts
status: draft
created: 2026-03-20
spec: site-feature-catalog
superseded-by: null
---

# 0160. Introduce Additive features.ts Without Migrating subsystems.ts

## Status

Draft (auto-extracted from spec: site-feature-catalog)

## Context

The site already has `subsystems.ts` (high-level subsystem descriptions used in `SubsystemsSection`) and `modules.ts` (module-level descriptions). The new feature catalog overlaps semantically — features belong to the same subsystem categories. Options were: (A) extend `subsystems.ts` with per-feature arrays, (B) migrate homepage sections to derive from `features.ts`, or (C) introduce `features.ts` as a new additive module without touching existing data files.

Option A would couple the feature catalog schema to the existing subsystem data shape. Option B requires updating multiple homepage components as part of the catalog spec, increasing risk and scope. Option C keeps the catalog launch isolated and additive.

## Decision

`features.ts` is introduced as a standalone module. `subsystems.ts` and `modules.ts` remain unchanged. A future spec is responsible for migrating homepage sections to use `features.ts` as the authoritative source and eliminating the overlap. The `spec` notes this as deferred work.

## Consequences

### Positive

- The feature catalog can ship without touching existing homepage sections
- Zero regression risk to the live marketing page
- Keeps the scope of this spec bounded and testable in isolation

### Negative

- Temporary semantic overlap between `features.ts` and `subsystems.ts` — some data is duplicated in spirit
- A follow-up migration spec is required to clean up the duplication
- Developers adding new DorkOS subsystem descriptions must update two files until migration
