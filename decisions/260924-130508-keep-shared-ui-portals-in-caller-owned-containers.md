---
id: 260924-130508
title: Keep shared UI portals in caller-owned containers
status: accepted
created: 2026-09-24
spec: shared-ui-broader-adoption
extractedFrom: shared-ui-broader-adoption
superseded-by: null
---

# 260924-130508. Keep shared UI portals in caller-owned containers

## Status

Accepted for broader shared UI adoption. Extends the package boundary in ADR 260923-201140 without replacing it.

## Context

The shared package is used by applications with independent theme and embedding boundaries. A portal attached to document.body cannot inherit a nested theme scope. Automatically moving every portal beneath its trigger can introduce clipping and alter existing modal behavior.

## Decision

We preserve default document-level portals and provide an optional UiProvider carrying a caller-owned portal container. Selected overlay primitives use this context while preserving explicit Radix Portal container overrides. Theme state and container lifetime stay with the application; the package owns generic rendering and behavior only. App-specific responsive and domain wrappers remain local and compose the shared primitives.

## Consequences

### Positive

- Existing consumers retain default portal behavior.
- Explicit theme islands and embedded hosts can contain overlays without coupling the package to an app theme store.
- Nested providers can scope independent surfaces.

### Negative

- Hosts must mount a stable container within the intended theme boundary.
- The package must test every portal path, including nested menus and explicit overrides.

See [the specification](../specs/shared-ui-broader-adoption/02-specification.md).
