---
slug: relay-delivery-receipts
number: 261001-201020
created: 2026-10-01
status: specified
---

# Durable Relay HTTP delivery receipts

**Status:** Approved — Frozen design; delivery pending verified merge/DONE
**Author:** Codex (GPT-6.1 Sol, Medium; explicitly selected by the operator)
**Date:** 2026-10-01
**Work item:** DOR-2666, Relay project
**Gate:** Frozen after independent design re-review by `/root/receipt_spec_adversarial` (GPT-6.1 Sol, Medium). No remaining freeze blockers were reported. This is design-only review, not runtime proof. Canonical decomposition is prepared; every implementation task is pending, and delivery remains pending verified merge/DONE.
**Frozen at:** 2026-10-01T20:37:33Z

## Overview

Add an authoritative, minimized delivery receipt to HTTP publishes whose destination uses the detached `relay.agent.*` delivery path. The existing message ID locates a new read-only status resource. A caller that omits `replyTo` can observe a later `at_capacity` refusal without changing message routing, adding a durable queue, or automatically resending a message.

The operator explicitly selected GPT-6.1 Sol/Medium and authorized direct assignment, parallel investigation, and shared ignored metadata. This design was authored by one writer in the separately prepared `codex/relay-delivery-receipts` worktree. Parent owns tracking, independent review and freeze. The `specified` manifest value describes artifact maturity; **Status: Approved — Frozen design** records the completed design gate; it does not claim implementation or delivery.

## Background / Problem Statement

`RelayPublishPipeline.publish` validates subjects and access, mints an envelope ULID, and applies rate-limit/policy/budget gates. It writes a `relay_index` accounting row with endpoint hash `*` and status `delivered` before dispatch. `AdapterDelivery.deliverDetached` immediately acknowledges agent delivery, so POST `/api/relay/messages` returns HTTP 200 with a positive delivery count while the real attempt is still running. An adapter can then refuse with `at_capacity`; existing detached settlement dead-letters and optionally notifies a `replyTo` inbox. No reply subject means no direct failure observation for that publisher.

Neither the accounting row nor the adapter audit row is durable receipt truth. `SqliteIndex.rebuild` deletes all `relay_index` rows and reconstructs only remaining Maildir `new/`, `cur/`, and `failed/` files. Successful delivery removes message files; DLQ writes can themselves fail. Historical console-receipt research relates to superseded session-streaming paths and is not a reason to route private session messages through Relay again.

## Goals

- Preserve HTTP 200, request shape, and every existing response field/meaning.
- Give eligible HTTP callers a stable receipt and target-delivery status endpoint even without `replyTo`.
- Persist minimized observation metadata before any delivery effect of the tracked publish.
- Preserve receipt history across restart and routine index repair within a fixed seven-day window.
- Report uncertainty honestly and keep metadata failures separate from adapter failures.
- Preserve current access, consent, budget, capacity-hold, reserved-subject, and turn-ceiling behavior.

## Non-Goals

- Private session admission, queue placeholders, protected source unions, or reuse of `PrivateSessionMessageAcceptanceService` or its table.
- Durable dispatch, exactly-once delivery, POST idempotency, replay, retry controls, automatic resend, or inference calls.
- Business task success, read receipts, transcript/reply retrieval, or aggregate mailbox fan-out status.
- New settings, feature flags, user UI, SSE event streams, MCP tools, A2A changes, runtime SDK changes, CI changes, or operator authority changes.
- Retrofitting receipts onto older messages or non-HTTP publishes.

## Technical Dependencies

- Existing `@dorkos/db` with better-sqlite3 `^12.11.1`, Drizzle ORM `^0.45.3`, and drizzle-kit `^0.31.11`; no new library.
- Existing Express 5 router and session gate, Zod/OpenAPI schema facade, RelayCore composition, GC interval, and Transport facade.
- Generated migrations in `packages/db/drizzle`, read by `runMigrations` in `packages/db/src/index.ts`; existing migration tests and schema registration.
- Related source and research are listed in References. No external service or paid credential is necessary to implement or verify this feature.

## Detailed Design

### 1. Scope and compatibility

Only HTTP POST `/api/relay/messages` destinations whose subject begins with `relay.agent.` create a receipt. This predicate is the current detached-delivery predicate in `AdapterDelivery`, not `startsAgentTurns`, and must be shared/exported rather than copied into divergent rules. It includes supported runtime-scoped and agent-scoped subjects. Server-owned destination/reply-address and sender-principal route checks remain ahead of publishing.

A syntactically invalid or access-denied publish still throws/returns the existing validation or refusal response and creates no receipt. After normal subject/access validation mints a message ID, an eligible tracked attempt gets a receipt even if the rate limiter, consent, budget, turn ceiling, absent adapter, or skipped adapter later prevents target handoff. Other mailbox copies may still succeed. The receipt observes **only the matching detached agent-delivery attempt**.

Non-HTTP publishes and non-agent HTTP destinations retain their existing behavior and receive no receipt or status URL. No legacy envelope, reply notification, DLQ payload, or private notification is modified to carry receipt context.

### 2. Public schema and API

Add schemas/types to `packages/shared/src/relay-envelope-schemas.ts`, re-exported through `@dorkos/shared/relay-schemas`:

