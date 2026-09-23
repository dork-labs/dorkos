# Implementation Summary: Community Membership Journeys

**Created:** 2026-09-21
**Last Updated:** 2026-09-23
**Spec:** specs/community-membership-journeys/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 5 / 10 (1.1–1.4 and 2.4; audited against main 5cd6dd794 on 2026-09-23)

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

### Session 3 - 2026-09-21

**Worker:** `/root/flow_close_sol`

- Began DOR-2181 Task 2.3 by repairing the signed-out installation-pairing entry path. Both singleton `/pairing` and tenant-qualified `/c/:communityId/pairing` requests now show an inline sign-in form, preserve the exact server-side request, and reload its status after authentication without accepting a return URL.
- Replaced the preauthenticated browser fixtures with real signed-out journeys for both URL shapes. The narrow case begins with keyboard focus in the sign-in form, signs in, reviews an escaped hostile installation name, and declines the request.
- Task 2.3 remains open for the broader account controls and final journey proof.

### Session 4 - 2026-09-21

**Worker:** `/root/membership_finish_terra`

- Advanced DOR-2181 Task 2.1 for archived memberships. The chooser now labels archived memberships as “Read history,” opens their canonical tenant route, and keeps them available alongside active memberships.
- The tenant shell refreshes authoritative host membership lifecycle before rendering. An archived community has no live stream, channel join, composer, attachment, membership, agent, invitation, or leave controls; history, personal export, and owner restore/deletion controls remain available at their intended scopes.
- Composed the reviewed administration recovery changes: lifecycle-conflict errors stay in their active dialog, deletion recovery resolves actual owner membership from the host before revealing controls, and a retry refreshes lifecycle authority so it uses the current version.
- Admission now pauses after a successful invitation so people can choose “Open community” or follow the separate installation connection path in DorkOS. Host administration distinguishes creating a community on this host from deploying a separate host and links to deployment help.

### Session 5 - 2026-09-23 (status audit)

- The Phase 1 protocol, atomic first host and archived entry above landed in #1987 (d37c13def).
- #1999 (5170f04b3) added the `/claim` owner-claim page and the host administration "Owner claim link", which closes Task 2.4.
- #2002 (538a6c580) routed the DorkOS switcher's Leave, Invite and settings actions to the Community's own pages and its Disconnect to the local connection; that work is tracked in `specs/community-switcher-navigation/`.
- The two-Desktop acceptance run passed 20/20 steps on main 30df6cdc2 (evidence local). Its durable driver is PR #2016, still open. That PR's extended run on main 8c4bb8490 adds steps 20–29 and reports two product-contract failures, listed under Remaining Work.

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
- Combined membership plus atomic first-host composition at exact `89d22693405b360ffc0d51909bea87d920790e68`: focused admission/first-host Postgres passed **26/26**, Community typecheck and normal hooks passed, and independent composition review found **0 Important / 0 Nit**.
- Signed-out pairing entry checkpoint: Community production build and the two real browser journeys passed **2/2** with one worker. The canonical case retained the exact approval URL through sign-in; the singleton narrow case proved keyboard entry, escaped display, and cancellation.
- Archived chooser and administration-retry composition: Community production build passed and the real PostgreSQL browser journey passed **1/1**, including archive, chooser return, read-only history without a stream or composer, and stale lifecycle-version retry for archive, deletion, and cancellation.

## Remaining Work

- **2.1 entry proof (DOR-2181).** The chooser states exist. Still needed: browser proof of the zero-membership, suspended, removed and stale last-selection routes, and focus/keyboard behaviour at narrow widths.
- **2.2 invitation review (DOR-2181).** The preview must survive a reload from server state (there is no read of the pending admission today). Failures must say membership was not added and offer one recovery action. An account created before a failed redeem must be reported as such. Inactive members need the reactivation scope, and step changes need focus moves and announcements.
- **2.3 separate controls (DOR-2181).** The Community app needs a browser sign-out control and a "disconnect all my installations" control (the API exists), with scope summaries that name what ends and what remains. DorkOS's Disconnect must also revoke the selected grant on the Community, not only delete the local credential (`PairingService.disconnect`; found by PR #2016 step 25).
- **3.1 cross-device proof (DOR-2182).** Covered by the two-Desktop acceptance run on main 30df6cdc2 (20/20 steps). It closes when the durable driver, PR #2016, merges.
- **3.2 exact-scope proof (DOR-2182).** Blocked on the 2.3 Disconnect fix, and on Community refusals being passed through rather than reported as 502 "Community unavailable." (`apps/server/src/routes/remote-communities.ts` `fail`). Both were found by PR #2016's extended run. Accessibility and Cloud-unavailable proof across the whole journey set is still to be written.
