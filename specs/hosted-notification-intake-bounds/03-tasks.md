# Hosted notification intake bounds — implementation tasks

**Spec:** `specs/hosted-notification-intake-bounds/02-specification.md`  
**Tracker:** DOR-1909  
**Mode:** Full decomposition

## Phase 1 — Durable admission ledger

### Task 1.1: Add the tenant event-capacity schema and backfill

**Status:** Complete

Add fixed source policy constants, the tenant capacity table, append-only migration and exact backfill. Prove constraints, index, cascade, existing-row accounting, and over-limit migration refusal with offline Postgres.

### Task 1.2: Enforce one lock order and bounded subscription fan-out

**Status:** Complete

Use the capacity row as the first lock for event subscription and inbox mutations. Bound a physical binding at 100 active subscriptions with exact-boundary, revocation-retry, tenant-isolation, and concurrency tests.

## Phase 2 — Atomic ingress

### Task 2.1: Admit signed events atomically before charging capacity

**Status:** Complete

Keep raw-size and signature verification before tenant lookup. Recheck exact authority after the tenant capacity lock, deduplicate before charging, reserve the actual missing rows and protected bytes, and commit the complete fan-out with its ledger update. Add the generic 429 and `Retry-After` route contract.

## Phase 3 — Capacity release and fair cleanup

### Task 3.1: Release event capacity transactionally and fairly

**Status:** Complete

Make ACK and retention release exact and idempotent. Replace one global cleanup page with least-recent tenant pages that use a fixed small number of set-based SQL statements, check the remaining deadline before every awaited SQL boundary, roll back an interrupted page, and preserve exact counts from earlier committed pages. Place opportunistic cleanup only after ingress duplicate/refusal outcomes and pull authentication/validation have resolved, so zero-mutation outcomes stay unchanged. Run the authenticated schedule hourly.

## Phase 4 — Verification and operations

### Task 4.1: Prove the hosted event bounds and document recovery

**Status:** Verification

Run the production transaction seam and managed-event fixture matrix, restore meaningful mutants, update operations docs, hand exact source/fixture evidence to the DOR-1905 owner for its later security-matrix update, and preserve the distinction between source, fixture, and still-pending live evidence.