```ts
type RelayDeliveryReceipt = {
  messageId: string; // existing envelope ULID
  scope: 'agent_delivery';
  state: 'accepted' | 'delivered' | 'failed' | 'outcome_unknown';
  acceptedAt: string;
  updatedAt: string;
  settledAt?: string;
  expiresAt: string;
  failure?: {
    code: RelayDeliveryFailureCode;
    message: string;
  };
};

type RelayDeliveryFailureCode =
  | 'at_capacity'
  | 'chat_unavailable'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'initiate_denied'
  | 'untrusted_bridge_principal'
  | 'turn_ceiling'
  | 'adapter_unavailable'
  | 'not_dispatched'
  | 'adapter_failed'
  | 'observation_lost';
```

Validate ULID route IDs as 26 uppercase Crockford Base32 characters, with the first character from 0 through 7 (`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`); timestamps are ISO strings. The public schema enforces field/state consistency: accepted/delivered have no failure; accepted has no settledAt; delivered/failed/outcome_unknown have settledAt; failed and outcome_unknown have failure. `observation_lost` belongs only to outcome_unknown. No arbitrary error message is interpolated into public or stored failure text. Use fixed, bounded safe messages keyed by this closed vocabulary; e.g. at_capacity: “The agent was busy and did not take this message.” Unknown: “DorkOS could not confirm how this delivery ended.” These describe delivery observation and never recommend retry.

POST remains **200** on its existing successful publish-return path. Add optional `receipt` to `PublishResult` and add `statusUrl` at the HTTP route only. Existing `messageId`, `deliveredTo`, `rejected`, `adapterResult`, and `mailboxPressure` are unchanged. Example:

```json
{
  "messageId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "deliveredTo": 1,
  "adapterResult": { "success": true, "durationMs": 0 },
  "receipt": {
    "messageId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "scope": "agent_delivery",
    "state": "accepted",
    "acceptedAt": "2026-10-01T20:00:00.000Z",
    "updatedAt": "2026-10-01T20:00:00.000Z",
    "expiresAt": "2026-10-08T20:00:00.000Z"
  },
  "statusUrl": "/api/relay/messages/01ARZ3NDEKTSV4RRFFQ69G5FAV/status"
}
```

GET `/api/relay/messages/:messageId/status` returns the bare receipt, HTTP 200 and `Cache-Control: no-store`. It is read-only. Unknown, expired, older-untracked, and other-owner receipt IDs all return the same 404 body `{ error: 'Delivery receipt not found', code: 'RELAY_RECEIPT_NOT_FOUND' }`. A malformed ID returns 400 `INVALID_RELAY_MESSAGE_ID` after the existing auth gate. Storage unavailable returns 503 `RELAY_RECEIPT_STORAGE_UNAVAILABLE`, observer contention returns 503 `RELAY_RECEIPT_OBSERVER_BUSY`, and active caller-owned transaction returns 503 `RELAY_RECEIPT_TRANSACTION_ACTIVE`; none returns 404 or fabricated state. Status reads never fall back to the index, trace, or DLQ and never reveal an envelope.

If initial receipt insertion fails, POST returns 503 with `RELAY_RECEIPT_STORAGE_UNAVAILABLE` and zero delivery effects. A failure reading the final POST snapshot after an effect has occurred also returns a storage 503, **with the minted messageId and statusUrl** so callers retain a locator; the response does not claim that resending is safe. Existing pre-publish 400/403/422 responses remain unchanged. Register all schemas/responses in server OpenAPI, including every pre-effect availability code and post-insertion locator-bearing 503 shape, 404, and 503. Keep route matching compatible with existing `/messages/:id` and `/messages/:messageId/trace` routes.

### 2a. Locator preservation across the complete HTTP route

Declare messageId/statusUrl locator variables outside the route's entire try/catch. The internal onReceiptCreated callback populates them synchronously immediately after the initial receipt commit. This survives a pipeline exception before publish returns, a final snapshot read error, subject-label lookup, activityService.emit rejection, response-schema work, and any later synchronous response serialization error; merely retaining publishResult inside the try is insufficient.

Every structured post-insertion route error response includes the **same** messageId/statusUrl, alongside its safe error/code, while preserving the actual known receipt outcome. Auxiliary activity emission is best-effort and should be caught/logged separately so a delivery accepted successfully still returns its ordinary 200 receipt. It cannot settle the receipt, resend, refund, or create a failure DLQ. The outer catch remains a second fence: any other route error after insertion returns 503 `RELAY_RECEIPT_RESPONSE_UNAVAILABLE` plus locator, and never a bare pre-effect PUBLISH_FAILED response or a claim that nothing happened. Pre-insertion storage/transaction/observer errors have no receipt locator and guarantee zero delivery effects; pre-existing validation/authority errors keep their old statuses.

If headers have already been sent or the network disconnects, HTTP cannot promise delivery of an error body. Respect Express response state and do not attempt a second response; retain/log only safe locator metadata and leave receipt observation untouched. Lost transport responses are not permission to resend and do not introduce POST idempotency. Test a rejecting activityService.emit and a forced later response-construction exception through the real route, with a committed receipt and exact locator assertions in every structured error response.

### 3. State semantics and transition table

`accepted` means a durable observation record exists and this publish's target-delivery decision has not yet been durably settled. It is not a durable queue, admission guarantee, observed turn start, or promise of eventual execution.

