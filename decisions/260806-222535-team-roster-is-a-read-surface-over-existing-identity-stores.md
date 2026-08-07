---
id: 260806-222535
title: The Team roster is a read-surface aggregation over existing identity stores
status: draft
created: 2026-08-06
spec: identity-consistency
superseded-by: null
---

# 260806-222535. The Team roster is a read-surface aggregation over existing identity stores

## Status

Draft (auto-extracted from spec: identity-consistency)

## Context

DorkOS has no query that lists everyone on this install. People live in the `authors` table
(`packages/db/src/schema/rooms.ts:43-103`), agents live in the mesh registry, and
`CommunityAdapter.listMembers()` is scoped to one room in one community. Replacing `/agents` with a
`/team` roster of people **and** agents needs that list, and the obvious move — a `members` table, or
a person entity to hold the roster row — would fork a third identity model beside two that the repo
has already converged on: an opaque locally-minted id with `naturalKey` = `user:<betterAuthUserId>` or
`agentPath`, and a `displayName`/`emoji`/`color` render cache. Owner attribution ("who does this agent
belong to") has the same trap: writing an `ownerId` into `AgentManifest` would put it in a file the
mesh reconciler rebuilds from disk every five minutes (ADR-0043) and that travels with a project
directory into someone else's checkout.

## Decision

We will serve the roster from a single read-only endpoint, `GET /api/team`, that aggregates the
`authors` and `agents` registries and mints, writes and stores nothing. Its payload
(`TeamMemberSchema` in `packages/shared/src/team-schemas.ts`) reuses `AuthorKindSchema` and the
existing render-cache field names rather than defining new ones, and carries `ownerId` **derived at
read time** — the same pattern `TopologyAgentSchema` (`mesh-schemas.ts:443-451`) already uses to add
health and task counts the manifest does not hold. Per-source failures degrade into an optional
`warnings[]` and a 200, copying the ADR-0310 envelope from `GET /api/sessions` exactly, including its
rule that `warnings` is omitted entirely rather than sent as `[]`. When remote members exist,
`ownerId` is filled from `CommunityMemberSchema.ownerMemberId` and the shape does not change.

## Consequences

### Positive

- No new identity model, no new table, no migration: every id the roster returns already existed.
- Grouping and filtering agents by their owner is a client-side filter over a field that is present
  from the first commit, not a later schema change.
- A Buzz-like future drops in: a remote person and their agents arrive in the same shape, with
  `ownerId` already meaning what it means.
- A failing mesh read degrades to "people we could read" instead of an empty page.

### Negative

- The roster is a projection, so it has no stable id of its own to hang roster-only state on
  (per-person notes, pinning) — that would need a real row later.
- `ownerId` is computed, so on a single-user install it is a constant, and the code that computes it
  will look like ceremony until a second person exists.
- One more read surface to keep in step with `authors` and `agents` when either changes shape.
