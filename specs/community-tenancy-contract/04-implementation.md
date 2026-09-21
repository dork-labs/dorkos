# Implementation Summary: Community tenant identity, authorization, and migration contracts

**Created:** 2026-09-20
**Last Updated:** 2026-09-20
**Spec:** specs/community-tenancy-contract/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 4 / 12

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

### Session 3 - 2026-09-20

**Workers:** _(none — implementation remains in this owning session)_

Task 1.2 implementation reached VERIFY:

- Migration 0006 backfills every nullable tenant key from its authoritative relation, promotes the active owner account to host operations, invalidates legacy bootstrap grants, and leaves the namespace gate dirty.
- A durable singleton generation is invalidated by every interim inferred-owner insert, update, or delete and by unmanaged cleanup queue changes. Current attachment/export reservations share an advisory fence with reconciliation; operators must separately quiesce old instances before starting it.
- Filesystem and S3 storage expose complete namespace snapshots; S3 exhausts pagination and returns no partial result after a page failure.
- Reconciliation verifies referenced bytes and hashes, converts singleton cleanup only when a legacy queue row proves its origin, and records only the exact generation it validated. A valid-looking opaque key alone is not ownership proof; missing, ambiguous, incomplete, or unexpected objects remain untouched and return a redacted operator action.
- The full namespace scan is reserved for the future second-community creation gate. Ordinary startup does not list or hash stored objects, and a dirty generation does not delay serving the existing single community.
- This is an intermediate expand/backfill stage. Second-community creation remains unavailable until task 1.3 makes tenant keys non-null, validates composite constraints, removes the interim dirty-write triggers, and repeats the authoritative namespace check in its creation transaction.

### Session 4 - 2026-09-20

**Workers:** _(none — implementation remains in this owning session)_

Task 1.3 is complete:

- Migration 0007 backfills ordered, tenant-qualified entry mentions with distinct human and agent targets and ordered export-channel selections.
- Composite foreign keys reject cross-community targets. Missing or human/agent-ambiguous mentions and unresolved export channels abort the migration without partial state.
- Migration 0008 switches entry and export readers and writers to normalized relations, removes the legacy arrays and synchronization triggers, makes tenant ownership non-null, and installs composite foreign keys across members, channels, credentials, grants, pairings, invites, entries, files, exports, cursors, quotas, audit rows, and managed storage.
- The global member account uniqueness and community singleton constraint are removed only after validation. The database now permits one host account to belong to more than one community while retaining one membership per account in each community.
- New communities begin in `pending_owner`; the bootstrap transaction creates the first owner and activates the community atomically. Migration validates existing owner counts before removing singleton constraints. Deferred constraints require no active owner while pending and exactly one active owner while active or suspended, and memberships cannot move between communities.
- Every current route and fixture writes explicit tenant ownership. The production entry and export paths write normalized children atomically, and history, stream, archive, and access checks read them without the removed arrays.
- PostgreSQL verification covers human and agent mentions, duplicate order, export order, migration reruns, missing and ambiguous targets, unresolved channels, cross-tenant rejection, lifecycle ownership, real HTTP writes, attachment/export cleanup, recovery, admission, reconciliation, and the remote adapter. On the corrected head, the complete Community PostgreSQL run recorded 121 passes, 4 declared skips, and 2 teardown-adjacent 30-second timeouts. Each timed-out case passed in isolation, and the two affected files then passed together 13/13 with two workers and unchanged limits; the broad run is therefore not claimed fully green.

## Files Modified/Created

**Source files:**

- `apps/community/migrations/0005_tenant_expand.sql`
- `apps/community/migrations/0006_tenant_backfill.sql`
- `apps/community/migrations/0007_tenant_relations.sql`
- `apps/community/migrations/0008_tenant_contract.sql`
- `apps/community/src/migrate.ts`
- `apps/community/src/schema.ts`
- `apps/community/src/routes/entries.ts`
- `apps/community/src/routes/attachments.ts`
- `apps/community/src/routes/exports.ts`
- `apps/community/src/routes/agents.ts`
- `apps/community/src/routes/channels.ts`
- `apps/community/src/routes/events.ts`
- `apps/community/src/routes/invites.ts`
- `apps/community/src/routes/pairings.ts`
- `apps/community/src/storage/blob-store.ts`
- `apps/community/src/storage/index.ts`
- `apps/community/src/storage/managed-blobs.ts`
- `apps/community/src/storage/pending-deletions.ts`
- `apps/community/src/storage/tenant-reconciliation.ts`

