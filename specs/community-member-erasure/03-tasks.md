---
slug: community-member-erasure
number: 260923-134613
created: 2026-09-23
status: specified
linear-issue: DOR-2247
project: Cloud-Hosted Communities
---

# Community member erasure implementation plan

Three tasks in two phases. The canonical machine-readable plan, with the full self-contained task descriptions and acceptance criteria, is `03-tasks.json`.

## Phase 1 — Erasure on the Community server

- [ ] **1.1 Let a person erase their membership or account on the Community server** (xl, the hosted-community launch blocker). Migration (next free number at build time, after the host-operator spec's 0012 to 0015); the idempotent per-membership procedure (end access, delete files and exports, tombstone entries in place, rewrite `@handle` mentions outside code to `@[erased]`, a seal that repeats every step, then husk the member and their agents) with batch-by-id locking that never blocks posts; the account procedure (sign-out at start, sign-in and admission refused while running, account rows deleted last); the 72-hour cancellable window and its guards; pairing cleanup; export `LEFT JOIN` and the content-version commit check; the owner's deletion request from `suspended` and `held`; the erasure journal, `erasure:reapply`, and the redaction epoch; `entry_redactions` rows (no feed route yet); the browser flows with the honest cannot-reach sentence; docs. Proven by the schema-enumerating residue scan (AC-1) and AC-2 to AC-12.
- [ ] **1.2 Let the owner erase a former member** (medium; depends on 1.1 and the host-operator API import task 4.2). Owner routes and UI for removed, left, and imported members; re-check and cancel on re-admission; the target sees the request and can export their own messages; account erasure alongside a community in `deletion_pending`. The (1.2) parts of AC-6 to AC-10.

## Phase 2 — Redaction feed and DorkOS installations

- [ ] **2.1 Publish redactions and replace cached copies in DorkOS** (large; depends on 1.1). The redaction feed route with the epoch in its signed cursor; the DorkOS mirror rewrites cached rows with `secure_delete`, updates the external author, never dispatches an agent, and re-indexes and optimizes room search. AC-12 (2.1 part), AC-13, AC-14.
