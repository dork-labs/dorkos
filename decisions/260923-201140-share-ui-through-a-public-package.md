---
id: 260923-201140
title: Share UI through a public package with namespaced styles
status: proposed
created: 2026-09-23
spec: shared-design-system
extractedFrom: shared-design-system
superseded-by: null
---

# 260923-201140. Share UI through a public package with namespaced styles

## Status

Proposed. Implementation is authorized; publication requires a separate release decision.

## Context

The client, Community and the account surface duplicate controls and diverge in keyboard, sizing and theme behavior. Their applications must remain independently buildable and releasable. The current development playground combines portable examples with application simulations.

## Decision

We will maintain tokens and pure React primitives in one public `@dork-labs/ui` package, beginning with the client's Radix-based controls. Namespaced CSS tokens and a Tailwind 4 source entry keep the package independent of application theme vocabularies, and a packed consumer proves distribution. We will keep application state local and put portable examples in a standalone Vite catalog that consumes the same exports. Cross-repository consumers adopt authorized versioned releases; local archives provide evidence before publication.

## Consequences

### Positive

- Interaction fixes have one implementation and reach real consumers.
- Public builds require no private source or credentials.
- The client retains its FSD facade and application simulations.

### Negative

- The initial CSS contract requires Tailwind 4 in consumers.
- Cross-repository adoption needs a package release and explicit upgrade.
- Moving primitive ownership requires broad consumer regression checks even when behavior is preserved.

See [the specification](../specs/shared-design-system/02-specification.md) for acceptance and release gates.