**Test files:**

- `apps/community/src/__tests__/migrate.integration.test.ts`
- `apps/community/src/__tests__/foundation.integration.test.ts`
- `apps/community/src/__tests__/attachments.integration.test.ts`
- `apps/community/src/__tests__/tenant-relations.integration.test.ts`
- `apps/community/src/storage/__tests__/blob-store.contract.test.ts`
- `apps/community/src/__tests__/tenant-reconciliation.integration.test.ts`
- `apps/community/src/__tests__/recovery.integration.test.ts`
- `apps/community/src/__tests__/remote-adapter-conformance.integration.test.ts`

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

### Session 3

- Worktree: `/Users/doriancollier/.dork/workspaces/dorkos/codex-community-tenant-backfill`
- Branch: `codex/community-tenant-backfill`
- Stacked base: managed-blob head `3480796fe8a134c8dcd53875f8dd958720061dfe` (PR #1959).
- Reconciliation never emits raw object keys. Only content references, existing inventory, and durable legacy cleanup rows prove ownership. Every otherwise-unexplained object requires manual ownership resolution without automatic deletion.
- The generation triggers are deliberately conservative during this stage: inferred-owner writes make a completed reconciliation dirty. Task 1.3 replaces that compatibility fence with non-null tenant keys and validated composite constraints before any second tenant can be created.
- Targeted verification covers fresh and populated migration, attachment/export hash preservation, clean zero-community readiness, pending-cleanup conversion, incomplete and paginated listings, active and late writers, the complete legacy reference-delete and cleanup sequence, stale generations, unexplained-object refusal, and legacy null ownership. The real-Postgres migration/reconciliation set passes 13/13; the BlobStore contract and pagination set passes 12/12; Community typecheck and touched-file lint pass.
- Integration onto merged Task 1.1 exposed a lock inversion between its managed-inventory writes and Task 1.2's reconciliation-generation triggers. Attachment reservation and commit now lock channel and authority before inventory; export completion locks live membership and current-channel access first. Two deterministic PostgreSQL regressions use `pg_blocking_pids` to hold the domain lock while a competing write completes, covering the upload/cursor and export/quota cycles. The exact packaged-browser scenario that exposed the first deadlock passes 1/1.
- A second lease-boundary audit found that synchronous generation invalidation could still place the singleton generation row between quota and managed inventory, with no route-level ordering that was consistent with both cleanup and quota writers. Migration 0006 now installs every compatibility invalidator as an initially deferred constraint trigger. Writers complete their domain and inventory changes before any trigger reaches only the generation row at commit; cleanup invalidation no longer consults inventory from that commit path. Reconciliation follows the same order by applying its reversible inventory changes before locking and comparing the generation, rolling the transaction back if an older writer committed meanwhile. The second-community admission callback may lock generation first only because its callback writes communities, bootstrap grants, host/backout authority, none of which invoke a reconciliation invalidator.
- Deterministic real-Postgres coverage holds an expiring reservation across upload completion and cleanup, and separately holds a managed row across reconciliation finalization. Restoring synchronous triggers plus the prior generation-first reconciliation order fails both regressions: the upload returns 503 after PostgreSQL `40P01`, and reconciliation cannot reach its inventory upsert. Restored code passes those two proofs 2/2 and the migration, attachment, and reconciliation files 34/34. The original route-order mutant remains red 2/18 and restored 18/18; its logs and the new deferred-trigger logs are retained under `.temp/tenant-backfill-review/`.

### Session 4

- Worktree: `/Users/doriancollier/.dork/workspaces/dorkos/codex-community-tenant-constraints`
- Branch: `codex/community-tenant-constraints`
- Stacked base: accepted reconciliation head `c211a0b6b1fa7bd89001423cb9aae4bd485ad26f` (PR #1968).
- The contract migration validates and locks the normalized model before removing arrays, compatibility triggers, singleton/global uniqueness, and nullable ownership. Existing single-community behavior remains available while the schema can now represent independent tenant membership safely.
- Targeted real-Postgres verification passes attachments 16/16, recovery 5/5, remote adapter 52/52 active checks, reconciliation 10/10, and admission 16/16. The corrected-head complete Community PostgreSQL run recorded 121 passes, 4 declared skips, and 2 timeouts: the populated migration case timed out at 30 seconds, and reconciliation cleanup timed out while ending its pool. Both cases passed alone, and both files passed together 13/13 with `maxWorkers=2` and unchanged limits. This receipt preserves that full-run result rather than treating the reruns as a retroactive all-green gate.
- Task 1.4 is complete: the supported backout is a coordinated pre-migration database/object restore into an isolated deployment of the original image. Migration 0009 permanently refuses backout after a second community has ever existed, even if later deleted. The read-only diagnostic cannot authorize or perform a restore.
- Targeted PostgreSQL migration/backout verification passed 9/9. A durable-history mutation failed 1/6 with the latch removed and passed 6/6 after restoration. A real PostgreSQL 17 dump/restore rehearsal preserved every original public table row and matching file bytes while correctly excluding a post-backup write. Independent review accepted the exact Task 1.4 commit with 0 Important and 0 Nit findings.
- Next task: tenant-qualified HTTP authorization and account-wide recovery complete Tasks 2.x before any multi-community rollout.

### Session 5 - 2026-09-20

**Workers:** _(none — implementation remains in this owning session)_

Tasks 2.1 through 2.3 reached VERIFY:

- Canonical `/c/:communityId` browser paths and `/api/v1/communities/:communityId` APIs select one immutable UUID. The compatibility alias works for one community and returns `COMMUNITY_SELECTION_REQUIRED` as soon as a second row exists.
- Cookie, personal-grant, and agent principals carry tenant identity through member, channel, entry, attachment, export, invitation, pairing, cursor, quota, cleanup, recovery, and SSE paths. Mutations recheck the selected active lifecycle and exact credential on their transaction connection.
- Removing one membership keeps the host session and another community membership. Cross-community object IDs return `404`, and a bearer issued in one community is rejected in another.
- First installation now requires zero communities, members, and host operators under the bootstrap lock. It atomically creates the first pending community, owner membership, active lifecycle, and host operator; pending-only or operator-residue hosts fail closed instead of minting a replacement owner.
- Host operators can list only operational community metadata, create a pending community, and suspend or resume a claimed community. They gain no content access. Second-community creation repeats authoritative namespace reconciliation while holding the current-writer fence; later creation stays tenant-qualified.
- Owner-claim grants bind one pre-created pending community. Sign-up and redemption both recheck that lifecycle; concurrent claimants produce one owner and one refusal. Active or suspended communities reject ordinary owner claims, and no online lost-owner repair endpoint exists.
- Password recovery remains host-wide: it revokes host sessions and membership-derived credentials across every community and writes a tenant-scoped audit receipt without reactivating membership.
- Community lint and typecheck pass. Fresh PostgreSQL 17 bootstrap and admission files pass 18/18, including concurrent owner claims, operator suspension serialized against a blocked member post, same-account membership removal with the other community session preserved, cross-tenant bearer/object refusals, and first-install corruption guards.
- The branch composes the independently accepted Task 1.4 backout commit and receipt exactly. It also composes the final reviewed Task 1.2 deferred-invalidation head, keeping normalized export-channel writes after managed-blob preparation and retaining all three lock-order regressions.
- The first combined PostgreSQL run exposed three integration expectations and one worktree-native dependency gap: the final contract intentionally retains only the two managed cleanup invalidators, member leave preserves the host session and returns tenant-scoped `403`, export authority now blocks on the tenant-qualified role lock, and `better-sqlite3` needed a worktree-local Node 24 rebuild. After correcting those expectations and rebuilding the local native module, the failed files passed 74 active assertions with 4 declared skips. The final complete PostgreSQL gate passed 138 active assertions with 4 declared skips across 10 fixtures.
- Seven of twelve tasks are complete; DOR-2173 owns tenant-qualified discovery/native participation next, while final isolation and upgrade proof remain in DOR-2174.

### Session 6 - 2026-09-21

**Workers:** independent sibling review by `/root/fly_readiness_sol`; corrections remain in this owning session.

- Review found that canonical pairing approval URLs reached the SPA but the browser entry selected Pairing only for the legacy `/pairing` path. The browser root now renders Pairing for the exact `/c/:communityId/pairing` shape, and the existing Playwright pairing flow uses the actual server-issued canonical URL. Both desktop and narrow-viewport cases pass 2/2.
- Review also found that an already-open SSE stream rechecked credential, member, and channel state but not the selected community lifecycle. Human and agent access checks now require that same tenant to remain active. The real HTTP/PostgreSQL admission suite passes 17/17 and proves suspending B closes B's stream while A continues to deliver an entry.
- Removing the lifecycle joins makes that same real-PostgreSQL test fail because B emits an entry after suspension; restoring the fix returns the suite to green. The red run is retained at `.temp/tenant-authorization-review/suspension-mutant.log`.
