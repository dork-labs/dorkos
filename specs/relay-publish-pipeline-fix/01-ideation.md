---
slug: relay-publish-pipeline-fix
number: 70
created: 2026-02-27
status: ideation
---

# Relay Publish Pipeline Fix & Adapter System Improvements

**Slug:** relay-publish-pipeline-fix
**Author:** Claude Code
**Date:** 2026-02-27
**Branch:** preflight/relay-publish-pipeline-fix
**Related:** Spec 50 (Relay Core), Spec 53 (External Adapters), Spec 55 (Relay Convergence), Spec 57 (Runtime Adapters), ADR-0029

---

## 1) Intent & Assumptions

- **Task brief:** Fix the critical bug in `relay-core.ts:publish()` where an early return at lines 308-315 skips adapter delivery when no Maildir endpoints match the target subject. This completely blocks all Relay-based chat and Pulse dispatch. Additionally, address 9 companion issues found across the adapter delivery path, including missing DeliveryResult propagation, absent DLQ handling for adapter failures, hardcoded traceId, missing SQLite indexing, and gaps in reliability/observability.
- **Assumptions:**
  - Relay is the intended transport for chat messages (per Spec 55 Relay Convergence)
  - Adapters are first-class delivery targets, not secondary/fallback mechanisms
  - The ClaudeCodeAdapter's `deliver()` method returns quickly (spawns agent session async internally)
  - The existing Maildir delivery path (backpressure, circuit breaker, budget enforcement) is correct and should not change
  - The in-memory EndpointRegistry does not persist across server restarts (by design)
- **Out of scope:**
  - New adapter types (Telegram, webhook improvements)
  - Full Relay Convergence migration (Spec 55)
  - Mesh changes
  - Adapter hot-reload improvements beyond what's needed for the fix

## 2) Pre-reading Log

