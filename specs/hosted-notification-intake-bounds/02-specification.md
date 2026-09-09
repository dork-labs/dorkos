---
slug: hosted-notification-intake-bounds
number: 260908-163711
created: 2026-09-08
status: implemented
---

# Bound hosted notification intake and backlog

**Status:** Implemented; final verification pending  
**Author:** Codex  
**Date:** 2026-09-08  
**Ideation:** `specs/hosted-notification-intake-bounds/01-ideation.md`  
**Tracker:** DOR-1909

## Overview

Add a finite tenant-scoped admission and storage ledger to the hosted managed-event receiver. The ledger coordinates every Vercel instance through Neon Postgres, admits exact webhook retries without charging them twice, and prevents a tenant from exceeding fixed novel-event admission, fan-out, retained-row, or protected-byte limits. ACK and retention cleanup release capacity in the same transactions that clear or delete inbox data.

The public webhook stays signature-first and tenant-private. Overload returns a generic `429` response with `Retry-After`; it does not disclose current use, limits, tenant identity, subscription identity, or event content. The implementation uses offline Postgres fixtures and mounted routes. It does not send live events or perform a production load test.

## Background / Problem Statement

The hosted receiver already bounds one raw request at 256 KiB, normalizes content to 64 KiB, pulls and acknowledges at most 100 rows per call, protects payloads at rest, retains payloads for seven days, and retains payload-free dedupe metadata for 30 days. Those local bounds do not cap how many valid signed requests arrive or how many rows and bytes accumulate.

A valid event fans out to every active subscription on one binding. The unique inbox key suppresses exact `(tenant, subscription, provider event id)` duplicates, but each distinct event can continue inserting. The only scheduled cleanup invocation is daily and its global 100-row query can favor one tenant's old rows. Multiple Vercel instances share the database but not memory, so an in-process limiter cannot enforce one deployment-wide tenant budget.

## Goals

- Enforce one finite per-tenant event-arrival budget across all Vercel instances.
- Cap active fan-out, retained inbox rows, and protected payload bytes.
- Preserve exact redelivery as accepted, idempotent, and free of capacity charges.
- Make admission, inbox persistence, ACK release, and retention release transactionally consistent.
- Keep one tenant's traffic and cleanup work from consuming another tenant's budget or indefinitely delaying its cleanup.
- Return a stable, privacy-safe overload response with an explicit retry delay.
- Preserve signature-before-lookup, exact binding authority, immutable receipt history, tenant isolation, payload protection, and existing pull/ACK semantics.

## Non-Goals

- Billing, usage pricing, plan tiers, enterprise quotas, or a generic platform rate-limiter.
- Configurable quotas in the owner UI or public API.
- WAF, CDN, network-edge, OS, or container isolation.
- Changes to Composio retry behavior or a promise that Composio honors `Retry-After`.
- Subscription editing, additional event sources, operation execution, or delivery semantics after local pull.
- Live provider calls, email delivery, production load tests, or claims that live managed events are proven.

## Technical Dependencies

- Neon Postgres and the existing transaction-capable `@neondatabase/serverless` Pool.
- Drizzle ORM row locks, conflict handling, and append-only migrations.
- Existing managed event authority, payload protection, delivery, and retention services.
- Existing shared constants for raw payload, normalized payload, and batch limits.
- Vercel Cron authenticated by `CRON_SECRET`.

No new runtime dependency is required.

## Detailed Design

### Policy constants

Add internal hosted-service constants with these source defaults:

```ts
MANAGED_EVENT_RATE_WINDOW_SECONDS = 60;
MANAGED_EVENT_RATE_LIMIT = 600;
MANAGED_EVENT_BINDING_SUBSCRIPTION_LIMIT = 100;
MANAGED_EVENT_RETAINED_ROW_LIMIT = 100_000;
MANAGED_EVENT_PROTECTED_BYTE_LIMIT = 256 * 1_024 * 1_024;
MANAGED_EVENT_OVERLOAD_RETRY_SECONDS = 60;
MANAGED_EVENT_CLEANUP_PAGE_SIZE = 100;
MANAGED_EVENT_CLEANUP_MAX_PAGES = 100;
MANAGED_EVENT_CLEANUP_MAX_DURATION_MS = 20_000;
```

These are service safety constants, not public entitlements. Tests may inject a smaller internal policy into service functions, but production composition always uses the exported production policy. There is no environment or owner override in this scope.

