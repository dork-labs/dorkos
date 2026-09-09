---
id: 260908-163050
title: Hosted event capacity is a tenant-scoped transaction
status: accepted
created: 2026-09-08
spec: hosted-notification-intake-bounds
superseded-by: null
---

# 260908-163050. Hosted event capacity is a tenant-scoped transaction

## Status

Accepted.

## Context

Managed event delivery runs on multiple Vercel instances against one Neon database. Existing per-request and retention limits do not cap valid signed arrival rate or total retained inbox storage, while a process-local limiter would give each instance a separate and resettable budget. Exact at-least-once webhook retries must remain idempotent and must not consume capacity twice.

## Decision

We will maintain one durable event-capacity row per connector tenant and lock it before every subscription activation, inbox admission, ACK, or retention mutation. Tenant creation and migration will guarantee that row exists; ingress will never create or reset it on a rejected request or exact duplicate. Admission will charge only transactions that add a new receipt, reserve the exact retained rows and protected bytes committed, and return one generic retryable overload response when any fixed limit would be exceeded. Subscription setup will reserve its fan-out slot before provider mutation and use captured-binding cleanup if a later terminal transition must compensate. Cleanup will claim bounded tenant pages in least-recent maintenance order and update capacity in the same transaction as every clear or delete; local database timeouts bound individual waits.

## Consequences

### Positive

- Every Vercel instance enforces one tenant budget without a deployment-wide lock.
- Duplicate delivery, inbox persistence, and capacity accounting commit atomically.
- One tenant cannot spend another tenant's quota or indefinitely occupy every cleanup page.

### Negative

- All event mutations for one tenant serialize on one row.
- A migration must backfill existing rows and bytes, and every future inbox deletion or payload-clear path must participate in the lock and ledger contract.
- Static limits and a generic 429 can delay a legitimate burst; the first pass has no owner override or billing-aware capacity tier.