| #   | File                                                                            | Key Takeaway                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/relay/src/relay-core.ts` (927 lines)                                  | **THE BUG**: `publish()` returns early at lines 308-315 when `findMatchingEndpoints()` returns empty, dead-lettering the message and skipping adapter delivery at line 337. |
| 2   | `packages/relay/src/adapter-registry.ts` (157 lines)                            | `deliver()` returns `boolean`, discarding the adapter's `DeliveryResult`. Matches adapters by `subjectPrefix` (string or array).                                            |
| 3   | `packages/relay/src/types.ts` (362 lines)                                       | `AdapterRegistryLike.deliver()` returns `Promise<boolean>`. `DeliveryResult` has success/error/deadLettered/responseMessageId/durationMs but is lost.                       |
| 4   | `packages/relay/src/adapters/claude-code-adapter.ts` (627 lines)                | Handles `relay.agent.` and `relay.system.pulse.` prefixes. Has concurrency semaphore, trace spans, TTL budget, response publishing to `envelope.replyTo`.                   |
| 5   | `apps/server/src/services/relay/adapter-manager.ts` (827 lines)                 | Server-side lifecycle manager. Creates adapter instances from config. Hot-reload via chokidar. `buildContext()` enriches with Mesh agent info.                              |
| 6   | `apps/server/src/routes/sessions.ts` (317 lines)                                | `publishViaRelay()` publishes to `relay.agent.{sessionId}`. Returns hardcoded `traceId: 'no-trace'`. Registers console endpoint with swallowed errors.                      |
| 7   | `apps/client/src/layers/features/chat/model/use-chat-session.ts` (337 lines)    | Client-side Relay branch: calls `sendMessageRelay()`, receives responses via EventSource `relay_message` events.                                                            |
| 8   | `apps/client/src/layers/shared/lib/http-transport.ts` (614 lines)               | `sendMessageRelay()` POSTs with X-Client-Id, expects 202 with `{ messageId, traceId }`.                                                                                     |
| 9   | `packages/relay/src/endpoint-registry.ts` (183 lines)                           | In-memory Map of registered Maildir endpoints. Rejects wildcards. `hashSubject()` exported for DLQ use.                                                                     |
| 10  | `packages/relay/src/subscription-registry.ts` (223 lines)                       | Pattern-based pub/sub with NATS-style wildcards. Persists patterns to `subscriptions.json`.                                                                                 |
| 11  | `packages/relay/src/subject-matcher.ts` (207 lines)                             | `matchesPattern(subject, pattern)` with `*` (one token) and `>` (one-or-more remaining).                                                                                    |
| 12  | `packages/relay/src/dead-letter-queue.ts` (401 lines)                           | `reject()` writes to Maildir `failed/` and indexes in SQLite. `listDead()`/`purge()` for lifecycle.                                                                         |
| 13  | `packages/relay/src/maildir-store.ts` (457 lines)                               | Atomic delivery: `tmp/` -> `new/` -> `cur/` -> `failed/`. Claim/fail semantics.                                                                                             |
| 14  | `packages/relay/src/__tests__/relay-core.test.ts` (1409 lines)                  | Comprehensive Maildir pipeline tests. **Zero tests with adapterRegistry**. Test at line ~150 validates the buggy early-return behavior.                                     |
| 15  | `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts` (359 lines) | Tests adapter in isolation with mocks. No integration with RelayCore.                                                                                                       |
| 16  | `apps/server/src/routes/__tests__/sessions-relay.test.ts` (323 lines)           | Tests Relay path 202 receipt, endpoint registration. Uses mock RelayCore.                                                                                                   |
| 17  | `apps/server/src/services/session/session-broadcaster.ts` (336 lines)           | `setRelay()` injects RelayCore. `subscribeToRelay()` subscribes to `relay.human.console.{clientId}`, writes `relay_message` SSE events.                                     |
| 18  | `specs/relay-core-library/02-specification.md`                                  | Original Relay Core design. Publish pipeline had no adapter concept — the early return was correct at the time.                                                             |
| 19  | `specs/relay-external-adapters/02-specification.md`                             | Adapter system design. Says adapter delivery runs "after endpoint delivery, before returning result" but didn't update the early return path. The bug was introduced here.  |
| 20  | `specs/relay-runtime-adapters/02-specification.md`                              | ClaudeCodeAdapter design. End-to-end flow assumes adapter delivery is reached — no mention of Maildir endpoint prerequisite.                                                |
| 21  | `specs/relay-convergence/01-ideation.md`                                        | Convergence plan: migrate Pulse and Console to Relay transport. Depends on adapter delivery working.                                                                        |
| 22  | `decisions/0029-replace-message-receiver-with-claude-code-adapter.md`           | ADR-0029 (draft): Supersedes ADR-0027. Unifies all dispatch under AdapterRegistry.                                                                                          |
| 23  | `apps/server/src/index.ts` (lines 80-119)                                       | Initialization: AdapterRegistry -> RelayCore -> `relay.system.console` endpoint -> TraceStore -> AdapterManager -> setAdapterContextBuilder.                                |
| 24  | `research/20260227_relay_publish_pipeline_fix.md`                               | Research across NATS, RabbitMQ, Kafka, Azure Service Bus. All treat dead-lettering as last resort after ALL delivery mechanisms fail. Recommends unified fan-out model.     |

## 3) Codebase Map

**Primary components/modules:**

- `packages/relay/src/relay-core.ts` — Core publish pipeline, endpoint/subscription dispatch, DLQ routing
- `packages/relay/src/adapter-registry.ts` — Adapter lifecycle, subject-prefix matching, deliver routing
- `packages/relay/src/types.ts` — `RelayAdapter`, `DeliveryResult`, `AdapterRegistryLike` interfaces
- `packages/relay/src/adapters/claude-code-adapter.ts` — Claude Code agent dispatch, response publishing
- `packages/relay/src/dead-letter-queue.ts` — DLQ reject/list/purge operations
- `packages/relay/src/endpoint-registry.ts` — In-memory Maildir endpoint registry
- `apps/server/src/routes/sessions.ts` — `publishViaRelay()` chat message entry point
- `apps/server/src/services/session/session-broadcaster.ts` — SSE fan-in for relay_message events

