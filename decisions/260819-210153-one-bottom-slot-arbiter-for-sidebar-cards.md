---
id: 260819-210153
title: One bottom-slot arbiter chooses among the sidebar's cards; dismissal lives in user config, not localStorage
status: accepted
created: 2026-08-19
spec: sidebar-simplification
superseded-by: null
amends: null
---

# 260819-210153. One bottom-slot arbiter chooses among the sidebar's cards; dismissal lives in user config, not localStorage

## Status

Accepted 2026-08-22 — implemented by PR #1137 (task 1.2, DOR-1369).

## Context

The sidebar's bottom stacked up to four independent cards — a promo, a getting-started progress card, a profile prompt, and an update pill — with no shared priority between them; the promo card sat inside the scroller with no dismiss control at all, so a long room or agent list pushed it below the fold for good, and one promo (`remote-access`) was set to always show. The cards that could be dismissed stored that state in `localStorage`, so it didn't follow a person across devices or browsers. The alternative was to keep the stack as-is (up to three cards) and just add a dismiss control.

## Decision

We will render one `SidebarBottomSlot` — a sibling of the scroller, never a child of it — that takes an ordered list of candidates (getting-started progress, update pill, profile prompt, promo) and shows only the highest-priority one whose conditions are met; the rest wait their turn. Every candidate gets a `×` that persists to `UserConfigSchema.ui.promos.dismissedIds`, a new config leaf read and written like its siblings, replacing both the promo's missing dismiss control and the other cards' localStorage-only dismissal.

## Consequences

### Positive

- One card competes for attention at the bottom of the sidebar at a time, never four, and it is never buried below a long list.
- Dismissal syncs across a person's devices instead of resetting per browser.
- A future fifth card type registers into one priority list instead of growing a second ad hoc stack.

### Negative

- A lower-priority candidate (the promo, lowest in the order) may rarely or never surface for a user who always has a higher-priority one active.
- User config now carries UI-dismissal state, which widens what must be threaded through the agent-writable config policy tables (`config-disclosure.ts`, `config-write-policy.ts`, `default-verdicts.ts`).
- The one-time import of each card's existing localStorage dismissal state is migration debt that runs once and must be remembered and retired.
