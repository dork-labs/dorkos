---
id: 260804-093317
title: The bridge writes room entries and never triggers a turn
status: proposed
created: 2026-08-04
spec: chats-as-channels
superseded-by: null
---

# 260804-093317. The bridge writes room entries and never triggers a turn

## Status

Proposed. To be accepted when the `chats-as-channels` spec reaches `implemented`.

## Context

Turn selection in a room is already governed by four cooperating mechanisms: `addressing.ts`, `cascade-guard.ts`, `turn-budget.ts`, and the dispatcher's per-`(room, agent)` claim. The bridge introduces a second source of room entries (inbound platform messages), and the tempting shortcut — having the bridge decide when the agent answers, or dispatch a turn itself — would fork that logic. A fork means two places that can disagree about whether an agent runs, which is how over-participation and double-runs happen.

## Decision

We will make the bridge **write a room post and stop**. Every decision about whether an agent answers stays where it already lives; the entry a bridge writes is an ordinary room post, and `RoomTriggerDispatcher` applies the existing rules to it unchanged. `ingest` is terminal for a bridged binding — it never falls through to session dispatch — so one platform message can never run a turn twice.

## Consequences

### Positive

- One code path decides whether a turn runs, for cockpit posts and bridged messages alike; the cascade guard, turn budget, and mention gating apply with no new caller.
- A bridged group inherits the room's `mention-only` posture and privacy-mode honesty for free, because nothing new triggers ambient runs.
- The runtime seam is untouched: no runtime knows a room is bridged.

### Negative

- The bridge cannot express "answer this specially" — any future need to influence turn selection from a platform signal must go through the existing mechanisms, not around them.
- `ingest` being terminal is an invariant a future edit could quietly break (falling through would double-run); it is pinned by a spy test rather than by the type system.