**Shared dependencies:**

- `packages/relay/src/subject-matcher.ts` — NATS-style pattern matching
- `packages/relay/src/subscription-registry.ts` — Pattern-based pub/sub
- `packages/relay/src/maildir-store.ts` — Filesystem persistence
- `packages/relay/src/sqlite-index.ts` — SQLite message indexing
- `apps/server/src/services/relay/adapter-manager.ts` — Adapter lifecycle, context enrichment

**Data flow (chat message via Relay):**

```
Client POST /sessions/:id/messages
  → sessions.ts: publishViaRelay()
    → registerEndpoint('relay.human.console.{clientId}')
    → relayCore.publish('relay.agent.{sessionId}', payload)
      → validate → access control → rate limit → build envelope
      → findMatchingEndpoints() → [empty for relay.agent.*]
      → [BUG] DLQ + early return → adapter delivery SKIPPED
```

**Feature flags/config:** `DORKOS_RELAY_ENABLED` env var / `relay.enabled` config

**Potential blast radius:**

- Direct: 4 files must change (`relay-core.ts`, `adapter-registry.ts`, `types.ts`, `sessions.ts`)
- Tests: 3 test files need updates/additions (`relay-core.test.ts`, `adapter-registry.test.ts` [new], `sessions-relay.test.ts`)
- Safe: 10+ files confirmed no changes needed (endpoint-registry, subscription-registry, subject-matcher, maildir-store, claude-code-adapter, adapter-manager, session-broadcaster, client code)

## 4) Root Cause Analysis

- **Repro steps:**
  1. Enable Relay (`DORKOS_RELAY_ENABLED=true`)
  2. Open DorkOS chat UI
  3. Send a message in any session
  4. Message returns 202 but no response ever arrives
  5. Check Relay panel → dead letters with reason "no matching endpoints"

- **Observed vs Expected:**
  - **Observed:** Messages to `relay.agent.{sessionId}` are dead-lettered. ClaudeCodeAdapter never receives them. Pulse scheduled dispatches to `relay.system.pulse.*` are also dead-lettered.
  - **Expected:** Messages should reach ClaudeCodeAdapter via the AdapterRegistry, be processed, and responses should flow back to `relay.human.console.{clientId}`.

- **Evidence:**
  - `relay-core.ts:308-315`: Early return when `findMatchingEndpoints()` returns empty array
  - `relay-core.ts:337-348`: Adapter delivery code after the early return, never reached
  - `sessions.ts:160-167`: Only `relay.human.console.{clientId}` is registered as a Maildir endpoint; `relay.agent.{sessionId}` is never registered
  - `~/.dork/relay/mailboxes/abc1f1b3f0f7/failed/`: 4 dead-lettered Pulse messages with reason "no matching endpoints" confirming the bug
  - `relay-core.test.ts:~150`: Test validates `deliveredTo: 0` for unmatched subjects — the buggy behavior is tested as correct

- **Root-cause hypotheses:**
  1. (**Confirmed, high confidence**) The `publish()` early return at lines 308-315 was written in Spec 50 before adapters existed. Spec 53 added adapter delivery at lines 337-348 but didn't update the early return path. The specs say "after endpoint delivery, before returning result" but the early return at line 315 IS a return, so adapter delivery is unreachable.
  2. (Rejected) Missing endpoint registration — `publishViaRelay` could register agent endpoints. But this would be a workaround, not a fix. Adapters are designed to work without Maildir endpoints (per Spec 57, ADR-0029).

- **Decision:** Fix the publish pipeline to treat adapters as first-class delivery targets. Use the unified fan-out model (Solution B) where Maildir endpoints and adapters are both checked before dead-lettering.

