---
id: 260822-235802
title: Unattended surfaces follow the operator's power level, resolved at creation, confirm kept
status: accepted
created: 2026-08-22
spec: full-power-defaults
superseded-by: null
amends: null
---

# 260822-235802. Unattended surfaces follow the operator's power level, resolved at creation, confirm kept

## Status

Accepted — extracted from spec `full-power-defaults`.

**Amended by ADR `260908-170643`**, which adds the surface this decision's
enumeration left out. "Scheduled tasks and relay bindings" below is the list of
surfaces wired at the time, not the boundary of the principle: a room turn is an
unattended surface too, and is the one with no per-instance control and no
confirm of its own. Read the Decision section as covering rooms as well, with the
clamp that amendment adds for entries written off this machine.

## Context

Scheduled tasks and relay bindings — the surfaces nobody watches — hardcoded middle-stop defaults (`acceptEdits` on task create and the scheduler fallback; the prompting mode on bindings; `canInitiate: false`). Post-flip, an operator who chose full power still had to raise every task and binding by hand, while the marketplace/content clamp (which prevents _downloaded content_ from raising its own power) must not loosen.

## Decision

Unattended defaults resolve through the operator's configured trust stop instead of hardcoded constants: a `resolveUnattendedDefaultStop()` helper in the session-defaults ladder feeds the task-create route, the scheduler fallback, and the client task/binding forms' initial dial position, mapping the stop through each runtime's declared capability profile and falling back to today's exact behavior when no stop is configured. The binding form pre-selects `canInitiate` only when the door was accepted (`ui.fullPowerChoice === 'full'`); the wire schema default stays `false`. Two guardrails survive unchanged: the per-instance unattended confirm dialog at creation (one honest click on the one surface nobody watches), and the schedule-permission clamp on file/marketplace-sourced schedules.

## Consequences

- One choice at the door propagates to every new unattended surface; no per-task re-raising.
- Content-sourced schedules still can never smuggle `bypassPermissions`; operator power and content power stay distinct ladders.
- Existing tasks/bindings keep their stored modes — resolution happens at creation, never retroactively.
- The unset-config path is byte-for-byte the old behavior, so never-consented installs cannot drift.
