# Implementation Summary: Community Membership Journeys

**Created:** 2026-09-21
**Last Updated:** 2026-09-21
**Spec:** specs/community-membership-journeys/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 0 / 10

## Tasks Completed

### Session 1 - 2026-09-21

**Workers:** `/root/flow_close_sol`

_(No tasks completed yet)_

### Session 2 - 2026-09-21

**Worker:** `/root/flow_close_sol`

- Began DOR-2181 Task 2.4 with the first-host atomic setup boundary. The task remains open for the later creation/claim and deployment-choice experience.
- Replaced the split first-install signup, owner claim, and channel creation path with one transaction that creates the credential account, host operator, first community, owner membership/handle, first public channel membership, and consumed grant. Browser sign-in begins only after that commit.
- Removed first-install authority from ordinary Better Auth signup and removed the superseded bootstrap-claim route, so a caller cannot intentionally leave an orphan first account before tenant setup.
- Added real Postgres rollback and two-contender proofs. An injected failure immediately before channel creation rolls every account and tenant row back while leaving the grant retryable; concurrent completion yields one full setup and no loser account.
- Updated existing Postgres and pairing fixtures to use the supported atomic setup path.

## Files Modified/Created

**Source files:**

- `apps/community/src/app.ts` — atomic first-host completion route.
- `apps/community/src/auth.ts` — first-install grants no longer authorize ordinary account signup.
- `apps/community/src/browser/components/Admission.tsx` — one setup submission followed by normal sign-in.
- `packages/shared/src/community-wire.ts` — strict first-host request and response contract.
- `apps/community/API.md` — supported first-host route sequence.
- `specs/community-membership-journeys/03-tasks.{json,md}` — explicit atomic first-host acceptance.
- `specs/community-membership-journeys/04-implementation.md` — live Phase 1 and Phase 2 execution receipt.

**Test files:**

- `apps/community/src/__tests__/first-host-bootstrap.integration.test.ts` — atomic success, rollback, and concurrent-winner proof.
- `apps/community/src/__tests__/bootstrap-test-helper.ts` — production-path setup helper for integration fixtures.
- Existing Community Postgres and pairing fixtures now use the atomic setup route.

## Known Issues

- DOR-2176 owns migration `0010_administration.sql` and the administration lifecycle/grant schema. This branch reserves migration `0011` and must compose with the reviewed DOR-2176 migration before final verification.
- Task 2.4 remains incomplete: later-community creation/claim and the separate host-deployment choice still require their entry experience.

## Implementation Notes

### Session 1

- Implementing Phase 1 tasks 1.1–1.4 for DOR-2180 on the reviewed DOR-2173 native-participation base.
- Raw invite fragments will be captured and erased by an inline synchronous bootstrap before browser modules, network calls, analytics, or third-party code run.
- Admission state will be tenant-, invite-, cookie-, and account-bound. Redemption will not require the raw invitation after preflight and will retain a short-lived content-free receipt for idempotent retry.
- DOR-2176 remains the authority for archived `history_only` grants and administration lifecycle behavior; this batch does not duplicate that schema.

### Session 2

- Password hashing completes before the setup transaction. The transaction remains short and serializes first-install contenders with the existing host bootstrap advisory lock.
- The completion response contains only public community/member/channel IDs. It never creates or returns a browser session; the browser establishes its session through the normal sign-in endpoint after commit.
- Verification evidence: the full Community Postgres suite passed 163 assertions with four declared skips across 14 files; Community typecheck, Community build, and lint completed with zero errors. The pairing browser test could not launch because this worktree lacks Playwright's Chromium binary; its server-side setup completed before the tooling-only launch failure.