A prospective total equal to a limit is accepted. Only a total greater than a limit is refused.

### Capacity table

Create `managed_connector_event_capacity` in the same tenant-creation transaction that creates `connector_tenant`, and backfill it for existing tenants. Ingress never lazily creates or repairs this row; a missing ledger is an internal unavailable state. Add these fields:

| Column                    | Type                                                           | Contract                                                                   |
| ------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `tenant_id`               | UUID primary key, FK to `connector_tenant` with cascade delete | One ledger per tenant.                                                     |
| `rate_window_started_at`  | timestamptz                                                    | UTC minute returned by Postgres.                                           |
| `accepted_in_window`      | integer, non-negative                                          | Novel webhook transactions committed in this window.                       |
| `retained_rows`           | integer, non-negative                                          | Every managed inbox row, including payload-free ACK/expiry metadata.       |
| `protected_payload_bytes` | bigint, non-negative                                           | `octet_length(protected_payload)` for non-empty protected payload strings. |
| `next_cleanup_at`         | timestamptz nullable                                           | Earliest known content or metadata expiry that may release capacity.       |
| `last_cleanup_at`         | timestamptz nullable                                           | Fair-selection cursor for scheduled maintenance.                           |
| `updated_at`              | timestamptz                                                    | Last ledger mutation.                                                      |

Add checks preventing negative counters. Add an index on `(next_cleanup_at, last_cleanup_at, tenant_id)` for due-tenant selection.

The migration inserts one ledger for every existing connector tenant. Deployment keeps managed-event readiness off and excludes or quiesces every old receiver version while the migration backfills `retained_rows` with `count(*)`, `protected_payload_bytes` with the sum of `octet_length(protected_payload)` for non-empty payloads, and `next_cleanup_at` with the earliest content or metadata expiry that can change those counters. It starts the current rate window at the database's UTC minute with zero accepted events. Before readiness is enabled, a cutover command re-aggregates rows and bytes under the tenant locks and refuses readiness on any missing/stale ledger or over-limit tenant. This controlled cutover is required because an old serving version could otherwise insert an inbox row after migration backfill without updating the ledger. Current production has event readiness off and no live subscriptions, so zero-downtime mixed-version accounting is unnecessary scope. The migration is append-only and aborts rather than silently truncating data if an existing tenant already exceeds a new storage ceiling; rollout then requires an explicit operator cleanup decision.

### One lock order

Every path that changes an event subscription, inbox row, or capacity counter follows this order:

1. Determine a candidate tenant without locking or mutation.
2. Lock its required capacity row `FOR UPDATE`. A missing row aborts as unavailable; event ingress does not create one.
3. Re-resolve and lock binding/subscription authority or inbox rows.
4. Mutate inbox/subscription rows and capacity counters only after every authority and duplicate check passes.
5. Commit.

Ingress performs an initial signature-verified binding lookup only to identify the candidate tenant. It rechecks the exact binding and active subscribers after acquiring the capacity lock. An authority/validation refusal returns without mutating the ledger. Exact duplicates do not reset an old admission window, update timestamps, or change any counter. ACK and pull already carry the tenant in the verified instance principal. Cleanup selects a candidate tenant, then acquires the same capacity lock before touching rows.

No code path locks an inbox/subscription row and later waits for the capacity row. Readiness cannot turn on until cutover reconciliation confirms every tenant ledger equals the inbox aggregate; any mismatch blocks cutover. After cutover, transactions maintain the counters atomically. Runtime paths fail closed on a missing ledger and on invariant mismatches they can detect inside the current transaction; they do not re-aggregate the full inbox on every request. This lock order prevents a same-tenant deadlock while leaving different tenants independent.

### Subscription fan-out bound

The command-claim transaction reserves a fan-out slot before any provider trigger mutation. It locks the tenant capacity row, then counts non-revoked subscriptions, including pending reservations, for the same physical binding. It refuses a 101st reservation with the existing rejected authority-command shape and a specific internal rejection code. A retry after a subscription is revoked can succeed. The reservation remains attached to a retryable pending command.

A terminal failed, superseded, or cancelled activation revokes its reserved subscription. If the provider trigger was created or enabled before that terminal transition, the command stores the captured binding and marks external cleanup pending. The existing cleanup/recovery contract then rechecks current authority: it leaves a shared trigger in place when any live or reserved subscriber remains, and deletes/disables the exact captured trigger when none remains. The cap itself therefore cannot reject only after creating untracked external state.

