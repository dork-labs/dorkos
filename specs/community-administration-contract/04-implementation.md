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

_(No tasks completed yet)_

## Files Modified/Created

**Source files:**

_(None yet)_

**Test files:**

_(None yet)_

## Known Issues

_(None yet)_

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
- **Task 1.4 is still open:** the wire schema exists, but local connection and room responses must project verified effective access separately from stale last-known metadata. The switcher must consume that projection rather than infer access from connection status.
- **Tasks 1.5 and 1.6 have reviewed corrections awaiting combined verification:** legacy namespace reconciliation now runs only after owner authorization. An authorized retry of an existing deletion job returns that job before checking already-deleted object bytes. Both causal regressions pass independently.
- Final combined PostgreSQL verification and independent composition review are required before opening the API PR. Earlier test counts below are historical evidence, not final acceptance of the combined branch.
- DOR-2177 administration UI has its own reviewed branch and browser evidence; DOR-2178 remains the full cross-tenant administration proof gate.

### Combined deletion verification

- Combined reviewed deletion fixes with the suspended-discovery regression, preserving both sides of the test-file merge.
- From the repository root: `COMMUNITY_TEST_DATABASE_URL=<isolated local Postgres> VITEST_MAX_WORKERS=4 pnpm exec vitest run --root apps/community --config vitest.pg.config.ts --maxWorkers=1 --fileParallelism=false` passed all 13 files: **162 passed, 4 declared skips**. The owned PostgreSQL container was stopped afterward.
- This completes the combined deletion test run, not task 1.4's still-pending local access projection or the final API review.
