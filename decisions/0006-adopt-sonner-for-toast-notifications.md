---
number: 6
title: Adopt Sonner for Toast Notifications
status: proposed
created: 2026-02-21
spec: pulse-ui-overhaul
superseded-by: null
---

# 6. Adopt Sonner for Toast Notifications

## Status

Proposed (auto-extracted from spec: pulse-ui-overhaul)

## Context

DorkOS has no toast/notification infrastructure. Several features fire mutations (Run Now, Approve schedule, delete operations) with no visual feedback when the action has no immediate UI change. The design system follows Calm Tech principles — feedback should be minimal and only appear when necessary.

Sonner is the standard toast library recommended by shadcn/ui and is already used in the `@dorkos/web` marketing site (v2.0.7). It integrates naturally with Tailwind CSS variables and supports theming.

## Decision

Adopt sonner as the app-wide toast library for `@dorkos/client`. Use toasts narrowly — only for background actions with no immediate visible UI change:

- "Run triggered" (background process, not immediately visible)
- Error notifications for failed mutations
- "Schedule approved" (state change may not be obvious)

Do NOT toast for: toggle on/off (switch is self-evidencing), form success (dialog closes), cancel run (status updates inline).

## Consequences

### Positive

- Consistent feedback pattern for background actions across the app
- Lightweight (~3KB gzip), renders in a portal — no performance impact
- Already proven in the monorepo (`@dorkos/web`)
- Theme-aware via CSS variables — works with dark mode automatically

### Negative

- New dependency for the client app
- Risk of overuse — must maintain discipline about when to toast vs. not
- Sonner renders outside React's component tree (portal) — may complicate testing
