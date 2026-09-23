---
id: 260923-121712
title: A host hold stops growth without blocking export, and host-started deletion follows only a noticed hold
status: accepted
created: 2026-09-23
spec: community-host-operator-api
amends: 260920-201101
superseded-by: null
---

# 260923-121712. A host hold stops growth without blocking export, and host-started deletion follows only a noticed hold

## Status

Accepted (extracted from spec `community-host-operator-api`; approved by the operator on 2026-09-23). Amends `260920-201101` only in the sentence "Host authority cannot delete an active tenant": a host may start deletion of a `held` community after its published notice date. Everything else in that ADR stands, including that the host cannot cancel or speed up an owner-requested deletion. The operator approved both halves, the hold and the host-started deletion, on 2026-09-23.

## Context

A host's only tool against a problem community is suspension, which blocks every member request, including the owner's export. Hosts also need a way to reclaim a community they can no longer serve, and today that means acting on the database by hand, with no audit, notice, or export window for the owner.

## Decision

We will add a `held` lifecycle state, set and released by the host, in which the community is read-only for members, credentials are revoked as in archive, and the owner can still export and request deletion, and member erasure (`specs/community-member-erasure/`) still runs, but the owner cannot archive, restore, or transfer. A hold may carry a deletion notice date at least seven days out, shown to members. Only after that date may the host request deletion, which enters the existing seven-day `deletion_pending` state and worker with a host requester; the host can cancel it back to `held`, and the owner cannot. Suspended communities must be moved to `held` first, so the owner always gets an export window before a host-started deletion.

## Consequences

### Positive

- Hosts can stop growth without cutting people off from their own data.
- Host-started deletion is audited, noticed in advance, and reuses the proven deletion worker.
- Cancelling a deletion can never lift a hold.

### Negative

- Every lifecycle check gains a state, and the owner-lifecycle trigger and deletion checks change.
- A host-started deletion now exists online, so a compromised key with `communities:lifecycle` can begin one (still gated by notice and a seven-day wait).
- The owner has no in-product way to object; the notice banner is the only channel unless the host adds its own.
