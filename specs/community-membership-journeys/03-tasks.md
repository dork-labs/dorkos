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

- [ ] **1.1** Erase invite fragments synchronously, then exchange them for tenant-bound pending admission.
- [ ] **1.2** Bind admission to one account and implement atomic, receipt-backed join/reactivation redemption.
- [ ] **1.3** Scope leave, removal, sign-out, and tenant-derived revocation.
- [ ] **1.4** Complete tenant-bound installation pairing and authoritative disconnect status.

## Phase 2 — Entry Experience (DOR-2181)

- [x] **2.1** Build host sign-in, chooser, and returning-member entry. _#1978, #1987, and `feat/community-membership-states`: `CommunityChooser.tsx` enters a sole active membership directly, lists several as a keyboard-ordered list focused on its heading, explains suspended communities while keeping them focusable, forgets a stale remembered choice, and answers every inaccessible or unknown `/c/:id` with the same chooser notice (an unknown ID no longer falls through to first-host setup). Zero memberships show how to join, plus host administration for a host operator. Proof: `browser-tests/membership-states.spec.ts` › "the chooser routes one, several, suspended, removed, stale and zero memberships by keyboard" (390px and desktop); archived and signed-out entry in `community.spec.ts`._
- [x] **2.2** Build clean-URL invitation review and account/OAuth continuation. _`feat/community-membership-states`: `GET /api/v1/invites/pending` reads the live join attempt back from its HttpOnly cookie, so a reload or sign-in return keeps the review without the raw invitation; `Admission.tsx` leads with community and inviter, offers "Create an account on this host" / "Sign in to this host", says "Membership was not added." (or that the account was created but membership was not) with one recovery, shows reactivation scope before a former member rejoins, and moves focus to each step's heading. Proof: `membership-states.spec.ts` › "an invitation survives reload, says when membership was not added, and shows rejoin scope"; `admission.integration.test.ts` › "reads a live pending admission back from its cookie without the invitation". The OAuth return is proven through the same signed-in resume path, not a live provider._
- [ ] **2.3** Separate installation, session, channel, and membership controls.
- [ ] **2.4** Atomically set up the first host, then distinguish deployment from later community creation and claim.

## Phase 3 — Journey Proof (DOR-2182)

- [ ] **3.1** Prove synchronous secret erasure, account binding, lost-response idempotency, and cross-device security.
- [ ] **3.2** Prove exact revocation scope, accessibility, recovery, and standalone operation.

## Dependency graph

```text
1.1 ─┬→ 1.2 ─┬→ 1.4 ─┬→ 2.3 ─┐
     └→ 1.3 ─┘       │        │
          ├──────────→ 2.1 ────┼→ 3.1
1.2 ──────┼──────────→ 2.2 ────┤
          └──────────→ 2.4 ────┴→ 3.2
```

Tasks 1.2 and 1.3 may proceed together after preflight exchange. Entry tasks may proceed in parallel after their protocol dependencies. Both proof tasks require all entry paths.
