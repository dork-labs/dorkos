---
slug: hosted-notification-intake-bounds
number: 260908-163711
created: 2026-09-08
status: ideation
---

# Bound hosted notification intake and backlog

**Slug:** hosted-notification-intake-bounds  
**Author:** Codex  
**Date:** 2026-09-08  
**Tracker:** DOR-1909, child of DOR-1792; blocks DOR-1905 and the final P7 gate

---

## 1) Intent & Assumptions

- **Task brief:** Put finite, tenant-isolated resource bounds around the hosted managed-event receiver and retained inbox. The limits must hold across concurrent Vercel instances, preserve exact webhook deduplication and tenant authority, and release capacity fairly when content is acknowledged or expires.
- **Assumptions:**
  - Managed event intake remains a small-project service, not a metered billing product.
  - The signed Composio webhook id is stable for retries. Composio documents trigger delivery as at least once, so duplicate-safe handling remains required.
  - Tenant identity continues to come only from a verified event mapped to one exact ready binding. A signature never creates a tenant, connection, binding, or subscription.
  - Existing seven-day protected payload retention, 30-day metadata retention, 256 KiB raw request limit, 64 KiB normalized payload limit, and 100-item pull/ACK batches remain.
  - The deployment uses multiple short-lived Vercel instances against one Neon Postgres database. Process memory cannot be the authority for a quota or counter.
  - Current production evidence proves no live connected account or event delivery. This work is source- and fixture-verifiable; it does not add a live load test or claim live delivery.
- **Out of scope:**
  - Billing, plan tiers, per-seat entitlements, enterprise quotas, or an organization-wide rate-limit framework.
  - A network-edge DDoS service, WAF configuration, OS/container isolation, or changes to Composio's retry system.
  - Event subscription editing, new event sources, provider polling, or changes to operation execution.
  - A user-configurable limit surface in this first pass. The initial limits are explicit source constants with operational documentation.
  - Sending real email, calling a live provider, or generating load against production.

## 2) Pre-reading Log

