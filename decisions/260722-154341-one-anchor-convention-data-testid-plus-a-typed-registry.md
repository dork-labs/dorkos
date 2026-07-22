---
id: 260722-154341
title: One stable-anchor convention — data-testid plus a typed registry
status: proposed
created: 2026-07-22
spec: dorkbot-living-tour
superseded-by: null
---

# 260722-154341. One stable-anchor convention — data-testid plus a typed registry

## Status

Proposed

## Context

Tours need stable element anchors. The obvious move was a new `data-tour-id` attribute, but the client already carries 531 `data-testid` attributes, the e2e capture pipeline already selects on them, and the PR #371 incident (humanized copy broke a `getByText` capture selector) is the exact drift class stable anchors prevent. A second attribute would split one concern across two conventions.

## Decision

We will not mint `data-tour-id`. Tours target the existing `data-testid` convention, and the subset that tours (and captures) depend on graduates into a typed anchor registry (`TOUR_ANCHORS` const map) imported by tour definitions and tests alike, so renames are compile-time events. Anchors are demand-driven — added when a consumer points at one — never lint-required. `data-testid` must not be stripped from production builds.

## Consequences

### Positive

- One vocabulary for tours, Playwright/captures, and RTL; registry-imported ids turn silent selector drift into build failures.
- No governance burden: no required-coverage rule, no attribute soup.

### Negative

- Production DOM retains testids (deliberate; they are inert metadata).
- Test-oriented naming may occasionally read oddly for tour anchors (acceptable; the registry key, not the DOM string, is the authoring surface).
