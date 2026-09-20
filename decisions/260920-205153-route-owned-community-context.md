---
id: 260920-205153
title: Route-owned Community context with keyed privacy boundaries
status: draft
created: 2026-09-20
spec: community-switcher-navigation
superseded-by: null
---

# 260920-205153. Route-owned Community context with keyed privacy boundaries

## Status

Draft (extracted from spec: community-switcher-navigation)

## Context

DorkOS must navigate the local installation, multiple tenants on one host, and Communities on independent hosts. A mutable global selection can disagree with qualified URLs during reload, history navigation, multiple windows, and rapid switches. Reusing the old contextual DOM while changing its label can also expose one Community's content under another identity.

## Decision

The qualified URL is the only active-context authority. At route commit, the app keys the contextual body by installation or connection ref, renders a safe target frame, increments a context epoch, cancels old reads, and closes old streams. Server data, drafts, mutations, unread state, and remembered destinations remain owner- and Community-qualified. Async work also captures an owner/session/connection authorization generation. Ordinary navigation keeps that generation valid, but sign-out, owner change, membership removal, and connection revocation invalidate it before clearing state; late work must recheck it and discard results from an invalid generation.

The local installation is a first-class destination and stays first. A shared trigger opens a desktop popover or phone bottom sheet rather than adding a permanent workspace rail or fifth mobile tab.

## Consequences

### Positive

- Deep links, reload, back/forward, and multiple windows agree about the selected Community.
- Old Community content cannot flash beneath a new name during a slow or failed switch.
- The existing DorkOS agent workspace remains complete without a Community.
- Same-host tenants and independent hosts use one navigation contract without merging authority.

### Negative

- Every asynchronous Community operation must carry a source ref, context epoch, and authorization generation, then tolerate cancellation or discard work after either guard becomes invalid.
- Remembered view state needs explicit owner/community/room namespaces and cleanup on removal.
- The shell needs two responsive presentations of one focus and selection model.
