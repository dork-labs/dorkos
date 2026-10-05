---
id: 261001-201108
title: Relay delivery receipts own authoritative metadata separate from the message index
status: accepted
created: 2026-10-01
spec: relay-delivery-receipts
extractedFrom: relay-delivery-receipts
amends: 0013
superseded-by: null
---

# 261001-201108. Relay delivery receipts own authoritative metadata separate from the message index

## Status

Accepted design (extracted from spec: relay-delivery-receipts), frozen 2026-10-01T20:37:33Z. Independent re-review by `/root/receipt_spec_adversarial` (GPT-6.1 Sol, Medium) converged with no remaining freeze blockers. This is design-only acceptance; implementation and delivery remain pending verified merge/DONE. This narrowly amends ADR-0013's SQLite scope; it does not change Maildir payload truth.

## Context

HTTP Relay publishing can acknowledge a detached agent attempt before it reports at_capacity, and a publisher without replyTo has no stable target-delivery status contract. The derived relay_index is deleted by routine index repair, successful Maildir files are removed, and a DLQ write may fail, so those sources cannot reconstruct truthful receipt history. Protected private-session admission already has a different transactional source/queue/authority contract and must remain separate.

## Decision

Persist minimized target-delivery observation metadata in a dedicated authoritative relay_delivery_receipts SQLite table, separate from the rebuildable message index and payload files. Commit the initial observation before any delivery effects, use the existing ULID as the locator, retain HTTP 200 with additive receipt/statusUrl fields, and scope the receipt to HTTP detached agent delivery. Preserve ownership from verified request identity or explicit login-off local trust, with owner-only access to local-trust records after login turns on, and expire history seven days after acceptance. One receipt observer exclusively owns each SQLite database through a singleton ownership row claimed atomically; live, same-PID, unconfirmed or foreign-host holders block recovery, and an epoch difference alone is not liveness proof. Tracked publishing refuses a caller-owned active transaction so its pre-effect receipt commit cannot later be rolled back after dispatch; route-local locator capture at that commit preserves status access through every structured post-publish error. Only after exclusive owner acquisition does an older-owner or unobservable attempt become outcome_unknown; receipt metadata never queues, replays, resends, changes operator authority, or widens private-session admission.

## Consequences

### Positive

- Status survives normal restart and derived-index repair without duplicating message content.
- HTTP clients can observe capacity refusal without a reply inbox or incompatible response change.
- Mailbox success and target-turn refusal remain distinct; bookkeeping failure cannot falsely classify a successful turn as failed.
- A fixed bounded lifetime and minimized metadata make ownership and cleanup precise.

### Negative

- Authoritative SQLite metadata is an explicit exception to ADR-0013's derived-index scope and cannot be rebuilt from Maildir after database-file corruption.
- Observer contention and active caller transactions refuse tracked effects; no stale-heartbeat takeover or broad distributed lease is added.
- Eligible publishing adds a pre-effect DB write and terminal CAS; unavailable initial storage refuses receipt-observed effects.
- Lost observation offers no guarantee that nothing happened, and persistent settlement-storage failure can leave the last accepted observation until boot recovery.
- No business-outcome, durable-queue, exactly-once, power-loss durability, or automatic retry guarantee is added.
