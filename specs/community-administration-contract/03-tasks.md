---
slug: community-administration-contract
number: 260920-201100
created: 2026-09-20
status: specified
linear-issue: DOR-2175
project: Community Administration
---

# Community administration implementation plan

The canonical task graph is [03-tasks.json](./03-tasks.json). Implementation starts only after DOR-2172 supplies the tenant persistence and authorization foundation.

## Phase 1 — Lifecycle APIs (DOR-2176)

- [x] **1.1** Extend DOR-2172's reconciled tenant blob inventory with icon ownership, lifecycle deletion progress, settings, audit, and deletion jobs.
- [x] **1.2** Implement metadata-only host creation, pending-owner claims, and safe abandonment.
- [x] **1.3** Implement ETag-protected settings, admission policy, and lifecycle-rechecked tenant-owned object writes.
- [x] **1.4** Enforce transfer, archive/restore, suspend/resume, and immediate revocation.
- [x] **1.5** Add owner deletion request/cancel with reauthentication and seven-day grace.
- [x] **1.6** Build bounded exact-tenant inventory/blob/database cleanup and tombstone expiry.

## Phase 2 — Management Experience (DOR-2177)

- [x] **2.1** Build host administration and contextual community Settings surfaces.
- [x] **2.2** Build accessible destructive-action, archived read-only, countdown, progress, and recovery states.

## Phase 3 — Adversarial Proof (DOR-2178)

- [ ] **3.1** Prove the authority, concurrency, state, accessibility, and revocation matrix. _Open: the acceptance criterion "Cloud egress can be blocked without breaking administration" is not yet exercised; see `04-implementation.md`._
- [x] **3.2** Prove exact deletion/retry, including orphaned and racing A objects, while tenant B and host identity remain intact.
