---
slug: community-host-takedown
number: 260923-214420
created: 2026-09-23
status: specified
linear-issue: DOR-2281
project: Cloud-Hosted Communities
---

# Let a host take down illegal content: implementation plan

Three tasks in two phases. The canonical plan, with self-contained descriptions and acceptance criteria, is `03-tasks.json`. Cross-spec dependencies: `community-single-item-delete` task 1.1 before task 1.1 here; `community-export-any-size` task 1.2 before task 2.1 here.

## Phase 1 — Item takedowns (launch blocker)

- [ ] **1.1 Take down one message or file with evidence preserved outside the API** (xl, high). Migration (next free number): the `communities:takedown` scope, `audit_events` actor kind `host`, the `evidence_hold` blob state, `community_takedowns`, `takedown_evidence_staging`. Host routes, password for a person, the item transaction (host tombstone via `content-removal.ts` with held blobs, ready exports deleted, audits), the write-only evidence sink (filesystem, S3) with `record.json` last, the evidence worker with retries, deletion gate, the tenant notices route; `icon` target; actor-scoped idempotency; `child_safety` notices off by default and withheld audit rows; `child_safety`/`legal_order` bytes held without a store until a person releases them; evidence retry, overdue alert, `link()`-based filesystem sink, record SHA-256 in the takedown and host audit. AC-1 to AC-7, AC-6b, AC-11 to AC-15, AC-13b (item parts).
- [ ] **1.2 Add the takedown section, owner and author notices, and file reports to the browser** (medium, high). Host page section with the no-store warning and evidence states; owner "Removed by the host" list; author banner; Report on a file adds the attachment id. After 1.1.

## Phase 2 — Community takedown (launch blocker)

- [ ] **2.1 Take down a whole community with evidence and a reversal window** (large, high). After 1.1 and export-any-size 1.2. Revoke everything, `deletion_pending` with a host requester and a reversal window of 24 to 720 hours (default 72, relaxing `communities_deletion_state`), a per-actor rate limit with warning log lines, every member's account and session details staged at takedown time, account erasures gated too, the reversal table (including host-started deletion from a hold), the evidence export copied to the store, deletion and erasure gates, reversal to `suspended`, the removed-community message and chooser lines. AC-8 to AC-10, AC-11 to AC-13 (community parts).