- `apps/site/src/app/api/connectors/managed/events/route.ts`: reads at most 256 KiB, verifies the project signature before tenant lookup, opportunistically runs retention, then accepts or rejects one event. It has no overload response.
- `apps/site/src/lib/connectors/managed/event-ingress-service.ts`: locks an exact ready binding and its active subscriptions, normalizes content, protects one payload per subscriber, and relies on a per-subscription unique key for idempotence. It has no novel-event admission, fan-out, row, or byte bound.
- `apps/site/src/db/managed-connector-events-schema.ts`: the inbox has tenant ownership, protected payload, lease state, content expiry, metadata expiry, and a per-subscription dedupe key. It has no capacity ledger.
- `apps/site/src/lib/connectors/managed/event-delivery-service.ts`: pull and ACK are capped at 100; ACK clears protected content; retention clears content after seven days and deletes metadata after 30 days in 100-row pages.
- `apps/site/src/app/api/cron/cleanup/route.ts` and `apps/site/vercel.json`: one authenticated daily cleanup invocation runs one global retention page. Old rows belonging to one tenant can occupy that page repeatedly.
- `apps/site/src/db/transaction-client.ts`: the production Neon WebSocket pool supports interactive transactions and row locks. This is the required cross-instance coordination seam.
- `apps/site/src/db/__tests__/client-transactions.test.ts`: the existing offline fixture keeps the production Neon Pool and Drizzle transaction implementation while executing SQL through PGlite. It is the right driver-level test shape.
- `apps/site/src/lib/connectors/managed/__tests__/event-delivery-service.integration.test.ts`: already mounts signed ingress, uses migrated Postgres semantics, and proves dedupe, tenant isolation, ACK, expiry, revocation, and concurrent cleanup claims.
- `decisions/260905-205123-dorkos-brokers-connector-calls-and-may-host-a-managed-provider.md`: DorkOS assumes operational responsibility for hosted tenant isolation, callback verification, and event delivery.
- `contributing/connections-security-verification.md`: DOR-1905 records the missing intake and backlog ceiling as a confirmed gap and names DOR-1909 as the closing gate.
- [Composio trigger delivery guide](https://docs.composio.dev/kb/guide/platform-triggers): trigger delivery is at least once and consumers must deduplicate stable event ids.
- [Composio webhook subscriptions](https://docs.composio.dev/reference/api-reference/webhook-subscriptions): the sender owns webhook delivery; its public contract does not promise that a receiver's `Retry-After` value controls every retry.

## 3) Codebase Map

- **Ingress boundary:** `apps/site/src/app/api/connectors/managed/events/route.ts`.
- **Admission and persistence:** `apps/site/src/lib/connectors/managed/event-ingress-service.ts`.
- **Capacity coordination:** a new tenant capacity module beside the managed ingress service, backed by a new table in `apps/site/src/db/managed-connector-events-schema.ts`.
- **Capacity release:** `event-delivery-service.ts` ACK and retention paths.
- **Subscription fan-out:** `event-authority-service.ts`, where enabled subscriptions can be bounded before webhook arrival.
- **Scheduled maintenance:** `apps/site/src/app/api/cron/cleanup/route.ts` and `apps/site/vercel.json`.
- **Migration:** append-only SQL, snapshot, journal, and schema exports under `apps/site/drizzle/` and `apps/site/src/db/`.
- **Primary regression cohort:** `event-delivery-service.integration.test.ts`, the managed mounted-route tests, schema tests, cleanup-route tests, and production transaction-client tests.

The present flow is:

```text
bounded raw request
  -> project signature verification
  -> exact binding and active-subscriber resolution
  -> normalize + protect once per subscriber
  -> insert with per-subscription duplicate suppression
  -> pull / lease / ACK
  -> payload clear at ACK or 7 days
  -> metadata delete at 30 days
```

The missing control sits between authority resolution and persistence. It must use the same transaction as the inbox writes and must also participate in ACK and retention transactions, or concurrent instances can exceed or corrupt the bound.

## 4) Root Cause Analysis

1. Every valid signed event can fan out to every active subscription for its physical binding.
2. Each distinct `(tenant, subscription, provider event id)` can insert one retained row.
3. The receiver enforces per-request and per-page limits, but no limit on valid requests over time or on the retained rows and protected bytes they create.
4. The daily cleanup query is globally ordered and capped at 100, so one tenant can delay capacity release for another.
5. An in-memory limiter would create one independent budget per Vercel instance and reset whenever an instance is replaced.

**Observed:** source and fixture inspection prove the absence of an arrival-rate limit, active-subscriber fan-out limit, retained-row ceiling, protected-byte ceiling, and fair cleanup scheduler.

**Expected:** one tenant's valid signed traffic cannot consume unbounded hosted storage or prevent another tenant from releasing expired capacity. Exact retries remain accepted without consuming quota, and all counter changes commit or roll back with the rows they describe. A rejected request and an exact duplicate may lock the ledger, but they do not create it, reset its window, or change any field.

## 5) Research

### Option 1 — One durable capacity row per tenant, locked in each event mutation

A tenant capacity row tracks a fixed novel-event admission window, retained inbox rows, retained protected bytes, and the next maintenance time. Tenant creation and migration create this row; ingress never lazily creates it. Every ingress, ACK, and cleanup transaction locks that row before touching binding, subscription, or inbox rows.

- **Pros:** one authority across all Vercel instances; no global lock across tenants; exact counters avoid a full inbox aggregate on every event; the transaction can make quota and persistence atomic.
- **Cons:** every event mutation for one tenant is serialized; a migration must backfill existing rows; all deletion and payload-clear paths must obey one lock order.

### Option 2 — Aggregate the inbox on every request

Count rows and sum `octet_length(protected_payload)` inside the ingress transaction.

- **Pros:** no derived counter drift.
- **Cons:** repeated aggregate scans become the cost of every event; a lock is still needed to stop two instances from both accepting below the threshold; it does not solve arrival-rate windows or cleanup fairness.

### Option 3 — Process-local limiter plus database storage checks

Use the site's existing in-process fixed-window IP limiter and query the database only for storage.

- **Pros:** small code change.
- **Cons:** Vercel instances each get a separate/resettable rate budget; source IP is not tenant identity; valid webhook retries could arrive through different workers. It does not satisfy the issue.

### Recommendation

Use Option 1. The capacity row is a resource-safety ledger, not billing usage. It coordinates only one tenant, is backfilled from existing inbox truth, and is maintained in the same transactions as the rows and bytes it counts. Keep the policy static and explicit for the first pass:

| Bound                                        |                                         Initial value | Rationale                                                                                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Novel accepted webhook transactions          |                         600 per tenant per UTC minute | Allows a ten-per-second burst while making accepted novel work finite. It is not a total-request or edge-flood limit: duplicates, invalid requests, and refused requests still cost some verification work. |
| Active subscriptions on one physical binding |                                                   100 | Bounds one event's fan-out at the existing event batch size.                                                                                                                                                |
| Retained inbox rows                          |                                    100,000 per tenant | Preserves a substantial 30-day dedupe window for a small project while bounding metadata growth.                                                                                                            |
| Protected payload bytes                      |                                    256 MiB per tenant | Bounds the more sensitive seven-day payload store independently of row count. The ledger counts actual stored UTF-8 bytes after protection.                                                                 |
| One cleanup page                             | at most 100 payload clears and 100 metadata deletions | Retains the existing bounded mutation size.                                                                                                                                                                 |
| One scheduled cleanup run                    |                at most 100 tenant pages or 20 seconds | Caps each cron invocation while allowing a single full tenant to release up to 10,000 rows.                                                                                                                 |

The specification must preserve exact-at-limit acceptance and reject only a prospective total above a bound.

## 6) Decisions

| #   | Decision                  | Choice                                                                                           | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Coordination authority    | Tenant-scoped Postgres capacity row                                                              | It is shared by all Vercel instances and does not serialize unrelated tenants.                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2   | Lock order                | Capacity row first, then binding/subscription/inbox rows                                         | One order across ingress, ACK, subscription activation, and cleanup prevents cross-path deadlocks. Tenant creation/migration guarantee the ledger exists; a missing row is an unavailable invariant, not repaired by ingress.                                                                                                                                                                                                                                                               |
| 3   | Duplicate accounting      | Resolve missing per-subscription receipts before charging                                        | A redelivery that would insert no row returns accepted and changes no counter. A partial redelivery charges once and only for missing rows/bytes.                                                                                                                                                                                                                                                                                                                                           |
| 4   | Storage accounting        | Count retained rows and actual protected-payload bytes                                           | The two resources have different release times and need independent ceilings.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5   | Arrival accounting        | One unit for a transaction that commits at least one new receipt                                 | Fan-out does not multiply request rate, while the row and byte ledgers account for fan-out.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | Fan-out                   | Reserve at most 100 non-revoked subscription slots per physical binding before provider mutation | It prevents a final-check race. A terminal failed/cancelled activation releases its slot and queues the existing captured-binding cleanup contract so an upstream trigger cannot be orphaned.                                                                                                                                                                                                                                                                                               |
| 7   | Overload response         | Generic `429 event_intake_limited` plus `Retry-After`                                            | A stable response is actionable without exposing tenant usage, limits, identities, or payload data.                                                                                                                                                                                                                                                                                                                                                                                         |
| 8   | Retry delay               | Rate limit: seconds to the next UTC-minute window; storage/fan-out: 60 seconds                   | Rate recovery is deterministic. ACK and cleanup can free storage earlier or later, so 60 seconds is an invitation to retry, not a capacity promise.                                                                                                                                                                                                                                                                                                                                         |
| 9   | Cleanup fairness          | Repeated one-page tenant claims ordered by least-recent maintenance                              | A full tenant can use multiple pages when alone, while due tenants rotate under concurrent cron workers.                                                                                                                                                                                                                                                                                                                                                                                    |
| 10  | Capacity release          | ACK, seven-day content clearing, 30-day metadata deletion, and tenant deletion                   | Revoking a subscription stops new intake but does not erase an already accepted receipt or its dedupe history.                                                                                                                                                                                                                                                                                                                                                                              |
| 11  | Clock and query waits     | Database UTC minute; 1-second lock timeout and 5-second statement timeout                        | All instances observe one window, and a blocked database statement cannot outlive the route indefinitely. Cleanup uses a 20-second request signal and checks it between pages.                                                                                                                                                                                                                                                                                                              |
| 12  | Failure atomicity         | Inbox and capacity changes share one transaction                                                 | A rollback preserves both or neither; a retry cannot double-decrement capacity.                                                                                                                                                                                                                                                                                                                                                                                                             |
| 13  | External retry assumption | Do not rely on Composio honoring `Retry-After`                                                   | At-least-once duplicates remain safe; overload remains finite even if the sender retries sooner.                                                                                                                                                                                                                                                                                                                                                                                            |
| 14  | Verification              | Production Neon SQL path plus deterministic interleaving; no live load                           | PGlite proves migrated SQL and the production Pool transaction sequence but serializes one embedded connection, so it is not claimed as lock-contention proof. A deterministic two-transaction barrier must kill a removed-lock mutant. Local `initdb`/`pg_ctl` are absent and the Docker daemon is unavailable in the design environment; implementation must use an isolated real Postgres instance if one becomes available, label that evidence separately, and never touch production. |
| 15  | ADR                       | Record the durable tenant-ledger and generic overload boundary                                   | It introduces a persistent coordination pattern and a lasting hosted-service contract.                                                                                                                                                                                                                                                                                                                                                                                                      |

No ambiguities remain. The constants, accounting units, lock order, overload response, cleanup policy, and verification boundary are resolved for specification.
