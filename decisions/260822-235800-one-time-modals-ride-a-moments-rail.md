---
id: 260822-235800
title: One-time modals ride a moments rail, mirroring the banner slot's arbitration
status: proposed
created: 2026-08-22
spec: full-power-defaults
superseded-by: null
amends: null
---

# 260822-235800. One-time modals ride a moments rail, mirroring the banner slot's arbitration

## Status

Proposed — extracted from spec `full-power-defaults`.

## Context

The client had one generalized arbitration surface for standing conditions (the priority-ranked app-banner slot) but nothing equivalent for one-time interruptions: telemetry consent shipped as a banner, and the full-power consent needed a modal for existing users. Each new one-off modal would otherwise invent its own mounting, gating, and persistence.

## Decision

A `moments` widget generalizes one-time modals: `MomentDescriptor { id, priority, render }` descriptors collected exactly like banner descriptors ("append the hook, no other wiring" — eligibility lives in the hook, which returns `null` when its moment should not show, mirroring `BannerDescriptor`), a `MomentHost` beside `DialogHost` that shows at most the single highest-priority eligible moment per app launch, and hard suppression while onboarding is active or unanswered. Persistence is each moment's own concern through real state fields (`ui.fullPowerDecidedAt`, `telemetry.userHasDecided`) — there is deliberately no central "shown moments" store to drift from the truth. The telemetry consent banner retires; its copy and writes move onto the rail as the second moment.

## Consequences

- Adding a one-time modal is one descriptor + one real state field; arbitration, pacing, and onboarding deference come free.
- At most one interruption per launch — a calm ceiling no individual feature can break.
- Telemetry's dormant `lastPromptedVersion` re-prompt anchor finally has a surface that can honor a future policy-version bump (a new predicate, not a new system).
- Moments must derive their eligibility from durable state; a moment that needs its own bookkeeping field must add a real config field, keeping the no-parallel-store invariant.
