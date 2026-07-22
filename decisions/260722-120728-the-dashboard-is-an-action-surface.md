---
id: 260722-120728
title: The dashboard is an action surface, not an observability report
status: proposed
created: 2026-07-22
spec: dashboard-with-hands
superseded-by: null
---

# 260722-120728. The dashboard is an action surface, not an observability report

## Status

Proposed

## Context

Every dashboard section was read-only observability (attention list, promos, system status, activity feed); starting a conversation required the sidebar, and the status row spoke internals ("Relay: 1 adapter") that mean nothing to a new operator. A fresh-install walkthrough (2026-07-22) showed the landing page offering a new user nothing to _do_. The alternative was keeping the dashboard as a pure monitor and adding entry points elsewhere (the Tier 0 header button was this stopgap).

## Decision

We will make the dashboard's first section an action: a composer ("What are we building today?") that starts a real session with the default agent via the `first-message` seam (ADR 260722-111316), followed by messageable agent cards, ahead of the observability sections. Status copy inverts to operator language: the primary line states the outcome ("Connected to Claude Code", "Nothing scheduled yet"); internal subsystem names may remain only as captions. The stopgap header button is removed; one affordance, in the body, is the contract.

## Consequences

### Positive

- The landing page answers "what can I do?" before "what is happening?" — the same question onboarding's hand-off asks, so first-run muscle memory carries into daily use.
- One shared status vocabulary (attention model + outcome language) instead of per-surface wording; future dashboard sections inherit the action-first ordering.

### Negative

- The dashboard now depends on chat-adjacent machinery (birth store, session navigation), widening its test surface.
- Operators who wanted a dense monitor lose one row of vertical space to the composer (mitigated: the section order keeps attention items immediately below).
