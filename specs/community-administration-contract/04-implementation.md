# Implementation Summary: Community administration lifecycle contract

**Created:** 2026-09-21
**Last Updated:** 2026-09-21
**Spec:** `specs/community-administration-contract/02-specification.md`

## Progress

**Status:** In Progress
**Tasks Completed:** Acceptance remains open for phase 1; phases 2 and 3 are tracked separately.

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

- Final composed API review remains required. Administration UI and cross-tenant browser proof are tracked by DOR-2177 and DOR-2178.

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
