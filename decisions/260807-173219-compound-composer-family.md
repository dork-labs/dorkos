---
id: 260807-173219
title: One compound composer family shared by chat, rooms, and dashboard
status: accepted
created: 2026-08-07
spec: composer-parity
superseded-by: null
---

# 260807-173219. One compound composer family shared by chat, rooms, and dashboard

## Status

Accepted

## Context

All three DorkOS composers (session chat, rooms, dashboard) share one input core, `ChatInput.tsx`, but each surface wraps it in hand-rolled chrome, overlay lanes, and affordance wiring that have drifted apart. Every composer feature (file attachments, the Lexical rich-text swap) currently pays that divergence tax once per surface. The 2026-08-06 design session locked full capability parity minus session machinery, with chrome identical by construction.

## Decision

Extract a compound component family — `Composer.Root` / `Composer.Input` / `Composer.OverlayLane` / `Composer.Attachments` / `Composer.ClearArmedHint` — into a new FSD slice `features/composer`, and compose all three surfaces from it. Capability divergence is expressed by composition and props (which parts a surface renders, which optional props it passes), never by a parallel capability config or a forked component. Submit paths are deliberately not merged: each surface keeps its own submit handler; the family owns only the shell. All hooks stay internal to the slice so cross-feature imports remain UI composition only.

## Consequences

### Positive

- Chrome, a11y, and the keyboard ladder live in one place; drift between surfaces becomes structurally impossible.
- DOR-947 wires attach once; DOR-948 swaps one `Composer.Input` and lands on every surface at once.
- The capability matrix is reviewable in code (the composition per surface) instead of by convention.

### Negative

- The biggest refactor of the three composer work items, with blast radius over every composer test and e2e flow — mitigated by phased migration with DOM-diff behavior-preservation proofs.
- A compound family for two-and-a-half consumers risks over-abstraction if session concepts leak into it; the slice boundary (session machinery stays in `features/chat`) must be defended in review.
