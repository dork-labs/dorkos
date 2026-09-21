---
slug: community-tenancy-contract
number: 260920-192428
created: 2026-09-20
status: specified
linear-issue: DOR-2171
project: Multi-Community Hosting
---

# Community tenancy implementation plan

This plan implements the frozen tenant contract in four ordered phases. The canonical machine-readable graph is `03-tasks.json`.

## Phase 1 — Schema and Migration

Owned by DOR-2172, **Implement tenant-scoped persistence and authorization**.

- [x] **1.1 Add explicit tenant keys, host operators, and blob reservations.** Expand the schema without removing current safety constraints; reserve tenant ownership before attachment/export bytes are stored and recheck lifecycle before committing references.
- [x] **1.2 Backfill and validate zero- or one-community databases and the managed blob namespace.** Keep fresh installs bootstrap-ready, preserve every populated identity and file hash, assign recognizable legacy objects, report unexplained objects without deleting them, and fail closed on incomplete or stale reconciliation before a second tenant can exist.
- [x] **1.3 Enforce tenant-consistent relational constraints.** Normalize mention and export-channel arrays, make tenant keys non-null, and let PostgreSQL reject cross-community relations.
- [x] **1.4 Prove the single-community backout gate.** Support rollback before multi-community use and refuse destructive downgrade later.

## Phase 2 — Tenant Context and Authorization

Owned by DOR-2172, **Implement tenant-scoped persistence and authorization**.

- [x] **2.1 Resolve immutable tenant context at the HTTP boundary.** Add qualified routes and fail-closed compatibility behavior.
- [x] **2.2 Qualify member, channel, entry, file, and export authorization.** Scope all reads, writes, jobs, streams, and transactional rechecks.
- [x] **2.3 Separate host operations from community ownership.** Keep operational authority outside content access and membership minting, limit owner claims to pending communities, and make account recovery host-wide.

## Phase 3 — Admission and Connections

Owned by DOR-2173, **Add tenant-qualified discovery, pairing and DorkOS connections**.

- [ ] **3.1 Bind invites, pairings, grants, agents, and cursors to a tenant.** Prevent replay or approval across communities.
- [ ] **3.2 Qualify discovery and the remote Community adapter.** Extract one immutable UUID from a canonical community link while retaining origin pinning and singleton compatibility.
- [ ] **3.3 Add the community chooser and safe cache switching.** Provide the Slack-like journey while closing old streams and state.

## Phase 4 — Isolation and Compatibility Proof

Owned by DOR-2174, **Prove tenant isolation and upgrade compatibility end to end**.

- [ ] **4.1 Run the adversarial two-community isolation matrix.** Test every endpoint family, credential type, normalized reference, canonical-link selection, object mismatch, and race.
- [ ] **4.2 Prove populated upgrade and standalone compatibility.** Verify unchanged identities, content, files, connections, and Cloud independence.

## Dependency graph

```text
1.1 → 1.2 ─┬→ 1.3 → 2.1 ─┬→ 2.2 ─┬→ 3.1 → 3.2 ─┐
           └→ 1.4         └→ 2.3 ─┘       └→ 3.3 ─┼→ 4.1
                    1.4 ───────────────────────────└→ 4.2
                                      3.1 ─────────→ 4.2
```

Tasks 1.3 and 1.4 may run together after the validated backfill. Tasks 2.2 and 2.3 may run together after tenant context exists. Tasks 3.2 and 3.3 may run together after their own prerequisites. The final isolation and compatibility proofs may run together, but neither can close until both pass.
