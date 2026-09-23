---
slug: community-member-erasure
number: 260923-134613
created: 2026-09-23
status: specified
linear-issue: DOR-2247
project: Cloud-Hosted Communities
---

# Community member erasure implementation plan

Two tasks in two phases. The canonical machine-readable plan, with the full self-contained task descriptions and acceptance criteria, is `03-tasks.json`.

## Phase 1 — Community server erasure

The hosted-community launch blocker.

- [ ] **1.1 Erase a member's account and messages on the Community server** (xl). Migration (next free number at build time, after the host-operator spec's 0012 to 0015); the idempotent per-membership procedure (end access, delete files and exports, tombstone entries in place, rewrite `@handle` mentions to `@[erased]`, husk the member and their agents) and the account procedure; the 72-hour cancellable window and its guards; the worker; account and owner routes; the redaction feed; export `LEFT JOIN` and the snapshot-versus-erasure commit check; the `erasure:reapply` CLI; the browser flows; docs. Proven by the schema-enumerating residue scan (AC-1) and AC-2 to AC-12.

## Phase 2 — DorkOS installations honor redactions

- [ ] **2.1 Replace cached copies of erased Community messages in DorkOS** (medium, depends on 1.1). Page the redaction feed per mirrored room, rewrite the mirrored rows and the external author's name, never dispatch an agent for it, and re-index the room in message search. Proven by AC-13's local SQLite and search scan.