`delivered` means the matching adapter reported non-skipped success. It does not prove that a reply was read or the requested task succeeded.

`failed` means this target was prevented from delivery by a gate, had no adapter, was deliberately skipped, or its adapter explicitly reported failure. It makes no general promise that no side effect occurred. `at_capacity` is carried verbatim from `DeliveryResult.code`, never inferred from message wording.

`outcome_unknown` means observation was lost through process restart, thrown/synchronously thrown delivery, or inability to durably record settlement. Thrown code can have run effects before throwing, so it is not translated to a confident no-effect failure. No state grants permission or a token to resend.

| Event                                                      | From     | To / code                                                 |
| ---------------------------------------------------------- | -------- | --------------------------------------------------------- |
| Rate limit refuses                                         | accepted | failed / rate_limited                                     |
| Consent/bridge/budget gate refuses                         | accepted | failed / corresponding closed gate code                   |
| Turn ceiling refuses                                       | accepted | failed / turn_ceiling                                     |
| No matching adapter before handoff or detached result null | accepted | failed / adapter_unavailable                              |
| Adapter returns skipped                                    | accepted | failed / not_dispatched                                   |
| Adapter returns success, not skipped                       | accepted | delivered                                                 |
| Adapter returns explicit failure                           | accepted | failed / supported machine code, otherwise adapter_failed |
| Adapter throws/rejects                                     | accepted | outcome_unknown / observation_lost                        |
| Receipt settlement write fails                             | accepted | attempt outcome_unknown / observation_lost                |
| Older boot still has accepted row                          | accepted | outcome_unknown / observation_lost                        |
| Late/duplicate terminal callback                           | terminal | unchanged                                                 |

The intentional skipped classification means “the requested target delivery did not occur”; it does not change the adapter's existing echo/skip behavior or manufacture DLQ entries. A terminal receipt is immutable. Compare-and-set settlement requires state accepted, the owning boot epoch, and matching current singleton observer ownership in the same transaction. A late callback cannot overwrite recovery or another terminal result.

### 4. Authoritative data model

Add `relay_delivery_receipts` and the singleton `relay_receipt_observer_owner` defined in §5a in a separate schema module `packages/db/src/schema/relay-delivery-receipts.ts`:

| Column                                        | Meaning                                                             |
| --------------------------------------------- | ------------------------------------------------------------------- |
| message_id (PK, non-null text)                | Existing ULID, one receipt per tracked publish                      |
| subject (non-null text)                       | Exact validated target; internal metadata only                      |
| owner_user_id (nullable text)                 | Verified request owner; null explicitly means login-off local trust |
| state (closed text enum)                      | Public receipt state                                                |
| boot_epoch (non-null text)                    | Random identity of the RelayCore process owning this observation    |
| accepted_at, updated_at (non-null text)       | ISO timestamps                                                      |
| settled_at (nullable text)                    | Terminal timestamp                                                  |
| expires_at (non-null text)                    | accepted_at + 604800000 ms                                          |
| failure_code, failure_message (nullable text) | Closed code and fixed minimized text                                |

Index `(expires_at, message_id)` for bounded pruning and `(state, boot_epoch)` for recovery. No cascading foreign key from owner identity: account removal must not silently erase observation history. No payload, replyTo, from, access token, trace dump, transcript, private source kind/ID/generation, or protected content is stored. Public output omits owner, subject, and boot epoch.

This table is authoritative metadata, not an extension of `relay_index`; `rebuildIndex()` never drops or reconstructs it. Maildir remains the source of truth for payload persistence. Amend ADR-0013 narrowly through accepted design ADR `261001-201108`. Receipt durability means committed metadata survives ordinary process restart and index rebuilding; the existing database uses WAL with synchronous NORMAL, so this is not a new guarantee against power-loss rollback or database-file corruption.

Register the new schema in `packages/db/src/schema/index.ts` and `packages/db/drizzle.config.ts`. Generate and commit a normal Drizzle migration, snapshot and journal using the repository migration workflow. Do not hand-patch an existing migration or recreate the DB. Verify upgrade of a pre-feature DB and repeat migration idempotency.

### 5. Composition and initial persistence ordering

Add `packages/relay/src/delivery-receipt-store.ts`, with clock injection and methods to create, get, settle by CAS, recover old-boot accepted records, and prune an ordered bounded batch. It receives `Db` directly and never delegates authoritative operations to `SqliteIndex`.

In `RelayCore`, resolve one `Db` variable first. For `options.db`, use the existing injected migrated DB; for standalone Relay, create `dataDir/index.db` and run migrations as today. Construct both SqliteIndex and DeliveryReceiptStore from that same resolved DB. Preserve DB ownership/close behavior; do not close a caller-owned DB. A receipt store is required when trusted receipt context is requested; missing wiring must fail closed before effects, never silently return an untracked accepted publish.

Expose an internal typed publish option `receiptContext?: { ownerUserId: string | null; onReceiptCreated: (messageId: string) => void }`. The route-owned callback synchronously assigns the receipt locator to local variables immediately after the committed insertion and before any subsequent effect; it has no external action. The HTTP route supplies it only for the shared detached-subject predicate, using request identity policy below. It is not accepted by `RelaySendMessageRequestSchema` and is never copied into RelayEnvelope. Existing in-process callers omit it and remain unaffected.

