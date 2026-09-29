---
id: 260928-001608
title: Resolve Cloud identity under the credential that will use it
status: accepted
created: 2026-09-27
spec: cloud-instance-identity-adoption
superseded-by: null
---

# 260928-001608. Resolve Cloud identity under the credential that will use it

## Status

Accepted on 2026-09-28 after implementing and testing [DOR-2348's specification](../specs/cloud-instance-identity-adoption/02-specification.md). This records a client adoption decision; it does not claim deployment or retirement readiness.

## Context

The inference caller identifies an instance using a hash of its linked credential, so credential rotation changes the reference even when the service registration survives. The public session contract already returns the credential's authoritative instance identity. Persisting the legacy heartbeat's ID would add migration and stale-write handling without proving that the `/v1` authority accepts the same relationship.

## Decision

We will resolve identity through `/v1/session` against an immutable snapshot of the credential and authority origin immediately before minting an inference token. We will accept only authenticated instance sessions and bind both asynchronous results and subsequent launch state to that same current snapshot. We will add no persistent identity or telemetry dependency for this consumer, and an unavailable identity route will leave minting unavailable. Credential material tracking for managed Connections and migration of other endpoint families remain separate decisions.

## Consequences

### Positive

- Identity comes from the authenticated authority; credential changes no longer invent instance IDs.
- Existing configs recover lazily without migration, and obsolete local links cannot keep old inference state ready.
- The context seam gives future Cloud consumers an explicit authority boundary without introducing remote enrolment.

### Negative

- Every mint adds a session request and depends on that endpoint being available.
- No persistent identity is available offline; a later consumer needing it must define its own recovery requirements.
- Local context checks cannot establish an unobserved remote revocation or undo a mint already accepted remotely.
