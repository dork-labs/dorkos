---
slug: community-membership-journeys
number: 260920-203200
created: 2026-09-20
status: specified
linear-issue: DOR-2179
project: Community Membership Journeys
---

# Community membership journey implementation plan

The canonical graph is [03-tasks.json](./03-tasks.json). Implementation begins after the DOR-2171 and DOR-2175 foundations it consumes.

## Phase 1 — Membership Protocol (DOR-2180)

- [x] **1.1** Erase invite fragments synchronously, then exchange them for tenant-bound pending admission. _#1987: `apps/community/src/browser/index.html` + `invite-fragment.ts` capture and erase the fragment before any module or request; `POST /api/v1/invites/preflight` exchanges it for the HttpOnly pending admission. Proof: `browser-tests/community.spec.ts` (clean URL, no raw token in storage or requests); `admission.integration.test.ts` › "does not admit through revoked or expired invites and never consumes seats on preview"._
- [x] **1.2** Bind admission to one account and implement atomic, receipt-backed join/reactivation redemption. _#1987: `routes/invites.ts` bind/redeem, migration `0011_membership_protocol.sql`. Proof: `admission.integration.test.ts` › "binds one browser transaction to one account…", "admits exactly one contender for the final seat…", "settles a repeated same-account invitation transaction without consuming another seat", "invalidates old receipts on removal and reactivates only through a new scoped invite"._
- [x] **1.3** Scope leave, removal, sign-out, and tenant-derived revocation. _#1987: `routes/members.ts` (`POST /me/leave` with password and community name), `routes/pairings.ts` (`DELETE /me/grants/:id`, `DELETE /me/grants`). Proof: `admission.integration.test.ts` › "disconnects all selected-member installations idempotently after reauthentication", "enforces the member role matrix and immediately removes an ordinary member", "requires owner reauthentication for transfer and preserves one active owner"._
- [x] **1.4** Complete tenant-bound installation pairing and authoritative disconnect status. _#1987 built the Community side with DOR-2191's revoked-grant reconciliation (#1957); #2019 (907a533e8) made DorkOS's Disconnect revoke its own grant on the Community instead of deleting only the local credential (the gap the two-Desktop run found, PR #2016 step 25). Proof: `install-disconnect.integration.test.ts` › "revokes only the calling install’s grant, and a retry still succeeds" (:59), "refuses a bearer that is not a grant, and a request with none" (:94), "refuses one community’s bearer at another community’s address" (:101), "lets an install disconnect from a suspended community" (:121), "DorkOS Disconnect ends the grant on the Community, not just the local copy" (:149); `apps/server/.../pairing-service.test.ts` › "persists a reconnect-required state when the remote rejects the personal grant" (:572, disconnect at :576–611); `admission.integration.test.ts` › "pairs a local install once through browser approval and revokes its scoped bearer", "never issues a pairing credential after cancellation or expiry", "limits native personal grants to their scopes, ownership, and live revocation"; `browser-tests/pairing.spec.ts` (2 journeys, from #1987)._

## Phase 2 — Entry Experience (DOR-2181)

- [x] **2.1** Build host sign-in, chooser, and returning-member entry. _#1978, #1987, and `feat/community-membership-states`: `CommunityChooser.tsx` enters a sole active membership directly, lists several as a keyboard-ordered list focused on its heading, explains suspended communities while keeping them focusable, forgets a stale remembered choice, and answers every inaccessible or unknown `/c/:id` with the same chooser notice (an unknown ID no longer falls through to first-host setup). Zero memberships show how to join, plus host administration for a host operator. Proof: `browser-tests/membership-states.spec.ts` › "the chooser routes one, several, suspended, removed, stale and zero memberships by keyboard" (390px and desktop); archived and signed-out entry in `community.spec.ts`._
- [x] **2.2** Build clean-URL invitation review and account/OAuth continuation. _`feat/community-membership-states`: `GET /api/v1/invites/pending` reads the live join attempt back from its HttpOnly cookie, so a reload or sign-in return keeps the review without the raw invitation; `Admission.tsx` leads with community and inviter, offers "Create an account on this host" / "Sign in to this host", says "Membership was not added." (or that the account was created but membership was not) with one recovery, shows reactivation scope before a former member rejoins, and moves focus to each step's heading. Proof: `membership-states.spec.ts` › "an invitation survives reload, says when membership was not added, and shows rejoin scope"; `admission.integration.test.ts` › "reads a live pending admission back from its cookie without the invitation"; the cross-community read is in `administration.integration.test.ts`'s foreign-object matrix. The OAuth return is proven through the same signed-in resume path, not a live provider._
- [x] **2.3** Separate installation, session, channel, and membership controls. _#1987 and #2002 built per-installation remove, channel leave, community leave behind transfer, and the DorkOS switcher's separate Leave and Disconnect; #2019 (907a533e8) made DorkOS's Disconnect revoke its own grant on the Community. `feat/community-signout-disconnect-all` adds the rest: Settings > Account lists "This browser" (sign out), "Connected installations" (disconnect one, behind a confirmation that names what ends and that membership stays; or all, behind a password) and "Leave community" (what ends, what stays) as separate panels; the chooser offers the same sign-out. Proof: `account-controls.integration.test.ts` › "disconnects every installation of this account in this community and nothing else" (the same account's other community and another member's grants stay live) and "signs one browser out without touching its other browsers, memberships or installations" (session row deleted, cookie cleared, replayed cookie refused); `browser-tests/account-controls.spec.ts` (2 journeys, 390px and desktop, keyboard)._
- [x] **2.4** Atomically set up the first host, then distinguish deployment from later community creation and claim. _#1987: one-transaction first-host setup (`first-host-bootstrap.integration.test.ts`: atomic success, rollback leaves the grant retryable, one concurrent winner) and host administration's separate "Deploy a new host" link. #1999: the `/claim` owner-claim page (`browser-tests/owner-claim.spec.ts`, 2 journeys: link-only secret, reload resume, lost response, account switch, expiry/reuse refusal). `administration.integration.test.ts` › "creates a pending tenant idempotently and rotates its private owner claim"; pending communities have no members, so `GET /api/v1/memberships` never lists them._

## Phase 3 — Journey Proof (DOR-2182)

- [ ] **3.1** Prove synchronous secret erasure, account binding, lost-response idempotency, and cross-device security. _Partial: erasure, account binding, final-seat and lost-response proofs are on main (see 1.1–1.2). The cross-device and two-installation leg ran as the two-Desktop acceptance run on main 30df6cdc2 (20/20 steps); its durable driver is PR #2016, still open. Closes when #2016 merges._
- [ ] **3.2** Prove exact revocation scope, accessibility, recovery, and standalone operation. _Open: PR #2016's extended run (steps 20–29, on main 8c4bb8490) ended `FAIL-PRODUCT-CONTRACT` on two product gaps, Disconnect leaving the Community grant live and Community refusals reaching the app as 502 "Community unavailable."; #2019 (907a533e8) fixed both, but the run has not been repeated. Accessibility and Cloud-unavailable proof for the whole journey set is not yet written._

## Dependency graph

```text
1.1 ─┬→ 1.2 ─┬→ 1.4 ─┬→ 2.3 ─┐
     └→ 1.3 ─┘       │        │
          ├──────────→ 2.1 ────┼→ 3.1
1.2 ──────┼──────────→ 2.2 ────┤
          └──────────→ 2.4 ────┴→ 3.2
```

Tasks 1.2 and 1.3 may proceed together after preflight exchange. Entry tasks may proceed in parallel after their protocol dependencies. Both proof tasks require all entry paths.
