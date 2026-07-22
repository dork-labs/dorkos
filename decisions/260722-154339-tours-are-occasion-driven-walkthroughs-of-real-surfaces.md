---
id: 260722-154339
title: Tours are occasion-driven walkthroughs of real surfaces
status: accepted
created: 2026-07-22
spec: dorkbot-living-tour
superseded-by: null
---

# 260722-154339. Tours are occasion-driven walkthroughs of real surfaces

## Status

Accepted

## Context

After the conversational onboarding (ADR 260722-111314) and the action dashboard (ADR 260722-120728), the rest of the cockpit (Tasks, Relay, Mesh) is learn-by-poking. The industry default is a day-one overlay slideshow, which users dismiss and forget, and which shows mocks instead of the user's actual system. DorkOS has an agent who lives in the product and can walk the user to the real thing when it matters.

## Decision

We will ship tours that fire on real occasions, not on a schedule: a subsystem introduces itself at first genuine use (an observed 0-to-1 transition — first schedule created, first channel connected, second agent registered), offered as client-rendered suggestion chips in the session, in DorkBot's authored voice, token-free. Accepting deep-links to the real route and spotlights the real element; if the anchor is missing, the step skips honestly. Tours are three steps or fewer, decline-once (persisted in the config `tours` block), and always escapable. A general tour exists only on demand ("Show me around").

## Consequences

### Positive

- Every tour has a real referent the user just created, so the lesson lands at the moment of relevance instead of day-one noise.
- 0-to-1 occasion semantics naturally protect pre-existing users without backfill machinery.
- The suggestion-chip slot generalizes to future in-session nudges.

### Negative

- Occasion detection is client-side cache observation; occasions that happen while no client is open are simply missed (accepted: the next occasion re-offers nothing, and the on-demand door remains).
- Authored captions must track surface changes or the tour lies in DorkBot's voice (same maintenance contract as the onboarding script).