At RelayCore entry for a tracked publish, reject `db.$client.inTransaction === true` before initialization, ID minting, receipt writes, or effects; return 503 `RELAY_RECEIPT_TRANSACTION_ACTIVE`. This guard also precedes receipt observer acquisition/recovery and any retry of initialization. After ordinary subject/access checks and ID minting, synchronously commit the receipt insertion **before rate-limit processing, accounting writes, Maildir fan-out, subscriber handlers, pending-buffer replay, adapter invocation or runtime effects**. Validation/access failure creates no receipt. Successful initial insertion is the necessary precondition for all later effects of the tracked publish. The initial record can outlive a crash before actual dispatch; recovery therefore conservatively labels it unknown, never queued or retryable.

Pass the same store/observation handle into the publish pipeline and AdapterDelivery. The pipeline settles target gate/no-match/ceiling outcomes independently from successful mailbox copies. AdapterDelivery owns settlement for a dispatched detached attempt. Return a fresh persisted snapshot on POST so a synchronous/fast terminal outcome is not overwritten with stale accepted state. Do not append a receipt snapshot and later mutate its object in memory.

### 5a. Exclusive database observer ownership

An epoch alone is not liveness: two RelayCore instances can share the same injected Db, use separate handles on the same file, or run in separate processes. Add an authoritative singleton row `relay_receipt_observer_owner` in the same receipt schema/migration: `singleton_key` (PK, constant `observer`), `owner_token` (unique core token), `pid`, `hostname`, and `claimed_at` (ISO wall-clock observation bound for process-start corroboration). Scope ownership by the actual SQLite database, not dataDir, caller options, or a lock-file path, so aliases and differently configured RelayCore instances still contend on one row. Distinct private in-memory databases are distinct ownership scopes; two cores using the same in-memory Db still contend.

Acquire in a short **BEGIN IMMEDIATE** transaction on a connection that is not already in a transaction. If no row exists, insert this token. If a row exists for another token, assess its holder using the existing `@dorkos/shared/process-liveness` functions against claimed_at; only `gone` permits replacement. `live-confirmed`, `live-unconfirmed`, malformed holder metadata, or a different hostname block acquisition. A holder naming the current PID and this process lifetime is live even when its token differs; use the same process-start corroboration for a genuinely recycled PID rather than treating all self-PID records as stale. Do **not** reuse `assessInstanceLockHolder`'s same-PID-means-gone policy. Liveness probing is bounded by the existing two-second process-start timeout. The immediate transaction serializes concurrent acquisition/replacement; there is no check/unlink race, heartbeat expiry, background lease renewal, or distributed leader election.

A second live core fails cleanly for receipt use with 503 `RELAY_RECEIPT_OBSERVER_BUSY`: it cannot create receipts, recover rows, settle or prune, or accept tracked delivery effects. It may retain unrelated existing non-receipt behavior. Its status handler also returns this explicit availability error, rather than initializing/recovering through a live owner's records. Test locking is not bypassed by NODE_ENV or DORKOS_SKIP_INSTANCE_LOCK. The server instance lock is useful precedent but insufficient: it is disabled in tests, covers a data directory rather than this DB, and does not prevent same-process RelayCore instances.

After the singleton row is acquired, recover older-token accepted rows before enabling receipt-observed publishes. Token equality is fenced in the **same immediate transaction** as each authoritative mutation (initial create, settle, recover, prune, and release). The observer may not steal a live/unconfirmed holder merely because a token is old, a heartbeat would be late, or wall-clock age is large. Cross-host shared SQLite operation is unsupported and fails closed on foreign hostname; no manual takeover HTTP action is added.

Active caller transactions prohibit owned release just as they prohibit other metadata mutations; close must not nest its cleanup into one. On graceful close, first latch the receipt subsystem closed so no new tracked publishes or pending callbacks can start mutations. In one owned transaction, mark any still-accepted rows for this token unknown and delete the singleton row **only when its owner_token still matches**. Late detached callbacks after close are no-ops. Release before the underlying DB is closed; never close a caller-owned DB. If close cannot commit, keep the durable ownership row and report a safe error: another core in the same still-live process must stay blocked until release succeeds or that process is gone. Cleanup may retry the same token-owned metadata release after the caller transaction ends, never replay a delivery. An owner-lost mutation fails without touching a successor's records.

This is deliberately a single-machine exclusive receipt observer, not a multi-writer durable dispatch service. Existing `apps/server/src/lib/instance-lock.ts`, `packages/shared/src/process-liveness.ts`, and `services/tasks/scheduler-lock.ts` supply the local ownership/liveness precedents; the scheduler's stale-heartbeat steal is unsuitable because it permits a transient dual leader. A receipt recovery path cannot reclassify a live delivery under that uncertainty.

### 5b. Transaction and asynchronous effect boundary

`Db` is caller-injected in the server path, so a nested Drizzle transaction or SQLite savepoint is **not** an independent durable commit. Receipt-observed publishing must never join a caller-owned transaction: guard `$client.inTransaction` synchronously at entry and immediately before every receipt commit/effect decision. Its own short create transaction must finish before any await, subscriber, Maildir or adapter effect; no transaction remains open across effects. A checked entry cannot be bypassed by awaiting initialization inside an outer transaction. Initialization/recovery/ownership acquisition likewise refuses an active outer transaction rather than using nested `db.transaction`.

