# Implementation Summary: Community tenant identity, authorization, and migration contracts

**Created:** 2026-09-20
**Last Updated:** 2026-09-20
**Spec:** specs/community-tenancy-contract/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 1 / 12

## Tasks Completed

### Session 1 - 2026-09-20

**Workers:** _(none — implementation remains in this owning session)_

Task 1.1 remains open until attachment and export writes use the reservation protocol. Its schema-expand slice is complete:

- Added community lifecycle/version state and host-operator authority without removing singleton constraints.
- Added nullable tenant columns, lookup indexes, and composite candidate keys needed by later backfill/constraint steps.
- Added tenant-qualified managed-blob reservations that distinguish unknown cleanup ownership from stored and committed metadata.
- Registered migration 0005 while preserving current single-community route behavior.

### Session 2 - 2026-09-20

**Workers:** _(none — implementation remains in this owning session)_

Task 1.1 is complete:

- Attachment and export writes reserve an opaque key with tenant ownership and lifecycle version before storage I/O.
- The content-reference transaction rechecks the active lifecycle version, records verified stored metadata, writes the tenant-qualified reference, and commits inventory atomically.
- Failed or uncertain writes retain tenant-qualified cleanup ownership until deletion succeeds.
- Reservations have a finite one-hour writer lease. Reference commit refuses an expired lease, and stale reservations enter a one-minute quarantine before their first cleanup attempt.
- The existing cleanup worker preserves committed objects, discovers interrupted reserved, stored, and pending-delete inventory, and retries managed deletions. A known-settled failed delete removes inventory after confirmed deletion. An uncertain interrupted writer retains a content-free tenant tombstone and hourly same-key cleanup until the pre-second-tenant namespace reconciliation gate can prove the writer and object are gone.
- Expired attachment and export cleanup reconciles the managed inventory while retaining legacy-row compatibility.

## Files Modified/Created

**Source files:**

- `apps/community/migrations/0005_tenant_expand.sql`
- `apps/community/src/migrate.ts`
- `apps/community/src/schema.ts`
- `apps/community/src/routes/attachments.ts`
- `apps/community/src/routes/exports.ts`
- `apps/community/src/storage/blob-store.ts`
- `apps/community/src/storage/index.ts`
- `apps/community/src/storage/managed-blobs.ts`
- `apps/community/src/storage/pending-deletions.ts`

**Test files:**

- `apps/community/src/__tests__/migrate.integration.test.ts`
- `apps/community/src/__tests__/attachments.integration.test.ts`
- `apps/community/src/storage/__tests__/blob-store.contract.test.ts`

## Known Issues

_(None yet)_

## Implementation Notes

### Session 1

- Worktree: `/Users/doriancollier/.dork/workspaces/dorkos/codex-community-tenant-persistence`
- Branch: `codex/community-tenant-persistence`
- Pinned base: `f85e04275a3d7b33b8210ac0288acc9d81f320fa`
- Initial batch: amend tasks 1.1 and 1.2 with the accepted pre-second-tenant blob inventory/reservation and legacy namespace reconciliation gate, then implement and verify that expand/backfill foundation before later constraints or HTTP authorization.
- Host-load policy: run one bounded targeted verification command at a time; no broad suite until the batch is stable.
- Worktree-local dependencies installed with `pnpm install --frozen-lockfile`; no dependency symlink points at another checkout.
- Schema-expand verification: Community typecheck passed after building worktree-local `@dork-labs/cloud-api` and `@dorkos/shared` outputs. The targeted real-Postgres migration suite passed 3/3, covering a fresh database, a populated v1 upgrade, and a populated v4 upgrade with attachment, export, and pending cleanup rows.
- Next slice: make attachment/export object writes reserve a server-generated key before storage, persist uncertain writes as tenant-owned cleanup, and recheck the community lifecycle version before committing the content reference.

### Session 2

- Worktree: `/Users/doriancollier/.dork/workspaces/dorkos/codex-community-tenant-blob-inventory`
- Branch: `codex/community-tenant-blob-inventory`
- Stacked base: schema-expand head `1494cbcbd1df188b7f5cdfeaf92e807fb81622bd` (PR #1954).
- Real HTTP/Postgres coverage proves reservation exists before the storage call, a lifecycle change or expired lease rejects the reference, active reservations survive cleanup, stale and interrupted inventory is quarantined and retried using the same key, an object published after the first uncertain cleanup is deleted on the next pass, failed cleanup remains tenant-owned, the worker never deletes a committed referenced object, and known-settled cleanup removes both bytes and inventory.
- Next slice: task 1.2 inventories and backfills every legacy attachment, export, pending deletion, and provider object while the deployment still has zero or one community; ambiguity blocks second-tenant creation.
