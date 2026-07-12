---
id: 260711-150551
title: PIP content as serializable descriptors routed by a host feature, not React nodes in the store
status: accepted
created: 2026-07-11
spec: pip-panel
superseded-by: null
---

# 260711-150551. PIP content as serializable descriptors routed by a host feature, not React nodes in the store

## Status

Accepted

## Context

The PIP panel is a reusable primitive that must know nothing about its content, yet something has to decide what renders inside it. Storing React nodes or render callbacks in the Zustand store would break devtools serialization and any future content persistence, and would couple the shared store to feature UI. The canvas already solved this shape: a typed content union (`UiCanvasContent`) in the store, with a feature-owned component switching on the variant to render (FSD permits cross-feature UI composition, not cross-feature model imports).

## Decision

We will keep PIP state as a serializable `PipContent` discriminated union (`{ kind, title, ...props }`) in the `app-store-pip.ts` slice, and route rendering in `features/pip-panel/`'s host component via a module-scope kind→component map. Consumers (MCP Apps `pip` mode, gen-UI widgets) extend the union and the map in their own PRs; the shared/ui `floating-panel.tsx` primitive receives only children and chrome props. The renderer map's component identities stay module-scope stable — never inline closures — because recreating renderer identity remounts the content tree and destroys in-flight state (the documented `StreamingText.tsx` fence-renderer remount hazard).

## Consequences

### Positive

- Store stays serializable (devtools, future content persistence, testability).
- The primitive is genuinely content-blind and importable from any layer; consumers plug in without touching it.
- Mirrors the canvas pattern, so the codebase has one way of routing typed panel content.

### Negative

- Adding a content kind touches two places (union + renderer map) instead of passing JSX directly.
- Descriptor props must stay serializable; anything live (queries, bridges) must be owned by the routed component itself.
