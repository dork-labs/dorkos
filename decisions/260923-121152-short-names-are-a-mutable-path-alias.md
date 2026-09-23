---
id: 260923-121152
title: Short names are a mutable path alias, never identity
status: draft
created: 2026-09-23
spec: community-host-operator-api
amends: 260920-192429
superseded-by: null
---

# 260923-121152. Short names are a mutable path alias, never identity

## Status

Draft (auto-extracted from spec: community-host-operator-api). Amends `260920-192429` only where it says mutable names are used only for display: a short name may also be used as an address. The canonical-UUID rule for identity, credentials, and minted links stands.

## Context

Communities are reachable only at `/c/<uuid>`, which is correct for identity and unusable as an address a person types or says aloud. The tenancy contract excluded vanity slugs to keep names from becoming identity. A host with many communities needs readable addresses without reopening that risk.

## Decision

We will give each community an optional host-unique short name, served as `/<name>` beside `/c/<uuid>`. The name is ASCII, 3 to 32 characters, checked against a reserved list that hosts can extend. The host sets and renames it. Retired names stay bound to their community and lead to the current name. A released name enters a cool-off, stored only as a keyed HMAC. A public exact-match lookup returns the community UUID for a live name and an identical `404` otherwise; it offers no listing. Every credential, minted link, stream, API route, and stored DorkOS connection keeps using the UUID, and the connection parser resolves `/<name>` to a UUID once and stores only the UUID.

## Consequences

### Positive

- People get readable addresses, and a rename never breaks a stored connection or minted link.
- Old addresses keep working, and a cool-off stops a released address being taken over at once.
- Communities that want no public address simply have none.

### Negative

- The existence of a live name is publicly confirmable, which the tenancy contract previously avoided entirely.
- Every new top-level browser path must join the reserved list, guarded by a test.
- The browser's tenant resolution gains a second path shape.
