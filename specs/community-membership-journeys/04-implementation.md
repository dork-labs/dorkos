# Implementation Summary: Community Membership Journeys

**Created:** 2026-09-21
**Last Updated:** 2026-09-21
**Spec:** specs/community-membership-journeys/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 4 / 10

## Tasks Completed

### Session 1 - 2026-09-21

**Worker:** `/root/flow_close_sol`

- [x] **1.1** Erase invite fragments synchronously, then exchange them for tenant-bound pending admission.
- [x] **1.2** Bind admission to one account and implement atomic, receipt-backed join/reactivation redemption.
- [x] **1.3** Scope leave, removal, sign-out, and tenant-derived revocation.
- [x] **1.4** Complete tenant-bound installation pairing and authoritative disconnect status.

### Session 2 - 2026-09-21

**Worker:** `/root/flow_close_sol`

- Began DOR-2181 Task 2.4 with the first-host atomic setup boundary. The task remains open for later-community creation/claim and the separate host-deployment choice.
- Replaced the split first-install signup, owner claim, and channel creation path with one transaction that creates the credential account, host operator, first community, owner membership/handle, first public channel membership, and consumed grant. Browser sign-in begins only after that commit.
- Removed first-install authority from ordinary Better Auth signup and removed the superseded bootstrap-claim route, so a caller cannot intentionally leave an orphan first account before tenant setup.
- Added real Postgres rollback and two-contender proofs. An injected failure immediately before channel creation rolls every account and tenant row back while leaving the grant retryable; concurrent completion yields one full setup and no loser account.
- Updated existing Postgres and pairing fixtures to use the supported atomic setup path.

## Files Modified/Created

**Source files:**

- `apps/community/src/browser/index.html` and `invite-fragment.ts` — synchronously capture invitation fragments before module or network work, then erase the page-memory holder after accepted preflight.
- `apps/community/src/browser/CommunityApp.tsx`, `Admission.tsx`, `Manage.tsx`, and `CommunityChooser.tsx` — resume clean-URL admission, tenant-scoped leave, explicit installation controls, and atomic first-host completion followed by normal sign-in.
- `apps/community/src/routes/invites.ts`, `members.ts`, and `pairings.ts` — account-bound admission receipts, bounded expired-transaction cleanup, atomic join/reactivation, lifecycle-safe scoped revocation, and current-password confirmation.
- `apps/community/src/app.ts` and `auth.ts` — atomic first-host completion and removal of first-install authority from ordinary signup.
- `apps/community/migrations/0011_membership_protocol.sql` and `schema.ts` — durable account binding and short-lived content-free admission receipts after administration migration `0010`.
- `packages/shared/src/community-wire.ts` — strict request and response contracts for first-host setup, admission, leave, and installation disconnect.
- `apps/community/API.md` and `specs/community-server/02-specification.md` — supported first-host preflight/completion contract.
- Reviewed access-projection exact head `4b70c1997020ef0102087cee78efc3b31f47cc7c` — authoritative verified/unverified/reconnect-required access and effective capability enforcement for local Community participation.

**Test files:**

- `apps/community/src/__tests__/admission.integration.test.ts` — account switching, final-seat contention, same-account replay settlement, reactivation cleanup, scoped departure, pairing, and tenant isolation.
- `apps/community/src/__tests__/first-host-bootstrap.integration.test.ts` — atomic success, rollback, and concurrent-winner proof.
- `apps/community/src/__tests__/bootstrap-test-helper.ts` — production-path setup helper for integration fixtures.
- `apps/community/src/__tests__/migrate.integration.test.ts` — populated migration and constraint coverage through `0011`.
- `apps/community/browser-tests/community.spec.ts` and `pairing.spec.ts` — clean fragment capture, reload/OAuth continuation, admission, revocation, and atomic setup fixtures.
- Shared wire, attachment, administration, foundation, and owner-claim fixtures were updated for the supported request shapes.

## Verification

- Composed `0010` then `0011` against reviewed administration/API and access-projection ancestry.
- Final bounded membership Community Postgres gate before atomic composition: **13/13 files, 168 passed, 4 declared skips**. Focused admission passed **23/23**, including locked-row cleanup and archived idempotent disconnect.
- Membership browser production build passed. The three installed-system Chrome cases passed **3/3** at the unchanged 90-second limit, including page-memory invite erasure before simulated unmount.
- Atomic first-host checkpoint: Community Postgres passed **163 assertions with 4 declared skips across 14 files**; Community typecheck, build, and lint had zero errors. The pairing browser server setup completed, but that worktree lacked Playwright's pinned Chromium binary.
- Atomic first-host independent review at exact `4f627449f7e1b8a3de64ba2eefdf4f0f0d88e5d3`: **0 Important / 0 Nit**.
- Membership correction independent review at exact `4b3f29b3364281e28218bfa433cbda0a83abb9ed`: **0 Important / 0 Nit**.
- A bounded combined verification run and independent composition review remain required after this merge; the evidence above describes the two accepted inputs and does not claim their union has already passed.

## Remaining Work

- DOR-2181 owns the broader entry experience: later-community creation/claim, invitation entry UI, and the separate host-deployment choice remain open.
- DOR-2182 owns packaged Desktop and cross-device journey proof.
- The combined membership and atomic-first-host tree must pass bounded relevant verification and an independent composition review before a PR.
