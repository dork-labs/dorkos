---
number: 152
title: Use State Machine with Prioritized Content Slots for Unified Status Strip
status: accepted
created: 2026-03-20
spec: unified-status-strip
superseded-by: null
---

# 152. Use State Machine with Prioritized Content Slots for Unified Status Strip

## Status

Accepted

## Context

The chat UI needs to consolidate two status display components (InferenceIndicator and SystemStatusZone) into a single unified strip. The strip must show exactly one status type at a time from 6 possible states (rate-limited, waiting, system-message, streaming, complete, idle), selected by an explicit priority order. Four architectural approaches were evaluated: simple if/else switcher, priority queue, state machine, and compound component.

## Decision

Use a `deriveStripState()` pure function that maps raw props to a `StripState` discriminated union. The component renders content based on the active variant via `AnimatePresence mode="wait"` keyed by `state.type`. This follows the Apple Dynamic Island principle: one morphing container, different content, smooth transitions. Priority logic is encoded as a simple if/else chain within the pure function, making it testable without React mocks and exhaustively checkable by TypeScript.

## Consequences

### Positive

- Priority logic is a pure function — testable without React rendering or mocks
- TypeScript exhaustiveness checking via discriminated union catches missing state handlers at compile time
- Matches existing codebase patterns (StatusLine uses similar state-driven rendering)
- `AnimatePresence mode="wait"` with `state.type` as key provides clean crossfade transitions between states

### Negative

- Slightly more upfront code than a simple conditional switcher
- Snapshot refs for post-stream completion summary must be maintained in a separate hook (`useStripState`)
