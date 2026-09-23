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
- [ ] **1.4** Complete tenant-bound installation pairing and authoritative disconnect status. _Open: "Disconnect this installation" must revoke the selected grant (02-specification.md, "Connect this DorkOS installation"), but DorkOS's Disconnect deletes only the local credential (`apps/server/src/services/communities/remote/pairing-service.ts` `disconnect`), so the grant stays live on the Community (found by the two-Desktop run, PR #2016 step 25). A fix is in progress. The Community side is built in #1987 with DOR-2191's revoked-grant reconciliation (#1957). Proof so far: `admission.integration.test.ts` › "pairs a local install once through browser approval and revokes its scoped bearer", "never issues a pairing credential after cancellation or expiry", "limits native personal grants to their scopes, ownership, and live revocation"; `browser-tests/pairing.spec.ts` (2 journeys)._

## Phase 2 — Entry Experience (DOR-2181)

- [ ] **2.1** Build host sign-in, chooser, and returning-member entry. _Built (#1978, #1987): `CommunityChooser.tsx` enters a sole active membership directly, lists several, shows an empty state for zero, labels archived "Read history", suspended and unavailable. Open: no browser proof of the zero-membership, suspended, removed or stale last-selection routes, and no focus management or keyboard/narrow-width proof for the chooser._
- [ ] **2.2** Build clean-URL invitation review and account/OAuth continuation. _Built (#1987): `Admission.tsx` shows community, inviter and channel after preflight, then create/sign-in/OAuth continuation. Open: the preview is held only in page state (there is no read of the pending admission), so it does not survive a reload; failures show a generic error rather than "membership was not added" plus one recovery action; account-created-but-redeem-failed is not reported as such; inactive members see no reactivation scope; no focus moves or announcements on step changes._
- [ ] **2.3** Separate installation, session, channel, and membership controls. _Partly built (#1987, #2002): `Manage.tsx` has per-installation remove, channel leave, and community leave behind transfer; the DorkOS switcher routes Leave and Disconnect separately. Open: no browser sign-out control and no "disconnect all" control in the Community app (the API exists); scope summaries do not name what ends and what remains; and DorkOS's Disconnect deletes only the local credential (`apps/server/src/services/communities/remote/pairing-service.ts` `disconnect`), leaving the grant live on the Community, where the spec says it revokes the selected grant (found by the two-Desktop run, PR #2016 step 25)._
- [x] **2.4** Atomically set up the first host, then distinguish deployment from later community creation and claim. _#1987: one-transaction first-host setup (`first-host-bootstrap.integration.test.ts`: atomic success, rollback leaves the grant retryable, one concurrent winner) and host administration's separate "Deploy a new host" link. #1999: the `/claim` owner-claim page (`browser-tests/owner-claim.spec.ts`, 2 journeys: link-only secret, reload resume, lost response, account switch, expiry/reuse refusal). `administration.integration.test.ts` › "creates a pending tenant idempotently and rotates its private owner claim"; pending communities have no members, so `GET /api/v1/memberships` never lists them._

## Phase 3 — Journey Proof (DOR-2182)

- [ ] **3.1** Prove synchronous secret erasure, account binding, lost-response idempotency, and cross-device security. _Partial: erasure, account binding, final-seat and lost-response proofs are on main (see 1.1–1.2). The cross-device and two-installation leg ran as the two-Desktop acceptance run on main 30df6cdc2 (20/20 steps); its durable driver is PR #2016, still open. Closes when #2016 merges._
- [ ] **3.2** Prove exact revocation scope, accessibility, recovery, and standalone operation. _Open: PR #2016's extended run (steps 20–29, on main 8c4bb8490) ends `FAIL-PRODUCT-CONTRACT`: Disconnect leaves the Community grant live, and Community refusals (for example the per-member agent limit) reach the app as 502 "Community unavailable." (`apps/server/src/routes/remote-communities.ts` `fail`). Accessibility and Cloud-unavailable proof for the whole journey set is not yet written._

## Dependency graph

```text
1.1 ─┬→ 1.2 ─┬→ 1.4 ─┬→ 2.3 ─┐
     └→ 1.3 ─┘       │        │
          ├──────────→ 2.1 ────┼→ 3.1
1.2 ──────┼──────────→ 2.2 ────┤
          └──────────→ 2.4 ────┴→ 3.2
```

Tasks 1.2 and 1.3 may proceed together after preflight exchange. Entry tasks may proceed in parallel after their protocol dependencies. Both proof tasks require all entry paths.
