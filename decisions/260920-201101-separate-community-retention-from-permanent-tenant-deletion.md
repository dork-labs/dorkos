---
id: 260920-201101
title: Separate community retention from permanent tenant deletion
status: accepted
created: 2026-09-20
spec: community-administration-contract
superseded-by: null
---

# 260920-201101. Separate community retention from permanent tenant deletion

## Status

Accepted.

## Context

Community owners need both a reversible way to stop activity and a permanent way to remove one tenant. Immediate cascading deletion cannot coordinate PostgreSQL and object storage safely. Indefinite soft deletion does not honor permanent deletion. Host operators also need to suspend an unhealthy tenant without gaining its owner's content authority.

## Decision

Archive is the reversible retention state. It keeps tenant rows and blobs but immediately ends writes, invitations, pairings, grants, agents, and streams. Restore reopens member traffic without reviving machine credentials.

Permanent deletion is a separate owner-authorized workflow: recent reauthentication and explicit identity confirmation create a seven-day cancelable deletion job. Access ends immediately. Every object write first records durable tenant ownership before storing bytes and rechecks lifecycle state when its content reference commits. After the deadline, a bounded idempotent worker deletes the tenant's complete blob inventory—including unfinished uploads and pending cleanup—before deleting tenant rows. Failures retain exact progress for retry. A metadata-only host tombstone survives for 30 days and then expires.

DOR-2172 establishes the inventory/reservation protocol and reconciles the whole managed object namespace before it enables a second community, while ownership is still unambiguous. Legacy pending deletions and unreferenced objects are drained or converted to tenant-qualified inventory; an incomplete or ambiguous inventory blocks that gate. DOR-2176 later extends the same inventory to icons and lifecycle deletion progress.

Host suspension is operational and records the prior active/archive state. Host authority cannot delete an active tenant, cancel its owner-requested deletion, read its content, or mint a replacement owner.

## Consequences

### Positive

- Owners can pause a community without risking its history.
- Permanent deletion reaches referenced and orphaned tenant objects plus database rows and survives partial failure.
- Access revocation does not wait for a cleanup worker.
- Another tenant on the host remains outside every deletion query and job.
- Host operations remain distinct from content authority.

### Negative

- The service needs lifecycle versions, tenant-qualified blob reservations/inventory, deletion jobs, per-blob progress, and a bounded worker.
- Permanent deletion takes at least seven days unless a future contract changes the grace period.
- Restore requires installations and agents to reconnect because credentials stay revoked.
- Selective recovery of a deleted tenant is not supported by host-wide disaster-recovery backups.
