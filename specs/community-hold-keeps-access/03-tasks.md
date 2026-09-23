---
slug: community-hold-keeps-access
number: 260923-214400
created: 2026-09-23
status: specified
linear-issue: DOR-2284
project: Cloud-Hosted Communities
---

# A host hold keeps people connected: implementation plan

Two tasks in one phase. The canonical plan, with self-contained descriptions and acceptance criteria, is `03-tasks.json`. No migration.

## Phase 1 — A hold keeps people connected

- [ ] **1.1 Stop revoking credentials, invitations, and agents when a host holds a community** (medium, high). Lands after #2036 (or folds into it if still open). The hold stops calling `revokeTenantAccess`; grant checks require `history_only` only for owner-archived communities; connection access and the grant list report read-only capabilities with lifecycle `archived` while held; streams close with reason `archived` and refuse to open while held; invitations and pending admissions wait with `423 COMMUNITY_HELD`; agents stay enrolled and can read. Amends the host-operator spec's Credentials bullet and ADR `260923-121712`. AC-1 to AC-7.
- [ ] **1.2 Let DorkOS notice a released hold and stop replaying refused posts** (small, medium). A 5-minute re-verify for connections whose last known lifecycle is `archived`; a `423` with a read-only code is a permanent outbox failure. AC-8, AC-9. Parallel with 1.1.
