# Implementation Summary: Community administration lifecycle contract

**Created:** 2026-09-21
**Last Updated:** 2026-09-23
**Spec:** `specs/community-administration-contract/02-specification.md`

## Progress

**Status:** In Progress (9 of 10 tasks done)
**Tasks Completed:** 1.1–1.6, 2.1, 2.2 and 3.2 are done on `main`. Task 3.1 is open on one acceptance criterion: administration with Cloud egress blocked has not been exercised.

## Tasks Completed

### Session 1 - 2026-09-21

**Workers:** `/root/fly_readiness_sol`

- Initial schema, routes, and worker implementation; subsequent acceptance and corrections are recorded below.

## Files Modified/Created

**Source files:**

- Lifecycle migration and schema; administration/host routes; exact-tenant deletion worker and storage cleanup; shared access DTOs; local connection and remote route enforcement.

**Test files:**

- PostgreSQL schema, role, lifecycle, deletion, and storage concurrency tests; local route and background stream capability tests.

## Known Issues

- Task 3.1 still needs one proof: "Cloud egress can be blocked without breaking administration". `apps/community/src/__tests__/tenancy-egress.integration.test.ts` blocks outbound TCP, DNS and UDP and exercises host creation, the owner claim, recovery and the deletion and tombstone sweeps. It does not send a settings edit, archive, restore, transfer, suspend or deletion request. The server code has no outbound client other than the optional S3 blob driver, so this is expected to pass, but it has not been run. Adding those calls to the egress journey closes the task.

## Implementation Notes

### Session 1

- Isolated worktree: `/Users/doriancollier/.codex/worktrees/community-admin-api/dorkos`
- Branch: `codex/community-admin-api`
- Pinned accepted authorization base: `27f25149d21eb0410f30acb14d244bcf2231f693`
- DOR-2176 is claimed and projected to EXECUTE / In Progress.

### Session 2 - 2026-09-21

**Workers:** `/root/admin_continue_terra`

- Implemented the initial 1.1–1.6 paths: lifecycle/admin schema, host claims and metadata, settings/icons, archive and history-only grants, owner deletion, and bounded tenant deletion. Independent review and acceptance work below supersede the initial completion claim.
- Added the public `CommunityConnectionAccess` wire schema and archived-grant capability rules.
- Added archive revocation and deterministic lock-order integration proof.

## Verification

- `pnpm vitest run --config vitest.pg.config.ts --maxWorkers 1 --fileParallelism false` — 148 passed, 4 skipped.
- Shared and Community typechecks pass; their lint commands pass with existing warnings.

### Review and composition follow-through

- The reviewed API composition includes requesting-owner deletion status recovery, deletion-pending traffic denial, safe current settings on stale-version conflicts, archived personal grant revocation, and suspended public discovery refusal.
- Deletion keeps tenant-owned cleanup records when a storage write rejects but can still publish late. Focused regression tests cover successful and failed immediate deletion, late publication, and an old-behavior mutation that fails the assertions.
- **Task 1.4 backend is implemented and independently reviewed:** local connection and room responses now project verified effective access separately from stale last-known metadata. Every live route checks its precise capability before remote I/O. Production status changes refresh background agent subscriptions, stopping streams when authority becomes unverified. Protective local agent revocation remains available during an outage. Switcher presentation is tracked separately in DOR-2184.
- **Tasks 1.5 and 1.6 have independently reviewed corrections and combined verification:** legacy namespace reconciliation now runs only after owner authorization. An authorized retry of an existing deletion job returns that job before checking already-deleted object bytes. Both causal regressions pass independently.
- Final combined PostgreSQL verification and independent composition review are required before opening the API PR. Earlier test counts below are historical evidence, not final acceptance of the combined branch.
- DOR-2177 administration UI has its own reviewed branch and browser evidence; DOR-2178 remains the full cross-tenant administration proof gate.

### Combined deletion verification

- Combined reviewed deletion fixes with the suspended-discovery regression, preserving both sides of the test-file merge.
- From the repository root: `COMMUNITY_TEST_DATABASE_URL=<isolated local Postgres> VITEST_MAX_WORKERS=4 pnpm exec vitest run --root apps/community --config vitest.pg.config.ts --maxWorkers=1 --fileParallelism=false` passed all 13 files: **162 passed, 4 declared skips**. The owned PostgreSQL container was stopped afterward.
- This completes the combined deletion test run. The access projection was subsequently reviewed through exact head `4b70c1997020ef0102087cee78efc3b31f47cc7c` with zero Important or Nit findings; its main composition `a98fb6ece68bd723aed07c99c14a35c3c4b784bd` preserves the same source tree. Final API composition review remains required.

### Final API composition verification

- Combined the accepted access projection and administration implementation with native participation based on merged tenant authorization. Conflict resolutions retain the reviewed API superset; production source remains identical to the accepted access composition.
- Fresh full PostgreSQL run after composition: **13 files passed, 162 passed, 4 declared skips**. The owned `dorkos-admin-composition-pg` container was stopped immediately afterward.
- Final independent composition review remains open; no claim is made yet that the full administration programme or its browser proof is complete.