Asynchronous settlement may run after another caller opened a transaction on the shared handle. In that case reject the mutation instead of nesting into it, take the observation-storage-error path, and never commit or roll back the caller's transaction. A metadata fallback to unknown is attempted only when the connection is again outside a transaction; otherwise the last durable state remains accepted until exclusive recovery. GET also fails 503 `RELAY_RECEIPT_TRANSACTION_ACTIVE` while that handle is inside an outer transaction, rather than expose an uncommitted receipt snapshot. This design uses the existing connection with explicit rejection; it does not add a second connection whose write can deadlock against a caller's SQLite transaction.

An integration test begins an outer transaction, invokes tracked publish, deliberately rolls back, and proves the publish refused with exactly zero adapter/subscriber/Maildir effects and no receipt. A control case commits a normal pre-effect receipt, dispatches once, then opens and rolls back an unrelated later transaction; the dispatched message's original receipt remains durable. Seed removal of the entry guard to make the first test fail for the intended rollback-after-effect hole.

### 6. Detached delivery and failure isolation

Observe the real registry delivery promise, including synchronous throw, null, skipped, explicit failure and non-skipped success. Receipt settlement must run in a dedicated isolated wrapper whose storage exceptions cannot fall into the adapter-failure catch. Today an exception inside a promise success callback can reach the generic catch; this implementation must not turn a successful turn into failed delivery because its receipt/index audit write threw.

Record the authoritative receipt outcome before best-effort audit index/DLQ/notification effects. Preserve existing logs, DLQ convention, reply-inbox/chat notices, and exactly the existing turn-reservation refund behavior; receipt persistence does not refund, reserve, send a notice, create a new DLQ entry, or invoke an adapter. A failure to create the DLQ must not prevent a persisted at_capacity receipt. Conversely, a bookkeeping error on the successful path must not cause failure DLQ/refund/notice effects.

If a terminal receipt write throws, isolate and log a safe observation error, then make one best-effort CAS to outcome_unknown/observation_lost. If that succeeds, reads return unknown. If storage remains unavailable, leave the last durable accepted record unchanged, return 503 on unavailable reads, and log the unrecorded observation; the next exclusive observer's recovery transitions accepted to unknown. Never report failed merely because storage failed. This residual is explicit: an accepted snapshot is the last recorded observation, not a liveness guarantee, and a transient storage fault may leave it accepted until recovery. No in-memory cache is treated as authoritative receipt truth.

Unexpected publisher bookkeeping failure after insertion but before dispatch gets a best-effort unknown settlement. If a detached attempt is already running, pipeline cleanup must not race it into a fabricated failed result; unknown is the only conservative observation fallback. Existing publish error behavior remains, with locator fields available on tracked post-insertion errors.

### 7. Bootstrap recovery and retention

Generate a fresh observer token/boot epoch per RelayCore instance. A different epoch is never evidence that the previous owner died; exclusive database observer acquisition below is the necessary recovery precondition. Recover older-owner accepted rows only after acquiring the exclusive database observer, once at construction/startup **after migrations and before receipt-observed publishing can be accepted**. A recovery storage error disables receipt-observed publishes and status reads with 503; it does not allow false acceptance and does not stop unrelated non-receipt Relay use. The store may retry initialization on a subsequent receipt operation after availability returns; this retries metadata recovery only, never a message. Do not run old-boot recovery on each GC sweep or reclassify current-boot accepted rows as interrupted solely by age.

After exclusive ownership is established, older-owner accepted rows become terminal unknown using CAS; already-terminal rows are untouched. Recovery does not inspect/re-drive Maildir or change the existing mailbox crash-recovery phase. Existing Relay mailbox recovery may continue its own subscriber behavior; receipts do not introduce additional dispatches and are not a durable replay queue.

Retain each receipt for exactly seven days from acceptedAt, regardless of envelope TTL, settledAt, DLQ deletion or adapter availability. expiresAt is immutable. `now >= expiresAt` is expired, and GET returns 404 immediately even if GC has not pruned it. Add an isolated phase to RelayGc using the existing sweep cadence; prune a bounded batch (500 rows) ordered by expiresAt/messageId, with a token-fenced transaction outside any caller-owned transaction and no effect on message files, index rows, traces, or private receipts. The maximum deletion per sweep is bounded; expired rows remain inaccessible until later sweeps catch up. Never extend retention on polling or settlement. Late callbacks after pruning are no-ops and cannot recreate a receipt.

### 8. Read ownership and auth transitions

Retain the existing app-wide session gate. When login is on, obtain ownership only from verified `res.locals.user.userId` (cookie or per-user API key). Do not accept an owner ID from body, subject, reply address, client ID, or arbitrary header. A per-user key is not operator consent; this metadata-only feature grants no operator action.

When login is off, create owner_user_id null and treat reads as existing local trust. The app cannot distinguish a local program from the person at the keyboard in this posture; document this rather than claim isolation based on the ULID or `from`.

When login is on, a non-null owner receipt is readable only by that exact verified user. A null-owner receipt created while login was off is readable only by the verified install-owner user, using `readOwnerAccount()` and direct trusted-ID comparison. Another authenticated user receives uniform 404; a missing verified identity fails closed (401 via the session gate; defensive route check when needed). Turning login off again restores local trust rather than stranding receipt history. No mass reassignment or ownership migration is necessary. Do not route through the private-session admission or room-author registry just to read this minimized resource.

