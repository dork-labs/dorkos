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

- [ ] **2.1** Build host sign-in, chooser, and returning-member entry.
- [ ] **2.2** Build clean-URL invitation review and account/OAuth continuation.
- [ ] **2.3** Separate installation, session, channel, and membership controls.
- [ ] **2.4** Distinguish deploying a host from creating and claiming a community.

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
