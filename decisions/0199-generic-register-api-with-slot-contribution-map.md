---
number: 199
title: Generic register<K>() API with SlotContributionMap Interface
status: draft
created: 2026-03-26
spec: ext-platform-02-extension-registry
superseded-by: null
---

# 199. Generic register<K>() API with SlotContributionMap Interface

## Status

Draft (auto-extracted from spec: ext-platform-02-extension-registry)

## Context

The extension point registry needs an API for registering contributions to UI slots. Three approaches were considered: (1) a single generic `register<K extends SlotId>(slotId, contribution)` method with a mapped type interface, (2) separate methods per slot type (`registerCommand()`, `registerDialog()`, etc.), and (3) a single method with a discriminated union for contribution types. The registry must support 8 slot types in v1 and be extensible for third-party extensions in Phase 3.

## Decision

Use a single generic `register<K extends SlotId>(slotId: K, contribution: SlotContributionMap[K]): () => void` method backed by a `SlotContributionMap` interface. TypeScript infers the correct contribution type from the slot ID argument. The map is declared as an `interface` (not a `type` alias) so third-party extensions can later add new slot types via `declare module` augmentation without modifying core code.

## Consequences

### Positive

- Per-slot type safety without method proliferation — impossible to register the wrong shape for a slot
- Single API surface to learn; optional convenience aliases can be added later
- `interface` declaration enables Phase 3 extensibility via module augmentation
- Avoids discriminated union performance issues documented in large TypeScript codebases

### Negative

- Slightly less discoverable than named methods (mitigated by documentation and optional aliases)
- Requires understanding mapped types and module augmentation to extend in Phase 3
