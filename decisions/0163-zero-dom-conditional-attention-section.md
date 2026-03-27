---
number: 163
title: Zero-DOM Conditional Rendering for Needs Attention Section
status: accepted
created: 2026-03-20
spec: dashboard-content
superseded-by: null
---

# 163. Zero-DOM Conditional Rendering for Needs Attention Section

## Status

Accepted

## Context

The dashboard's Needs Attention section surfaces issues that require user action (failed runs, dead letters, stalled sessions, offline agents). Most of the time, the system is healthy and there are no attention items. The design needed to handle this common "empty" case in a way consistent with calm technology principles — where silence equals health.

## Decision

Use `AnimatePresence` with `initial={false}` to conditionally mount/unmount the Needs Attention section based on `items.length > 0`. When empty, the section produces zero DOM nodes — no collapsed state, no empty-state text, no placeholder. The section's visual appearance is itself the signal that something needs attention. This differs from other dashboard sections which always render with intentional empty states.

## Consequences

### Positive

- Absence communicates "all is well" without requiring text
- Zero rendering cost for healthy systems (the common case)
- Clear, unambiguous visual signal: section appears = something needs attention
- Follows calm tech principle of minimal noise when healthy

### Negative

- Different pattern from other sections (which always render with empty states)
- Requires careful animation timing to avoid layout shifts when the section appears/disappears
- Users unfamiliar with the pattern might not notice a new section appearing
