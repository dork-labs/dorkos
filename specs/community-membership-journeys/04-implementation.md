# Implementation Summary: Community Membership Journeys

**Created:** 2026-09-21
**Last Updated:** 2026-09-23
**Spec:** specs/community-membership-journeys/02-specification.md

## Progress

**Status:** Implemented
**Tasks Completed:** 10 / 10

## Tasks Completed

### Session 1 - 2026-09-21

**Worker:** `/root/flow_close_sol`

- [x] **1.1** Erase invite fragments synchronously, then exchange them for tenant-bound pending admission.
- [x] **1.2** Bind admission to one account and implement atomic, receipt-backed join/reactivation redemption.
- [x] **1.3** Scope leave, removal, sign-out, and tenant-derived revocation.
- [x] **1.4** Complete tenant-bound installation pairing and authoritative disconnect status. (Community side only. Reopened on 2026-09-23: DorkOS's Disconnect does not revoke the grant; see Remaining Work.)

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

### Session 6 - 2026-09-23

**Branch:** `feat/community-membership-states`

- Closed DOR-2181 Task 2.1. The chooser is a labelled list that takes focus on its heading; suspended and unavailable memberships stay focusable (`aria-disabled`) and carry their reason as a description; a remembered choice the account can no longer see is forgotten. Every community route the account cannot enter, including an unknown ID that used to fall through to first-host setup, returns to the chooser with one notice that reads the same in every case. Zero memberships explain how to join and, only for a host operator, link to host administration.
- Closed DOR-2181 Task 2.2. A new read, `GET /api/v1/invites/pending`, returns the live join attempt's community, inviter, channel, expiry and (when signed in) whether the account's membership is new, active or inactive, from the HttpOnly admission cookie alone; it applies bind's liveness checks and never writes, is sent `no-store`, looks up the tenant-scoped attempt before revealing that a community is closed, and reports when the attempt is bound to a different account. The join page resumes from it after a reload or sign-in return, shows reactivation scope before an inactive member rejoins, and reports every failure as "Membership was not added." (or "Your account was created, but membership was not added.") with one recovery: try again, open the link again, or ask for a new invitation. Each step moves focus to its heading; errors are alerts.
- Removed the chooser's dead `communityPendingInvite` session-storage read (nothing wrote it) and the join-path bind/redeem retries the pending read replaces.

### Session 7 - 2026-09-23

**Branch:** `feat/community-signout-disconnect-all`

- Closed DOR-2181 Task 2.3. Settings > Account now shows three separate panels. "This browser" signs only this browser out; the page then says memberships and connected installations are unchanged and offers "Sign in again". "Connected installations" lists each installation with what it can do in words ("Can read and post"), disconnects one after a confirmation that names what ends and that the person stays a member, and, when there are two or more, disconnects all of them behind the current password. "Leave community" lists what ends and what stays. The chooser offers the same sign-out, so an account with no community it can open can still sign out.
- Signing out also forgets this browser's remembered community. The remembered-community helpers moved to `src/browser/remembered-community.ts` so the chooser and the sign-out control share them without an import cycle.
- A refused password on disconnect-all or leave now says the password was wrong and that nothing changed, next to the field, instead of "Reauthentication failed."
- DorkOS's own Disconnect already revokes its grant (#2019, 907a533e8), so no DorkOS-side change was needed here.
- Review follow-up: a wrong password on leave or disconnect-all is now its own code, `403 REAUTH_FAILED`, so the page says "That password is not right." only then and shows the server's own reason for every other refusal ("Transfer ownership before leaving.", "Your membership has ended."). Those two routes also limit wrong passwords (`src/password-confirmation.ts`): `auth.api.verifyPassword` is a server-side call that Better Auth's HTTP limiter never sees. Attempts count per host account only (`COMMUNITY_REAUTH_ATTEMPTS_PER_MINUTE`, default 5, maximum 20): each spends synchronously before its password is checked and a correct one is refunded, so a concurrent burst cannot outrun the check, and a shared proxy address cannot lock one account out through another's guesses. Once spent, the routes answer `429` without checking the password, even a correct one, until the minute passes. Proof: `account-controls.integration.test.ts` › "answers a wrong password with REAUTH_FAILED and every other refusal with its own reason" and "refuses the fourth wrong guess, and even the right one, until the minute passes"; `password-confirmation.test.ts` holds a concurrent burst open inside the check to prove exactly the budget is checked; the pg tests "checks exactly the budget from a concurrent burst…" and the same-address second account in "refuses the fourth wrong guess…" prove both properties over HTTP. A later review round routed every other server-side password check through the same helper and budget (owner transfer, owner export, archive/restore, deletion and its cancellation, host API key issue and rotate), removed the unlimited `reauthenticate` in `data.ts`, and added a source-scan guard (`password-confirmation.test.ts`) that fails if any non-test module calls `verifyPassword` directly.
- Re-audited 1.4 against #2019 and closed it (evidence in `03-tasks.md`).

### Session 8 - 2026-09-23

**Branch:** `test/community-membership-access-proof`

- Wrote the accessibility and Cloud-unavailable legs of DOR-2182 Task 3.2. The task stays open for its exact-scope leg (PR #2016's extended run, repeated on a main with #2019 and #2033).
- Community site, every membership surface (`browser-tests/membership-accessibility.spec.ts`, axe-core now a Community dev dependency): axe WCAG 2.2 A/AA at 1440px and 390px in light and dark, no sideways scroll, and every phone control at least 44px. It found and this branch fixed: muted text at 4.36:1 on the panel-alt fill (the invitation summary, the joined page's "Connect this DorkOS installation" note, host administration), now `--muted: #5f6963` (4.9:1 or better on every light surface); the "Deploy a new host" link told apart from its sentence by colour alone (1.2:1), now underlined like every link; the phone "Open channel navigation" button at 40px and the host administration owner-claim-ID field at 24px, now 44px (`.button` and `.field` controls have a 44px floor below 751px, and the claim-ID field is a styled `.field`). Keyboard-only join and leave pass with focus on each step's heading, a wrong password announced as an alert, and the chooser focused after leaving. Host API keys share the host administration page but are host operations, so they are excluded; the target check found their scope checkboxes at 16px.
- DorkOS app (`apps/e2e/tests/connections/community-membership-access.spec.ts`): the Communities list, join with an invitation, the switcher's Manage and Add actions, and the disconnect confirmation, at desktop and 390px, light and dark. It found and this branch fixed: the on/off switch on each messaging connection had no accessible name (axe `button-name`, critical), now named after the connection; `AlertDialogAction` and `AlertDialogCancel` wore the 36px desktop height on phones, now the shared 44px `TOUCH_TARGET_RESPONSIVE_H` like `Button`. It also found the unfinished-disconnect message pointing at "Local connections", a panel #2033 renamed "Connected installations"; the copy now says where to finish.
- Not fixed, recorded in the e2e report instead: the shared `--destructive` token misses 4.5:1 app-wide, as white text on the destructive button fill (3.76:1 light) and as `text-destructive` error text (3.6:1 light, 4.09:1 dark). It is a design-system token decision, not a membership defect.
- Phone drawers (vaul, `autoFocus` off by design) do not move focus in on open; the first Tab enters them once the switcher sheet has finished closing. The join dialog's phone test asserts exactly that.
- Cloud unavailable (`apps/server/src/services/communities/remote/__tests__/cloud-unavailable.test.ts`): the spec asks that "the full journey works with DorkOS Cloud egress blocked". The Community server's half is `tenancy-egress.integration.test.ts`; this file proves the DorkOS half. Every non-loopback TCP connect, DNS lookup, direct DNS query (`dns.resolve*` and `Resolver`, callback and promise) and UDP send or connect in the process is refused and recorded; a control test first shows each kind is refused, including a real `fetch` to dorkos.ai. The journey steps it covers, through the real routes and services against a loopback Community with nothing refused: starting pairing, polling through approval to connected, listing the connection with its attention counts, reading channels and a channel's history, and disconnecting with grant revocation. It does not cover posting, attachments, the live event stream, or agent enrollment. Mutation: a `fetch` to Cloud added to `RemoteCommunityPairingService.start` or to `RemoteCommunityAdapter.attention` turns it red.

### Session 9 - 2026-09-23 (final acceptance run)

**Branch:** `verify/two-desktop-final`

- Closed DOR-2182 Task 3.1. Its last open part was the durable two-Desktop driver, which merged in #2016 (c9b97b0be).
- Closed DOR-2182 Task 3.2. The two-Desktop acceptance run (`DORKOS_TWO_DESKTOP_ACCEPTANCE=1 pnpm --filter @dorkos/e2e community-two-desktop -- --build`, throwaway Postgres) ran all 30 steps (1–29 plus 15b) on main b29ba8b9b, which has #2019, #2021, #2030, #2033, #2038, #2040 and #2042. Outcome `PASS-WITH-FINDINGS`, exit 0, no product-contract failure. Run `run-1790203094803`; the evidence is kept locally, not in the repo.
- Exact scope, as the run saw it. Disconnect (step 25) removed only Desktop B's grant on the Community (`["Desktop B"]` before, `[]` after); B stayed a member, A kept posting, and B paired again. Leaving (26) and removal (28) cut B's app off: its local server knew in 20 ms and 13 ms, and the open window moved off the Community in 32 ms and 62 ms (the limit is 10 s). The owner could not leave before handing over ownership (24), an expired invitation admitted no one (27), and rejoining listed what comes back and what stays removed, then needed a fresh pairing (28).
- Findings, none of them a product-contract failure:
  - After a burst of new messages, reaching the newest one took three "Scroll to bottom" presses instead of one (step 15b).
  - In steps 25 and 28, A posted on a freshly opened #general and the post took about 20 s to come into view. The server accepted it at once (`POST …/entries 201`). This slowed both steps to about 25 s, but not the disconnect, leave or removal timings above. It is probably the same behaviour as the "Scroll to bottom" finding.
  - The screenshots for 25b (disconnect dialog), 26b and 28c ("This DorkOS can no longer reach Desktop Proof.") were taken while the dialog or toast was still fading in. Only the screenshots are affected.

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

None for this spec. Follow-ups outside it: the `--destructive` contrast token (fixed in #2042), and the two scroll findings from Session 9.