Ingress queries at most 101 non-revoked subscribers. If historical or manually altered data exposes more than 100, it returns the generic overload outcome and inserts nothing. It never partially delivers one provider event to an arbitrary first page of subscribers.

### Admission algorithm

After raw-size and project-signature verification:

1. Resolve exactly one candidate ready binding and tenant without mutation. Ambiguous or absent binding returns the existing `binding_rejected` result and creates no capacity row.
2. Start one transaction and lock the required tenant capacity row without changing it.
3. Recheck the exact ready binding, provider generation, account identity, tenant identity, and active subscriptions under locks. An authority change returns `binding_rejected` with no capacity mutation.
4. Query existing inbox identities for each active subscription and this authenticated webhook id. Determine the missing subscriptions before normalization or quota charging.
5. If no receipt is missing, return `accepted`. Do not reset the admission window, update timestamps, increment a counter, extend expiry, or rewrite ciphertext.
6. If subscriber count exceeds 100, return `limited` with no mutation.
7. After the capacity lock and duplicate/refusal decisions, sample a fresh database instant with `clock_timestamp()`. Derive its UTC minute and a nondecreasing effective window: advance beyond the stored window only when this fresh minute is later, and never reset a newer stored window backwards. Compute the effective admission count without storing the reset yet. Preflight the admission and retained-row ceilings before normalization or encryption. If either prospective total is too large, return `limited` with no mutation. If the current protected-byte count is already at its ceiling, also return before encryption. Use this same sampled instant for the rate-limit `Retry-After` calculation.
8. Normalize content once. Protect one payload for each missing subscription using its exact AAD scope. Measure each resulting UTF-8 string with `Buffer.byteLength`; the byte ledger describes the stored representation, not plaintext.
9. Calculate the final prospective protected-byte value and retain the already checked admission/row values:
   - `accepted_in_window + 1`
   - `retained_rows + missing receipt count`
   - `protected_payload_bytes + sum(protected payload bytes)`
10. If the final protected-byte value exceeds its limit, return `limited`. Do not insert a partial fan-out and do not charge the failed attempt.
11. Insert every missing receipt with the original seven-day content and 30-day metadata deadlines. Use `RETURNING` as the final authority for inserted rows; under the capacity lock, a mismatch between expected and inserted rows is an invariant error that rolls back.
12. Store the new UTC-minute window/count only now, then update all three counters and `next_cleanup_at` in the same transaction, then commit and return `accepted`.

A redelivery where some receipt rows already exist and some are newly eligible is a partial duplicate. It charges one arrival unit, reserves only the missing rows and bytes, leaves prior receipt deadlines unchanged, and commits the complete currently eligible fan-out atomically.

### Overload response

`acceptManagedConnectorEvent` returns a typed outcome rather than only `'accepted' | 'rejected'`:

- `accepted`
- `rejected`
- `limited` with a private reason and public retry seconds

The webhook route maps `limited` to:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: <integer seconds>
Content-Type: application/json