## 5) Research

Research file: `research/20260227_relay_publish_pipeline_fix.md`

**Potential solutions:**

**1. Solution A: Minimal fix — move adapter delivery before early return**

- Smallest code change, easy to review
- Adapters still feel like an afterthought in pipeline structure
- Complexity: Low | Maintenance: Low

**2. Solution B: Unified fan-out model (Selected)**

- Remove early return. Always attempt both Maildir + adapter delivery. DLQ only when NOTHING delivered
- Treats adapters and Maildir uniformly as "delivery targets"
- Aligns with NATS (interest-based retention) and RabbitMQ (alternate exchange) patterns
- Natural extension point for future delivery mechanisms
- Complexity: Medium | Maintenance: Low

**3. Solution C: Two-phase delivery (RabbitMQ-inspired)**

- Explicit Phase 1 (Maildir) then Phase 2 (adapters)
- Clear separation but implies adapters are "secondary" — misleading for adapter-only subjects
- Complexity: Medium | Maintenance: Medium

**Industry patterns:**

- Every production message bus (NATS, RabbitMQ, Kafka, Azure Service Bus) treats dead-lettering as the **last resort** after ALL delivery mechanisms have been attempted
- RabbitMQ's Alternate Exchange is the closest analog — unroutable messages try the alternate before dead-lettering
- NATS checks ALL subscriber types (push, pull, queue groups) before declaring "no interest"
- MassTransit treats different transport types uniformly in its publish pipeline middleware

**Recommendation:** Solution B — unified fan-out with synchronous adapter delivery + 30s timeout

## 6) Decisions

| #   | Decision                      | Choice                                                                | Rationale                                                                                                                                                                   |
| --- | ----------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Publish pipeline fix approach | Solution B: Unified fan-out                                           | Cleanest long-term architecture. DLQ check happens once after all delivery attempts. Natural extension point for future delivery types. Aligns with NATS/RabbitMQ patterns. |
| 2   | Scope of improvements         | Comprehensive: all 10 issues                                          | User wants to clean up all known debt in the adapter delivery path in one pass.                                                                                             |
| 3   | DLQ policy on adapter failure | DLQ with 'adapter delivery failed' reason when adapter is sole target | Prevents silent message loss. Consistent with Azure Service Bus and EIP patterns. Partial delivery (Maildir succeeded but adapter failed) does NOT trigger DLQ.             |
| 4   | Adapter delivery sync model   | Synchronous with 30s timeout                                          | ClaudeCodeAdapter.deliver() returns quickly (spawns async). Gives accurate deliveredTo counts. Timeout protects against slow adapters. Enables DLQ-on-failure.              |

## 7) Complete Issue Registry

### ISSUE 1 (Critical): Early return in publish() skips adapter delivery

- **File**: `packages/relay/src/relay-core.ts` lines 308-315
- **Description**: When `findMatchingEndpoints()` returns empty, `publish()` dead-letters and returns immediately. Adapter delivery at lines 337-348 is never reached. Completely blocks Relay-based chat and Pulse dispatch.
- **Fix**: Restructure to unified fan-out — remove early return, attempt all delivery targets, DLQ only when nothing delivers.

### ISSUE 2 (Medium): DeliveryResult from adapter is discarded

- **File**: `packages/relay/src/adapter-registry.ts` lines 128-133
- **Description**: `AdapterRegistry.deliver()` returns `boolean`, discarding the adapter's rich `DeliveryResult` (success, error, deadLettered, responseMessageId, durationMs).
- **Fix**: Update `AdapterRegistryLike.deliver()` return type to `Promise<DeliveryResult | null>`. Propagate result through relay-core.

### ISSUE 3 (Medium): No reliability checks for adapter delivery

- **File**: `packages/relay/src/relay-core.ts` lines 337-348
- **Description**: Maildir delivery has backpressure, circuit breaker, and budget enforcement. Adapter delivery has none. An overwhelmed or failing adapter has no protection.
- **Fix**: Add timeout protection (30s) via `Promise.race`. Consider adapter-level circuit breaker using existing `CircuitBreakerManager`.

