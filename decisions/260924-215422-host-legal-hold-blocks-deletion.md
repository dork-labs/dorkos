---
id: 260924-215422
title: A host legal hold silently blocks every permanent deletion of a community until released
status: draft
created: 2026-09-24
spec: community-host-operator-api
amends: null
superseded-by: null
---

# 260924-215422. A host legal hold silently blocks every permanent deletion of a community until released

## Status

Draft (from spec `community-host-operator-api`, section "Legal hold", DOR-2299).

## Context

A host can be required to preserve a community: a court order, a regulator's request, or pending litigation. The lifecycle hold (ADR `260923-121712`) stops growth but lets the owner request deletion, which the tenant deletion worker carries out after seven days. A takedown (ADR `260923-214421`) also deletes through that worker. Nothing on the host could stop a permanent deletion while a preservation duty applied, short of editing the database by hand.

## Decision

We will add a host **legal hold**: a flag on the community, independent of its lifecycle, set and released only through its own host key scope, `communities:legal_hold`, and audited. While it stands, the tenant deletion worker does not purge the community. It never claims the job, and it re-checks the flag under a row lock before each blob and before the final row deletion. Placing the hold takes that row lock, so no byte is removed once the hold commits. The host's own deletion and abandon routes refuse with `409 LEGAL_HOLD_ACTIVE`.

The owner is **not told**. Their deletion request is accepted as usual and the community enters `deletion_pending`, so people lose access as the owner asked; only the purge waits. No tenant route, projection, banner, or error mentions the hold.

Item removals and member erasure are not blocked in this pass (open question 8 in the spec).

## Consequences

### Positive

- One gate in the worker covers every deletion path: owner, host, and takedown.
- A key that can delete a community cannot also lift the preservation that stops it.
- A hold cannot tip off the person it may concern.

### Negative

- A deletion the owner asked for can wait indefinitely with no explanation to the owner. Their deletion status can show a past deletion date that has not been carried out.
- Backing out the code while a legal hold stands would let old code purge a community the host must preserve, so every legal hold must be released before a backout.
- Content can still be removed item by item, or by erasure, under a legal hold until open question 8 is decided.
