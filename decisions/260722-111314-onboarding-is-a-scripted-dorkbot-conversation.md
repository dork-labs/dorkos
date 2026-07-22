---
id: 260722-111314
title: Onboarding is a scripted, token-free DorkBot conversation
status: proposed
created: 2026-07-22
spec: dorkbot-is-the-onboarding
superseded-by: null
---

# 260722-111314. Onboarding is a scripted, token-free DorkBot conversation

## Status

Proposed

## Context

First-run onboarding was a wizard of screens about DorkBot (personality form, discovery list, finish screen), and a 2026-07-22 fresh-install walkthrough showed its designed hand-off into a DorkBot session was unreachable (finish-screen unmount race) and its landing zone buried the agent. The product's promise is directing agents; a wizard configures software instead of delivering that promise. Alternatives considered: keep the wizard and fix the bugs (Tier 0 alone), or drive onboarding with live LLM turns (costs tokens before the user has done anything, non-deterministic copy, breaks without a funded runtime).

## Decision

We will replace the personality, discovery, and finish screens with one scripted conversation with DorkBot, built from the real chat components (MessageItem/StreamingText, ChatInput, FirstLight). All DorkBot speech in the conversation is client-generated from authored templates in `@dorkos/shared/dorkbot-templates` (script-as-data, deterministic, personality-inflected); real inference starts only with the user's first real message, which dissolves the overlay into a real session. The conversation's beats map onto the existing `ONBOARDING_STEPS` config enum, so there is no schema change or migration.

## Consequences

### Positive

- The first run ends mid-conversation with a working agent: the product's core promise, delivered before any token is spent.
- Deletes two screens, the step dots, and the finish screen (whose unmount race caused the headline bug class); net-negative surface area.
- Deterministic, testable copy; works before any runtime credential is funded.
- Establishes a reusable pattern (scripted agent speech + inline widgets) for future guided flows such as the Tier 3 living tour.

### Negative

- Authored script must be maintained as DorkBot's real capabilities evolve; stale copy now lies in DorkBot's own voice.
- A conversation is slower to click through than a form for users who want zero ceremony (mitigated: every beat has a decline chip and Skip setup remains one click away).
- Scripted speech is not real inference; users may probe it and hit its edges before the dissolve.