{"error":"event_intake_limited"}
```

The body is the same for rate, fan-out, rows, and bytes. It does not include limits, usage, tenant, connection, subscription, account, or payload details. Novel-event admission overload uses the positive integer seconds until the next database UTC-minute boundary. Fan-out and storage overload use 60 seconds. This value tells a sender when it may retry; it does not promise that capacity will exist then or that Composio will honor the header.

Unsupported encodings, oversized raw bodies, invalid signatures, unavailable configuration, and binding rejection retain their existing statuses and bodies. None creates, resets, or mutates capacity state.

### Database and request time bounds

Every capacity-bearing transaction begins with `SET LOCAL lock_timeout = '1s'` and `SET LOCAL statement_timeout = '5s'`. Lock timeout during webhook admission maps to the same generic `429 event_intake_limited` response with `Retry-After: 1`; other database failures keep the existing generic unavailable response. These local settings roll back with the transaction and never alter the shared database role.

At cleanup-handler entry, create one event-maintenance signal with `AbortSignal.any([request.signal, AbortSignal.timeout(25_000)])`. The existing account cleanup does not accept that signal and remains outside DOR-1909's timing claim; if it consumes the window, both event phases skip. Retention receives the shared signal plus an internal 20-second deadline. Every awaited SQL boundary checks both signals before it starts. A small budget helper sets the next statement's transaction-local timeout to the smaller of two seconds and the remaining retention budget, then awaits that statement to settle before continuing. Lock waits remain capped at one second. An already-running SQL statement may therefore overrun the 20-second scheduling deadline only by its remaining statement timeout (at most two seconds), plus bounded driver settlement/rollback; the implementation must await cancellation or transaction rollback and must not return through an uncancelled `Promise.race`. Physical-trigger cleanup receives the same still-running signal rather than starting a fresh 25-second window. Aggregate counts include only committed pages; a deadline inside a page rolls that page back, leaves earlier committed pages valid, and schedules the rest for a later run. This design bounds added event-maintenance work, not the pre-existing identity cleanup or the total handler wall time.

### Capacity release

ACK locks the capacity row before the exact inbox row. The first valid ACK clears the protected payload and subtracts its measured stored bytes. It retains the row count through the metadata window. Repeating the same ACK returns the existing idempotent acknowledgement without another decrement.

Content expiry follows the same rule: only a transition from non-empty protected payload to empty subtracts bytes. Metadata deletion subtracts one retained row and any protected bytes still present. A transaction failure rolls back both the inbox change and ledger decrement.

Revocation, disconnection, and binding retirement stop new intake but keep already accepted receipts. They do not release rows or bytes early. An exact valid local ACK may still clear an already leased payload under the existing contract. Tenant deletion cascades both inbox and capacity rows.

### Fair cleanup

Replace the single global oldest-row page with a tenant-page scheduler:

1. Select one due capacity row ordered by `last_cleanup_at NULLS FIRST`, then `next_cleanup_at`, then `tenant_id`, using `FOR UPDATE SKIP LOCKED`.
2. In that tenant transaction, lock the capacity row and use one set-based content-clear statement for at most 100 due payloads plus one set-based metadata-delete statement for at most 100 due rows. Each statement returns aggregate rows and protected bytes; no per-row SQL loop is permitted.
3. Use one bounded query/update step to apply those returned deltas and derive the tenant's next capacity-changing expiry. Set `last_cleanup_at` from the database. A page has a fixed small number of SQL statements regardless of whether it changes one row or 200 rows.
4. If the tenant still has due work, keep `next_cleanup_at` due. Otherwise set it to the earliest future content or metadata expiry, or null when no rows remain.
5. Before every awaited SQL boundary, apply the remaining-budget rule above. Commit, then select another tenant. Stop after 100 tenant pages, the shared 20-second cleanup deadline, an abort signal, or no due tenant. No lock waits more than one second; no statement receives more than two seconds or more than the remaining retention budget.

Because the just-processed tenant has the newest `last_cleanup_at`, other due tenants are selected before it. A lone full tenant can consume multiple pages in one invocation. Concurrent cleanup instances skip claimed tenant ledgers and cannot double-release capacity.

Run scheduled cleanup hourly instead of daily. Opportunistic cleanup happens only after the request has passed every zero-mutation decision. Signed ingress may run one due page for its exact tenant only after a novel or partial event commits as `accepted`; exact duplicates, binding/authority rejection, malformed input, and `limited` outcomes never run cleanup. Authenticated pull may run one due page only after its principal and request inputs are accepted, before reading that tenant's page; authentication/validation refusal never runs cleanup. Neither path sweeps another tenant. The cron remains authenticated by `CRON_SECRET` and reports page, row, and byte-release counts without tenant ids or payload data.

## User Experience

Most owners see no change. Managed notifications continue to arrive and exact retries stay invisible.

When the hosted receiver is temporarily full or receiving an unsafe burst, it returns `429` to the sender. DorkOS keeps no partial event and discloses no account details. An online instance can release protected-byte capacity by durably accepting and acknowledging pending events; scheduled retention releases expired payload and metadata capacity. A 101st subscription to one physical event binding is rejected through the existing owner command flow before provider mutation. If a reserved activation becomes terminal after an upstream trigger mutation, existing captured-binding cleanup removes only an unshared trigger and preserves a shared one.

Operational documentation explains the static limits, generic overload code, hourly cleanup, and the distinction between payload bytes and retained dedupe rows. It also states that provider retry timing is external and a `Retry-After` header is advisory.

## Testing Strategy

### Schema and migration

- Apply every site migration in order to a real offline Postgres fixture.
- Simulate an old-version write after migration backfill and prove cutover reconciliation catches it while readiness stays off; prove exact reconciliation then permits readiness.
- Seed existing inbox rows before the new migration and prove exact backfill of rows, non-empty protected bytes, and next cleanup time.
- Prove negative counter checks, tenant cascade, index presence, and historical migration immutability.
- Prove a seeded over-limit tenant makes the migration fail rather than resetting or truncating data.

### Admission and mounted route

Extend the existing migrated event integration fixture. Use an internal small policy for most boundary tests while retaining at least one mounted route test against the production composition.

- Exactly-at-limit succeeds; the next novel event returns generic 429 with the expected `Retry-After` and inserts nothing.
- Protected-byte and retained-row bounds independently fail on the first prospective value above the limit.
- 100 active subscriptions are accepted atomically; 101 are rejected without partial inbox rows.
- Exact duplicate delivery returns 202, preserves the original rows/ciphertext/deadlines, changes no rate/row/byte counter, and does not opportunistically clean unrelated expired rows for that tenant.
- Partial duplicate reserves only missing rows/bytes and exactly one arrival unit.
- Two concurrent novel events whose combined result would exceed a bound produce at most the permitted total. The production Neon Pool fixture must prove the emitted transaction and `FOR UPDATE` sequence. Because its PGlite socket replacement serializes one embedded connection, the report must not call it lock-contention proof. A deterministic two-transaction barrier must make a removed-lock mutant exceed the bound or fail. The design environment has no local Postgres binaries and its Docker daemon is unavailable. If implementation can provision an isolated real Postgres service, repeat the contention case there and label it separately; never use production. Otherwise disclose that limitation and do not claim PGlite proves lock contention.
- Two concurrent exact duplicates insert and charge once.
- A transaction queued across a UTC-minute boundary samples a fresh database clock after the capacity lock, never moves the stored window backwards, and calculates `Retry-After` from that same instant.
- A foreign tenant at its own limit does not affect another tenant.
- Invalid signature, malformed envelope, oversized request, absent binding, and revoked subscription create no capacity row or counter change and do not opportunistically clean unrelated expired rows for the candidate tenant.
- Route error bodies and logs contain no tenant, limit usage, connection, subscription, account, or payload data.

### Release and cleanup

- Valid first ACK subtracts exact stored bytes; repeated ACK does not decrement twice; row capacity remains reserved.
- Content expiry subtracts bytes once across received, leased, acknowledged, and expired states.
- Metadata expiry decrements rows once and removes remaining payload bytes if necessary.
- A forced transaction failure leaves both inbox and counters unchanged.
- Concurrent ACK and cleanup cannot make counters negative or release the same bytes twice.
- At least 25 noisy/due rows for tenant A plus a later due row for tenant B prove B receives a cleanup page; reset/ordering mutants must starve B and fail.
- Multiple cleanup workers claim different tenant ledgers or no-op safely; totals match actual inbox aggregates after both finish.
- Cleanup page, page-count, time, and abort bounds are pinned by tests. A deterministic clock/query seam makes multiple individually sub-two-second operations cross a small page deadline: the in-progress page rolls back, prior committed-page counts remain exact, and the next SQL never starts. Removing the per-SQL deadline check must make this control fail; do not use an arbitrary sleep or an uncancelled `Promise.race`.

### Production transaction seam

Extend the production Neon Pool/PGlite fixture to prove the capacity path acquires one production driver transaction and emits the expected row-lock/commit or rollback sequence. Do not substitute a PGlite Drizzle client for this test, because that would bypass the production transaction constructor.

### No live load

Do not call Composio, send email, mutate a live database, or run production load. The public seam is a signed mounted request backed by migrated offline Postgres. Completion evidence labels source, fixture, and live proof separately; DOR-1905 stays live-pending where it is already live-pending.

## Performance Considerations

The 600-per-minute value bounds novel accepted work, not total request or edge-flood work. Invalid signatures, duplicates, and refused requests still consume bounded body/signature/lookup work; network-edge flood protection remains out of scope. Admission preflights rate and row ceilings before normalization/encryption, then checks exact stored bytes after protection.

Same-tenant event mutations serialize on one small row; different tenants proceed independently. Admission uses indexed exact binding/subscription/dedupe lookups and counter arithmetic instead of aggregating the full inbox. Fan-out is capped at 100. Cleanup uses a fixed small set of set-based statements for each tenant page, checks its remaining budget before every SQL boundary, commits at most 100 content clears plus 100 metadata deletes, and yields between tenant transactions.

The new index makes due-tenant selection bounded. Hourly cleanup increases invocation frequency but each run is strictly capped and uses the existing authenticated route. Operational metrics may count generic accepted/limited outcomes, but logs must not include payloads or secret/tenant identifiers.

## Security Considerations

- Raw-size and project-signature checks remain before tenant lookup or capacity mutation.
- A capacity row cannot create authority. The binding, provider generation, account identity, subscription state, and tenant are rechecked after the capacity lock.
- Limits are tenant-scoped and enforced by database locks across Vercel instances.
- Exact duplicates are free only while the 30-day receipt exists and only for the exact per-subscription identity.
- Generic overload responses prevent capacity and tenant enumeration.
- Protected-byte accounting measures ciphertext storage without exposing or logging plaintext.
- Failed, malformed, unauthorized, foreign-tenant, and rejected requests do not consume or release another tenant's capacity.
- Counters never authorize reads, pulls, ACKs, or subscription changes; existing instance and grant checks remain decisive.

## Documentation

Update:

- `contributing/managed-connections-operations.md` with limits, overload response, cleanup cadence, failure inspection, and recovery steps.
- DOR-1909's frozen source/fixture evidence handoff for the DOR-1905 owner, which later updates `contributing/connections-security-verification.md`; DOR-1909 does not depend on that unmerged guide and does not close unrelated live gates.
- relevant schema/service TSDoc with accounting units and lock order.
- API/OpenAPI documentation only if the managed webhook route is represented there; otherwise keep the private receiver contract in operations docs.

No end-user marketing claim is added.

## Implementation Phases

- **Phase 1 — Durable admission ledger:** constants, schema, migration/backfill, capacity module, lock order, and subscription fan-out bound.
- **Phase 2 — Atomic ingress and overload contract:** signature-first candidate resolution, duplicate-before-charge admission, atomic persistence, and generic 429 route behavior.
- **Phase 3 — Transactional release and fair maintenance:** ACK/expiry/delete accounting, tenant-page cleanup, opportunistic exact-tenant cleanup, hourly cron, and concurrency tests.
- **Phase 4 — Verification and operations:** mounted signed-route matrix, production transaction fixture, counter-reconciliation guards, operations documentation, and an exact evidence handoff to the DOR-1905 owner.

## Open Questions

- ~~Should the limits be configurable per tenant?~~ **RESOLVED:** No. Use source constants in the first pass. This is a safety boundary, not an entitlement system, and a public override could silently weaken it.
- ~~Should an exact redelivery consume the arrival budget?~~ **RESOLVED:** No when it would insert no receipt. Dedupe must happen before quota charging. A partial duplicate that adds currently eligible receipts consumes one arrival unit and only the missing storage.
- ~~Should revocation delete retained event receipts to free quota?~~ **RESOLVED:** No. Revocation stops new intake. Existing receipts retain their current ACK and retention lifecycle so history and replay semantics do not change.
- ~~Should overload reveal which limit fired?~~ **RESOLVED:** No. Use one public code and retry delay; keep the private reason inside typed service flow and payload-free aggregate telemetry.
- ~~Should cleanup remain one global page?~~ **RESOLVED:** No. Use capacity-ledger tenant claims and least-recent maintenance order so unrelated tenants cannot be starved.
- ~~Should the receiver rely on `Retry-After` being honored?~~ **RESOLVED:** No. The service remains safe under immediate duplicate retries; the header is an advisory public contract.

## Related ADRs

- `decisions/260905-205123-dorkos-brokers-connector-calls-and-may-host-a-managed-provider.md`
- `decisions/260908-163050-hosted-event-capacity-is-a-tenant-scoped-transaction.md` (accepted)

## References

- DOR-1909 — Bound hosted notification intake and backlog
- DOR-1905 — Complete Connections security rollout verification and trust-boundary documentation
- [Composio trigger delivery](https://docs.composio.dev/kb/guide/platform-triggers)
- [Composio webhook subscriptions](https://docs.composio.dev/reference/api-reference/webhook-subscriptions)
