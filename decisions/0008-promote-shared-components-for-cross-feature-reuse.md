---
number: 8
title: Promote Components to shared/ for Cross-Feature Reuse
status: proposed
created: 2026-02-21
spec: pulse-v2-enhancements
superseded-by: null
---

# 8. Promote Components to shared/ for Cross-Feature Reuse

## Status

Proposed (auto-extracted from spec: pulse-v2-enhancements)

## Context

FSD architecture enforces strict unidirectional layer imports: features cannot import from other features. When a component initially built within one feature (e.g., DirectoryPicker in `features/session-list/`) is needed by another feature (e.g., `features/pulse/`), a cross-feature import is forbidden. The component must be promoted to a shared layer.

## Decision

When a component needs to be used by more than one feature, move it from its feature directory to `shared/ui/` and update barrel exports. The component gains an optional callback prop (e.g., `onSelect`) that replaces any feature-specific state coupling (e.g., direct Zustand `setSelectedCwd` calls). Existing consumers pass the callback to preserve their behavior; new consumers wire the callback to their own state.

## Consequences

### Positive

- Maintains FSD layer compliance without workarounds
- Components become truly reusable across features
- Optional-callback pattern preserves backward compatibility

### Negative

- Moving files changes import paths across consumers and tests
- Components in `shared/ui/` must not depend on feature-level hooks (may require refactoring internal state coupling)
