---
id: 260808-140955
title: The home is the #team room, not a report
status: draft
created: 2026-08-08
spec: team-room-home
superseded-by: null
amends: null
---

# 260808-140955. The home is the #team room, not a report

## Status

Draft (extracted from spec: team-room-home)

## Context

The dashboard at `/` was a report about live things — status cards, promo cards, an activity
preview — and reports about live things go stale the moment you look away. Competitive research
across agent-native products (Devin, Cursor, Codex, Copilot mission control, Conductor,
VibeKanban) found every one made "what's happening now" the home; none built a metrics
dashboard. A kanban home was rejected because "Done" is fake (agents finish turns, not tasks);
a briefing home and a launcher home each serve only one user state.

## Decision

We will make the home surface the **#team room** — a real room containing the user and all
their agents, seeded per install — with a pinned triage header ("Waiting on you" + needs
attention + presence strip) that stays glanceable above the scrolling feed, and the full room
composer. Activity, Scheduled, and Workspaces become tabs of the home surface at their existing
routes; the sidebar shrinks to Home · Team · Connections · Marketplace. The report-style
dashboard is deleted, its sections absorbed or retired with named dispositions. The swap ships
without a feature flag (early beta, building in public).

## Consequences

### Positive

- The home never goes stale — it is the live thing, not a report about it.
- Every hard routing question dissolves into room semantics (mentions, membership, etiquette).
- Onboarding, catch-up, and daily work are one surface with three states, not three designs.

### Negative

- Chat scrolls: anything that must stay visible has to live in the pinned header, a permanent
  design constraint.
- The `dashboard.sections` extension slot loses its natural canvas until the room-widget
  successor exists (interim home: the Activity tab).