### ISSUE 4 (Medium): No dead-letter handling for adapter delivery failures

- **File**: `packages/relay/src/relay-core.ts` lines 343-347
- **Description**: When adapter delivery throws, only `console.warn` is logged. Message is silently lost with no recovery.
- **Fix**: If adapter was the sole delivery target and it fails, dead-letter with reason `'adapter delivery failed: <error>'`.

### ISSUE 5 (Low): Hardcoded traceId in publishViaRelay

- **File**: `apps/server/src/routes/sessions.ts` line 186
- **Description**: Returns `traceId: 'no-trace'` instead of a real trace ID. Client cannot link to trace.
- **Fix**: Use the envelope's message ID as a trace correlation ID or extract from publish result.

### ISSUE 6 (Low-Medium): Race condition between POST and SSE subscription

- **File**: `apps/server/src/routes/sessions.ts` and `session-broadcaster.ts`
- **Description**: If POST message arrives and adapter responds before SSE subscription is established, response events hit Maildir but don't reach the SSE stream.
- **Fix**: Document as known limitation. The subscription dispatch at lines 328-333 happens before the early return, so subscription-based delivery mitigates this for most cases.

### ISSUE 7 (Medium): Response publishing could trigger the same early-return bug

- **File**: `packages/relay/src/adapters/claude-code-adapter.ts` (publishResponse)
- **Description**: `publishResponse()` publishes to `relay.human.console.{clientId}`. If console endpoint registration failed (swallowed error), responses hit the same DLQ path. Subscription dispatch still works, so data reaches the client, but dead letters are incorrectly created.
- **Fix**: Resolved by Issue 1 fix — but also improve console endpoint registration error handling in `publishViaRelay()`.

### ISSUE 8 (Low): Missing SQLite indexing for adapter-delivered messages

- **File**: `packages/relay/src/relay-core.ts` lines 337-348
- **Description**: Maildir-delivered messages are indexed in SQLite. Adapter-delivered messages have no index entry, creating an incomplete audit trail.
- **Fix**: Insert a SQLite index entry for adapter-delivered messages with `status: 'adapter_delivered'`.

### ISSUE 9 (Low): No trace recording in RelayCore for non-ClaudeCode adapters

- **File**: `packages/relay/src/relay-core.ts` lines 337-348
- **Description**: Trace span creation is inside ClaudeCodeAdapter, not in relay-core. Future adapters won't have automatic tracing.
- **Fix**: Add trace span creation in relay-core's adapter delivery path, before calling `adapterRegistry.deliver()`.

### ISSUE 10 (Informational): Adapter context builder can return undefined silently

- **File**: `packages/relay/src/relay-core.ts` line 339
- **Description**: `adapterContextBuilder?.(subject)` uses optional chaining. Adapter receives no context if builder is unset or returns undefined.
- **Fix**: Document as expected behavior. ClaudeCodeAdapter handles missing context gracefully.

## 8) Test Coverage Gaps

### relay-core.test.ts

- **No adapter integration tests**: Zero tests construct RelayCore with an adapterRegistry
- **Buggy behavior tested as correct**: Test at line ~150 validates `deliveredTo: 0` for unmatched subjects
- **Missing tests**: mixed delivery (Maildir + adapter), adapter-only delivery, adapter failure handling, adapterContextBuilder, adapter delivery timeout

### Missing test files

- **adapter-registry.test.ts**: No dedicated tests for `deliver()`, `getBySubject()`, lifecycle
- **Integration test**: No end-to-end test covering publish -> adapter -> response -> subscription dispatch

### Existing tests that need updates

- `relay-core.test.ts`: Update "returns deliveredTo=0 when no endpoints match" test
- `sessions-relay.test.ts`: Add traceId propagation test
