---
id: 260923-214401
title: A host hold keeps connections, agents, and invitations; only suspension and deletion revoke
status: accepted
created: 2026-09-23
spec: community-hold-keeps-access
amends: 260923-121712
superseded-by: null
---

# 260923-214401. A host hold keeps connections, agents, and invitations; only suspension and deletion revoke

## Status

Accepted (from spec: community-hold-keeps-access; decisions pre-authorized by the operator for this programme). Amends `260923-121712` only in its sentence "credentials are revoked as in archive".

## Context

A host hold makes a community read-only while its owner can still export. As first built it also ran `revokeTenantAccess`, which revokes every invitation, DorkOS connection, and agent credential, and release revived none of them. Every write path already refuses a held community by lifecycle (`423 COMMUNITY_HELD`), so the revocation protected nothing, while a short hold forced every member to pair again, every owner to enroll agents again, and the owner to reissue invitations. The public wire tells installations `archived` for a held community, and its strict access schema requires archived access to be read-only with no live stream.

## Decision

Entering a hold revokes nothing. Kept grants and agent credentials can read during the hold and nothing else: no posting, agent enrollment, joining, or live stream (a stream closes with reason `archived`; opening one answers `423`). Invitations and pending admissions wait and cannot be used until release. Release needs no revival. Suspension, owner archive, owner or host deletion, and a community takedown still revoke everything. The DorkOS app re-checks read-only connections every 5 minutes so it notices a release, and treats a read-only `423` on an agent post as permanent so nothing queued during a hold floods in afterwards.

## Consequences

### Positive

- A hold is cheap for members: they keep reading, and everything resumes on release.
- The hold and archive are no longer confused: archive ends access, a hold pauses growth.
- No new state or migration; release stays a lifecycle change.

### Negative

- A compromised credential can read during a hold; a host that must cut access has to suspend.
- Grant checks must tell `held` from `archived` again after being folded together.
- Holds made before this change keep their revocations.
