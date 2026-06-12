---
number: 38
title: Use Progressive Disclosure Mode A/B for Feature Panels
status: accepted
created: 2026-02-25
spec: mesh-panel-ux-overhaul
superseded-by: null
---

# 38. Use Progressive Disclosure Mode A/B for Feature Panels

## Status

Accepted

## Context

Feature panels like Mesh, Pulse, and Relay have multiple tabs, but first-time users face empty states across every tab. The tab bar itself becomes visual noise when all tabs would show "nothing here" messages. Research into developer tool UX (Linear's "anti-onboarding" philosophy, GitHub's "Default Setup" pattern) shows that presenting the full interface when no content exists creates cognitive overhead and discourages engagement.

## Decision

Feature panels adopt a two-mode progressive disclosure pattern:

- **Mode A (empty state):** When the feature has no primary data (e.g., zero registered agents for Mesh), hide the tab bar and stats header entirely. Show only the single keystone action (e.g., Discovery) as a full-bleed view with contextual guidance.
- **Mode B (populated state):** When primary data exists (e.g., one or more registered agents), show the full tabbed interface with stats header and per-tab empty states.

The transition between modes uses `AnimatePresence` from motion.dev for smooth layout animation. Mode determination is reactive — if primary data drops back to zero, the panel re-collapses to Mode A.

## Consequences

### Positive

- First-time users see exactly one action they can take, not five empty tabs
- Eliminates the "blank canvas" problem for graph-based tabs (Topology)
- Consistent with Calm Tech's "less, but better" philosophy
- Pattern is reusable across Mesh, Pulse, and Relay panels
- Smooth animation prevents jarring layout shifts

### Negative

- Slightly more complex conditional rendering in panel components
- Tests need to cover both modes and the transition between them
- The "keystone action" must be correctly identified per feature (Discovery for Mesh, "New Schedule" for Pulse, etc.)
