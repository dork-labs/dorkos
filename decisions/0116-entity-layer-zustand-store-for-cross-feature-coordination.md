---
number: 116
title: Entity-Layer Zustand Store for Cross-Feature FSD Coordination
status: accepted
created: 2026-03-11
spec: pulse-schedule-templates
superseded-by: null
---

# 116. Entity-Layer Zustand Store for Cross-Feature FSD Coordination

## Status

Accepted

## Context

Feature-Sliced Design (FSD) prohibits cross-feature imports. When two features in the same application need to coordinate — one triggering an action in the other (e.g., `features/session-list` telling `features/pulse` to open a dialog with pre-populated data) — the standard FSD resolution is to lift the shared state to a layer that both features can legally import.

The options are: (1) shared state in the `shared/` layer, (2) shared state in the `entities/` layer scoped to a domain, or (3) page/widget-level prop drilling.

## Decision

Place cross-feature coordination state in the relevant `entities/` layer as a Zustand store. Specifically, `usePulsePresetDialog` lives in `entities/pulse/model/` and exposes `openWithPreset()` + `clear()`. Both `features/session-list` (writer) and `features/pulse` (reader) import from `entities/pulse` — a valid direction in FSD.

This scopes the store to the `pulse` domain rather than polluting the global `shared/` layer with feature-specific trigger state.

## Consequences

### Positive

- FSD layer compliance maintained — no cross-feature imports
- Store is domain-scoped (entities/pulse), not globally shared
- Pattern is reusable: any future cross-feature coordination in the pulse domain follows the same model
- Both sides of the coordination remain independently testable

### Negative

- Entities layer now owns some ephemeral UI trigger state, which is slightly outside its traditional "domain model" role
- Store state must be explicitly cleared after consumption to avoid stale triggers