### Administration UI composition

- Root resumed the independently reviewed UI head `b5a2a95dc9789d6cccc32606caa58ea87b175512` after explicit sole-writer handoff, then composed final API `074d159a3c261f4bd88649c2cbdac20b83d95018`. UI source is unchanged from the accepted head; backend source is the accepted API.
- Fresh production build and all three Community browser scenarios passed using installed Chrome: the owner/member administration journey, desktop pairing approval, and narrow keyboard pairing. The run used one worker, no retries, unchanged deadlines, and an isolated PostgreSQL database; its container was stopped afterward.
- These pairing fixtures begin authenticated. The reported signed-out approval page dead end is explicitly outside this proof and is being corrected under DOR-2181 with a fresh no-cookie browser case.
- The UI remains pending final composition review and merge; DOR-2178 owns the wider permission/concurrency proof matrix.

### Standalone API browser compatibility

- CI passed all 162 PostgreSQL assertions but exposed a browser fixture that created an invalid suspended state. Updated the fixture with the required prior lifecycle and timestamp.
- The causal rerun then exposed a real compatibility gap: the pre-administration browser only recognized `COMMUNITY_UNAVAILABLE`, while the API now distinguishes suspension and pending deletion. Moved the already-reviewed administration UI lifecycle-error helper into this API slice so it can land independently.
- Fresh production build and the complete three-case browser suite now pass (one worker, no retries, unchanged deadlines). The suspension case returns the affected member to the chooser. The owned PostgreSQL container was stopped after verification.

### Administration review corrections

- Confirmation dialogs now announce failed archive, restore, deletion, and cancellation attempts inside the modal while retaining retry inputs. Lifecycle conflicts refresh authoritative state; browser tests advance the persisted version before the first refusal and prove the real retry succeeds.
- Direct deletion recovery checks the signed-in account's host membership before rendering owner controls. Community export has one home under Settings; Account retains personal export.
- Exact corrections `1a474607f37e40eb1cacc1d17e96a53d5174c859` and `ea455da765caca73cc54a5d54cbd94297aa94a9f` independently accepted. Final correction browser run: **3 passed**, no retries, unchanged deadlines. The API parent supplies the required access fields in client test fixtures; all five affected files pass **36 tests**.
- API and UI PRs remain held in dependency order. These results do not complete the wider cross-tenant or packaged Desktop acceptance matrix, or deploy the signed-out pairing correction.

### Session 3 - 2026-09-23: task-by-task audit on `main` 30df6cdc2

Each task was checked against code and tests on `main`:

- **1.1** done (#1984): `migrations/0010_administration.sql`; `administration-schema.integration.test.ts` covers lifecycle and resume combinations, tenant-bound icon inventory and deletion progress, lock order, and content-free tombstones. #1994 proves a populated version-four host upgrades (`migrate.integration.test.ts`).
- **1.2** done (#1984): `routes/host.ts`; `administration.integration.test.ts` "creates a pending tenant idempotently and rotates its private owner claim"; `owner-claim-locks.integration.test.ts`; host rows of the role matrix (#2001).
- **1.3** done (#1984, #2001): settings ETags and canonical addressing, private raster icons (SVG refused with 415, replaced bytes queued), `attachments.integration.test.ts` "reclaims a stored upload when the community lifecycle changes before metadata commit". #2001 fixed a closed community that still admitted people.
- **1.4** done (#1984): "archives with immediate credential revocation and restores without revival" (history-only `read`-only grant), `admission.integration.test.ts` transfer race (one owner) and suspension closing live streams, role matrix transfer/archive/restore rows.
- **1.5** done (#1984): "requests deletion idempotently and cancels back to archived without reviving access" (worker claims nothing before the deadline, retry keeps `deleteAfter`, `423` while pending).
- **1.6** done (#1984, #1996): `deletion-worker.ts`; "deletes only the due tenant after every owned blob is confirmed absent" with a held export reservation, injected provider failure, retry, tombstone fields and 30-day expiry.
- **2.1** done (#1985, #2001): `HostAdministration.tsx`, `CommunityAdministration.tsx`; `browser-tests/community.spec.ts` at desktop and 390px, by keyboard.
- **2.2** done (#1985): `DeletionRecovery.tsx`; the browser suite checks dialog focus, in-dialog failures with retained inputs, archived read-only history, deletion and cancellation.
- **3.1** open on the egress criterion above. The rest is proven: the role matrix (`04-role-matrix-verification.md`, 399 tests), the foreign-object matrix (`04-isolation-verification.md`), races in `tenancy-concurrency.integration.test.ts` and `admission.integration.test.ts`, and a two-Desktop acceptance run on `main` 30df6cdc2, 20/20 steps, covering switching (#1992), membership and administration together.
- **3.2** done (#1996, #1997, #2000, #1988): deletion proof and survivor manifest in `04-isolation-verification.md`, third-community deletion under load in `tenancy-concurrency.integration.test.ts`, and the backup/restore rehearsal `apps/community/scripts/rehearse-backup-restore.mjs` (passed twice, per #1988), documented in `apps/community/OPERATIONS.md` as separate from an owner export.