### 9. File organization and implementation map

| File / area                                                                                        | Intended change                                                                                     |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/db/src/schema/relay-delivery-receipts.ts`                                                | Authoritative receipt metadata and singleton observer ownership schema/types                        |
| `packages/db/src/schema/index.ts`, `packages/db/drizzle.config.ts`, `packages/db/drizzle/*`        | Registration, generated migration/snapshot/journal                                                  |
| `packages/relay/src/delivery-receipt-store.ts`                                                     | Exclusive observer acquire/release, transaction guards, persistence, CAS, recovery, bounded pruning |
| `packages/relay/src/adapter-delivery.ts`, `types.ts`, `index.ts`                                   | Shared detached predicate, internal receipt context, public response type, isolated settlement      |
| `packages/relay/src/relay-publish.ts`, `relay-core.ts`, `relay-gc.ts`                              | Pre-effect insertion, gate/no-match settlement, composition/read access, startup recovery, GC       |
| `packages/shared/src/relay-envelope-schemas.ts`                                                    | Receipt/failure/response Zod schemas via existing facade                                            |
| `apps/server/src/routes/relay.ts`                                                                  | Trusted ownership context, pre-effect locator capture, complete route error fence, POST/status GET  |
| `apps/server/src/services/core/openapi-registry.ts`                                                | Actual 200/400/401/404/503 contract                                                                 |
| `packages/shared/src/transport.ts`, `apps/client/src/layers/shared/lib/transport/relay-methods.ts` | Additive send result and typed getRelayDeliveryReceipt method                                       |
| Existing Transport mocks/factories                                                                 | Implement the new method at the boundary; enumerate through rg                                      |
| Relay/DB/server tests and Relay docs                                                               | Seam verification, migration/ownership/recovery contracts and limits                                |

No additional server service domain is introduced. Shared/client imports use existing facades/barrels. SDK imports and AgentRuntime contract do not change.

## User Experience

An HTTP caller sends the same request and receives the same status code. For an agent destination it additionally gets a receipt and status URL. It may poll the URL, with its normal credential, while state is accepted; a capacity refusal appears as failed/at_capacity without requiring a reply inbox. A successful reported attempt appears as delivered; an interrupted/unobservable attempt appears as outcome_unknown. Polling has no routing effect and cannot renew the receipt.

Docs must explain that `deliveredTo` counts publish targets and can include detached acceptance or mailbox copies, while the receipt describes the agent attempt. Clients stop polling on terminal state, 404, or authentication failure and may back off while accepted; no auto-poller or UI is added here. A 503 asks the caller to retry the **status read**, never to resend the message. Unknown must never be presented as safe to retry.

## Testing Strategy

Use real RelayCore, a temporary real SQLite DB and real router for integration tests; fake only the adapter registry/runtime effect boundary and existing auth identity seam. Use deferred promises and injected clocks, not arbitrary sleeps. Each test carries a purpose comment and names exact message IDs, counts and state transitions.

| Boundary                    | Required evidence                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP regression             | POST agent target without replyTo → prompt 200 accepted; defer adapter → exact message becomes failed/at_capacity on GET                                                              |
| Success and variants        | Deferred success, explicit generic failure, null, skipped and synchronous/asynchronous throw each produce the specified exact state/code                                              |
| Policy gates                | Rate limit, consent, bridge, budget and turn ceiling produce target failure without dispatch; mailbox success cannot mask refused turn                                                |
| No matching adapter         | Receipt failed/adapter_unavailable; no phantom handoff; existing pending-buffer/DLQ behavior unchanged                                                                                |
| Initial persistence failure | Exact zero adapter calls, subscriber invocations, Maildir writes and runtime effects; 503                                                                                             |
| Settlement storage failure  | Successful adapter plus thrown store/audit write causes no failure DLQ, failure notice or receipt-caused refund; unknown CAS attempted; durable unknown if fallback works             |
| Persistent DB outage        | Status 503; no fake 404 or failed; reopen/recover outstanding accepted as unknown, zero replay                                                                                        |
| DLQ outage                  | Adapter at_capacity remains durable failed even when reject returns ok:false or throws                                                                                                |
| Durability                  | Real index rebuild and real DB close/reopen retain terminal receipt; no reconstruction from mailbox status                                                                            |
| Boot recovery               | Exact older-boot accepted row becomes unknown, terminal row unchanged, current-boot accepted stays accepted; zero new effects                                                         |
| CAS and prune races         | Duplicate/late callbacks cannot change terminal/recovered state or recreate pruned receipt                                                                                            |
| Ownership                   | Same verified user reads; another user 404; forged from/owner fields grant nothing; login-off→on null-owner is install-owner-only; login-off restores local trust                     |
| Data minimization           | Secret/payload sentinels absent from receipt columns and all status JSON, including errors                                                                                            |
| Retention                   | Clock at expiresAt gives 404 before physical sweep; 500-row prune bound; polling does not change expiry; messages/private receipts untouched                                          |
| Upgrade                     | Prior DB upgrades with rows preserved; migration repeated safely; schema registry and generated artifacts agree                                                                       |
| Standalone path             | Real RelayCore with no options.db migrates index.db and reads/reopens receipts; caller-owned DB remains open                                                                          |
| Compatibility               | Non-agent and untracked publish unchanged; actual request stripping rejects attempted receipt ownership control; legacy POST fields and 200 retained; OpenAPI/Transport schema agrees |

Additional blocker regression requirements:

- Two RelayCore instances using the same injected Db: first has a deferred live accepted delivery; second cannot acquire/recover or publish tracked effects, first receipt remains accepted, and first success settles delivered. Repeat using two handles on the same file.
- Two separate real child processes contend on one temporary file DB without inference; prove exact one observer owner and zero loser effects. Stop only the child PID the test owns. After that owner exits, successor acquisition recovers exactly the abandoned receipt as unknown.
- Same-PID different tokens, process-liveness live-unconfirmed, malformed ownership metadata, and foreign-host records all block. Dead/recycled corroborated PID permits takeover. No elapsed-age shortcut or test-mode bypass may steal a live observer.
- An old callback after close/token handoff cannot write, settle/prune a successor row, or recreate a receipt. A failed release keeps another same-process observer blocked.
- Outer transaction publish rejection and rollback preserve the zero-effect invariant. An asynchronous settlement arriving during another caller's transaction cannot persist into that transaction or commit/rollback it.
- Rejecting activity emission does not erase the committed receipt/locator or turn accepted delivery into a false failure. A later structured route exception carries the exact messageId/statusUrl captured before publish returned; test pipeline post-insertion throw as well as post-publish throw.

Preserve existing adapter capacity tests proving only bridged human chats receive onHeld, turn-ceiling reservation/refund tests, private-message acceptance/dispatch tests, and the existing no-match behavior tests. Private suites are a regression fence, not new feature implementation.

For the central regression, first prove green baseline and test collection, temporarily remove detached receipt settlement, and confirm the exact POST→GET at_capacity test goes red for the intended reason. Restore and rerun. Separately seed initial-insertion bypass and verify the zero-effects test detects it. Do not run any credentialed eval, live provider test, or paid harness smoke.

Targeted implementation verification: changed receipt/adapter/route/migration test files with `pnpm vitest run <path>`, package typecheck/lint for relay/shared/db/server/client as changed, then `pnpm verify` as the required loop closer. No browser test is needed unless implementation adds a user-visible UI; this specification adds none. Migration generation/check must use the existing workflow rather than alter CI.

## Performance Considerations

One synchronous receipt insertion before eligible effects and one terminal CAS add bounded local DB work. Exact-ID reads use the primary key; no message scan or payload load. Seven-day acceptance-based expiry bounds retained history; a 500-row GC transaction bounds work per sweep. Observer acquisition uses one short BEGIN IMMEDIATE transaction with bounded local liveness probing; no heartbeat timer. Boot recovery selects accepted rows by indexed state/epoch; if large, process batches before enabling receipt traffic. Non-eligible publishes incur no receipt writes. No HTTP request waits for a model turn, no new timer per receipt, and no forced synchronous-full durability pragma is introduced.

## Security Considerations

Request subjects are routing data, not authentication. Store only verified user ownership or explicit login-off null; ID knowledge is not a read capability. Use the existing gate plus exact owner checks and uniform non-disclosing 404. Minimize receipt metadata and fixed failure text; arbitrary adapter errors can include sensitive content and must stay out of this store/resource. Reads reveal no private transcript or protected source, and never turn an API key into operator approval.

Exclusive observer ownership, same-PID/live-unconfirmed refusal, and caller-transaction rejection are prerequisites to trusted recovery. An epoch difference alone proves nothing about a live owner. Storage creation/recovery failures fail closed for receipt-observed publishing before effects. Terminal writes are separated from actual delivery classification so bookkeeping cannot cause replay, false DLQ/refund, or operator actions. Corruption recovery cannot invent success from the derived index. Receipt retention and expiry do not change mailbox/DLQ/private retention policies.

## Documentation

During implementation, update `docs/guides/relay-messaging.mdx` and `docs/guides/relay-observability.mdx` with POST compatibility, agent-delivery scope, polling example, at_capacity, uncertainty, local-trust limitations, seven-day expiry, and no automatic resend. Update `contributing/relay-adapters.md` only if the shared detached predicate/settlement seam needs author guidance. Add a user-facing unreleased fragment when the feature ships, following writing-for-humans and the retired-word gates. No release claim is warranted by frozen design or task decomposition alone.

## Implementation Phases

- **Phase 1 — Authoritative metadata and contract:** The design review/freeze is complete; canonical decomposition records every task pending. Implement schema/migration, store/state contracts, ownership and expiry tests, including exclusive observer and outer-transaction regression tests plus standalone bootstrap.
- **Phase 2 — Delivery observation:** Wire trusted context, pre-effect insertion, gate/no-match outcomes, isolated detached settlement and old-boot recovery; prove zero-effect and no-false-failure tests.
- **Phase 3 — HTTP and verification:** Expose typed status GET and additive POST/OpenAPI/Transport, integrate bounded GC, write docs/fragment, and cross the real HTTP seam with targeted checks and mutation evidence.

These are design phases, not canonical tasks or an implementation claim. Parent manages available implementation slots and tracker state.

## Open Questions

No unresolved design decision remains. Independent re-review by `/root/receipt_spec_adversarial` (GPT-6.1 Sol, Medium) converged with no remaining freeze blockers. Implementation evidence, verified merge, and DONE remain pending; parent owns tracking and delivery gates.

- ~~(RESOLVED) Should HTTP use 202?~~ **Answer:** Keep existing 200, add receipt/statusUrl. **Rationale:** A compatible observation resource solves the gap without changing existing clients.
- ~~(RESOLVED) Should every fan-out target share one state?~~ **Answer:** Observe only detached agent target delivery. **Rationale:** A mailbox can succeed while its paid turn is refused; aggregate success would lie.
- ~~(RESOLVED) Is relay_index sufficient durable storage?~~ **Answer:** Separate authoritative metadata table; accepted design ADR narrowly amends 0013. **Rationale:** Rebuild erases synthetic rows and successful payload files are deleted.
- ~~(RESOLVED) How long does status exist?~~ **Answer:** Seven days from acceptance, fixed expiresAt. **Rationale:** Deterministic bounded history independent of TTL and DLQ cleanup.
- ~~(RESOLVED) Who reads receipts created before login?~~ **Answer:** Local trust while login off; verified install owner only when on. **Rationale:** Nullable ownership describes actual original trust posture without inventing a human identity.
- ~~(RESOLVED) Can unknown be resent automatically?~~ **Answer:** No. **Rationale:** Observation loss does not prove absence of effects.
- ~~(RESOLVED) Can storage errors become adapter failures?~~ **Answer:** No; isolated settlement attempts unknown, retaining last durable observation if DB stays unavailable. **Rationale:** Bookkeeping cannot truthfully decide whether the agent ran.
- ~~(RESOLVED) Can a new epoch recover a live observer?~~ **Answer:** No; acquire the database singleton exclusively after trustworthy holder-gone evidence. **Rationale:** Two cores/processes can share the same SQLite database.
- ~~(RESOLVED) Can tracked publishing join a caller transaction?~~ **Answer:** Reject active `$client.inTransaction` before initialization and effects. **Rationale:** Savepoint release is not a durable commit and an outer rollback would erase acceptance after dispatch.
- ~~(RESOLVED) Where is the HTTP locator retained?~~ **Answer:** Route-local capture at committed receipt creation, outside the whole route try/catch. **Rationale:** Post-publish activity/serialization errors also occur after delivery effects.
- ~~(RESOLVED) Does this unify private admission?~~ **Answer:** No changes to private source union, admission service or queue. **Rationale:** Its transactional protected-content/authority guarantee is a separate seam.

## Related ADRs

- `decisions/0013-hybrid-maildir-sqlite-storage.md`: accepted Maildir payload truth and derived index; amended only for authoritative receipt metadata by the accepted design ADR below.
- `decisions/261001-201108-relay-delivery-receipts-own-authoritative-metadata.md`: accepted design decision extracted from this spec; delivery pending.
- `decisions/260819-034718-the-relay-holds-a-bridged-message-for-a-busy-agent.md`: narrow hold license remains unchanged.
- `decisions/260824-120429-one-turn-ceiling-at-the-relay-adapter-dispatch.md`: central reserve/refund and mailbox-versus-turn distinction remain unchanged.

## References

- DOR-2666 (Relay): parent-owned tracker item; no tracker writes by this author.
- `specs/relay-delivery-receipts/01-ideation.md`: source findings, alternatives, authorization and decisions.
- `packages/relay/src/relay-publish.ts:523`, `:660`, `:690`; `packages/relay/src/adapter-delivery.ts` (`deliverDetached`, `deadLetterDetached`, `mayHold`).
- `packages/relay/src/sqlite-index.ts:411` (`rebuild`), `maildir-store.ts` (`complete`), `dead-letter-queue.ts` (`reject`), `relay-gc.ts`, `relay-core.ts` DB composition.
- `apps/server/src/routes/relay.ts:189`, `:289`; `services/core/auth/session-gate.ts`; `routes/room-caller.ts` identity background.
- `packages/shared/src/relay-envelope-schemas.ts`; `packages/shared/src/transport.ts:1844`; `apps/server/src/services/core/openapi-registry.ts:1923`.
- `packages/db/src/schema/relay.ts`; `packages/db/src/index.ts`; `packages/db/drizzle.config.ts`.
- `apps/server/src/lib/instance-lock.ts`, `packages/shared/src/process-liveness.ts`, `apps/server/src/services/tasks/scheduler-lock.ts`: ownership and liveness precedent; receipt ownership uses database-level arbitration without test bypass or heartbeat stealing.
- `apps/server/src/services/session/private-messages/acceptance.ts:162`: exclusion boundary and uncertainty precedent; do not widen its source union.
- `research/20260224_relay_convergence.md`, `research/20260308_fix_relay_ghost_messages.md`: historical investigation, not current session contract.
- `AGENTS.md`, `REVIEW.md`, installed Flow canonical ideation/specification/ADR templates.

## Design freeze record

Independent reviewer: `/root/receipt_spec_adversarial`, GPT-6.1 Sol/Medium, design-only. The initial review required exclusive per-database observation ownership, rejection of caller-owned active transactions, and complete post-insertion route locator preservation; those corrections were incorporated. Re-review converged without remaining freeze blockers and parent authorized freeze and decomposition. No source implementation, runtime test, paid inference, tracker projection, commit, push, PR, merge or DONE is claimed by this record.
