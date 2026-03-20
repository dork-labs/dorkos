---
slug: relay-advanced-reliability
number: 52
created: 2026-02-24
status: ideation
---

# Relay Advanced Reliability

**Slug:** relay-advanced-reliability
**Author:** Claude Code
**Date:** 2026-02-24
**Branch:** preflight/relay-advanced-reliability
**Related:** [Relay Spec Plan](../../plans/relay-specs/03-relay-advanced-reliability.md), [Relay Litepaper](../../meta/modules/relay-litepaper.md)

---

## 1) Intent & Assumptions

- **Task brief:** Add advanced reliability features to the `@dorkos/relay` package — rate limiting (per-sender), circuit breakers (per-endpoint), and backpressure handling. This hardens the existing Relay core transport for production use where agents may generate high message volumes or encounter endpoint failures.
- **Assumptions:**
  - Relay core library (Spec 1 / spec #50) is implemented and provides the foundation: `RelayCore`, `SqliteIndex`, `MaildirStore`, `BudgetEnforcer`, `SignalEmitter`, `AccessControl`, `DeadLetterQueue`
  - This is a single-machine, single-process system — no distributed coordination needed
  - All three features are optional and configurable with sensible defaults
  - The at-most-once delivery guarantee must be preserved — reliability features add rejection, not retry
  - SQLite index already tracks message counts and timing, enabling derived rate limit state
- **Out of scope:**
  - External adapters (Spec 4 — runs in parallel)
  - Pulse/Console migration (Spec 5)
  - Distributed rate limiting
  - Server/client integration for Relay (Spec 2 — this spec assumes Spec 2 provides HTTP endpoints; we add reliability-specific endpoints to that)
  - Retry logic or guaranteed delivery

## 2) Pre-reading Log

- `packages/relay/src/types.ts`: Internal type definitions — `BudgetResult`, `AccessResult`, `EndpointInfo`, `RelayMetrics`. Clean separation of concerns. Result types follow `{ allowed: boolean, reason?: string }` pattern.
- `packages/relay/src/budget-enforcer.ts`: **Key model for rate limiting.** Pure functions, no side effects, fixed-order checks with early-return pattern. ~103 lines. Exactly the template rate limiting should follow.
- `packages/relay/src/sqlite-index.ts`: WAL mode, prepared statements, migration via `PRAGMA user_version`. Indexes on `subject`, `endpoint_hash`, `status`, `ttl`. Already has `sender` and `created_at` columns — rate limit queries can derive from existing data. ~407 lines.
- `packages/relay/src/access-control.ts`: File-backed persistence with chokidar hot-reload. Priority-sorted rule evaluation. ~231 lines. Pattern for config hot-reload.
- `packages/relay/src/relay-core.ts`: Main orchestrator. `deliverToEndpoint()` is the natural injection point for reliability checks (after budget, before Maildir). ~593 lines.
- `packages/relay/src/maildir-store.ts`: Atomic Maildir delivery — `tmp/` → `new/` → `cur/` → `complete/failed`. ~458 lines. Backpressure monitors `new/` directory depth.
- `packages/relay/src/signal-emitter.ts`: In-memory EventEmitter with NATS pattern matching. ~152 lines. Backpressure signals should flow through here.
- `packages/relay/src/dead-letter-queue.ts`: Rejection tracking with sidecar metadata. Model for tracking reliability rejections.
- `packages/relay/src/endpoint-registry.ts`: Deterministic subject-to-hash mapping. Simple in-memory Map + chokidar watch.
- `packages/relay/src/subscription-registry.ts`: Pattern-based pub/sub. Handler errors during dispatch are a circuit breaker failure signal.
- `packages/relay/src/subject-matcher.ts`: NATS wildcard matching — `*` (single) and `>` (multi). ~207 lines.
- `packages/relay/src/index.ts`: Barrel exports. Well-documented public API surface. ~65 lines.
- `packages/relay/package.json`: Dependencies — `better-sqlite3`, `chokidar`, `ulidx`. No external HTTP libraries.
- `meta/modules/relay-litepaper.md`: Phase 2 roadmap — "Rate limiting per sender. Circuit breakers per endpoint pair. Backpressure handling."
- `plans/relay-specs/00-overview.md`: Spec dependency graph. Spec 3 blocked by Spec 2, parallel with Spec 4.
- `plans/relay-specs/01-relay-core-library.md`: Foundation spec — defines types, SQLite schema, Maildir storage, budget enforcement.
- `plans/relay-specs/03-relay-advanced-reliability.md`: This spec's requirements. Verification checklist, design considerations, reference documents.
- `plans/2026-02-24-relay-design.md`: Rate limiting in SQLite index, circuit breakers in access control section.
- `research/20260224_relay_core_library_typescript.md`: Core library research from Spec 1.

## 3) Codebase Map

**Primary components/modules:**

- `packages/relay/src/relay-core.ts` — Main orchestrator. `deliverToEndpoint()` is the integration point for all three reliability features.
- `packages/relay/src/budget-enforcer.ts` — Pure validation functions. **Template** for rate limiter module.
- `packages/relay/src/sqlite-index.ts` — SQLite message index. Will be extended with rate limit and backpressure queries.
- `packages/relay/src/signal-emitter.ts` — Event bus. Backpressure signals flow through here.
- `packages/relay/src/access-control.ts` — File-backed state with chokidar hot-reload. **Template** for config loading.
- `packages/relay/src/dead-letter-queue.ts` — Rejection tracking. Not used for reliability rejections (per decision #3).
- `packages/relay/src/maildir-store.ts` — Atomic delivery. Circuit breaker monitors delivery success/failure here.
- `packages/relay/src/types.ts` — Internal types. Will be extended with reliability result types.

**Shared dependencies:**

- `better-sqlite3` — SQLite database (rate limit queries, backpressure count)
- `chokidar` — File watching (config hot-reload)
- `ulidx` — ID generation (existing, no changes needed)
- `@dorkos/shared` — Zod schemas (will extend with reliability config schemas)

**Data flow (current publish pipeline):**

```
relay.publish(subject, payload, { from, budget })
  → validate subject
  → check access control
  → build envelope with ULID + budget
  → find matching endpoints
  → FOR EACH endpoint:
    → enforceBudget() → reject to DLQ if over budget
    → maildirStore.deliver() → atomic write to new/
    → sqliteIndex.insertMessage()
    → dispatchToSubscribers()
```

**Data flow (enhanced pipeline — with reliability features):**

```
relay.publish(subject, payload, { from, budget })
  → validate subject
  → check access control
  → RATE LIMIT CHECK (once, before fan-out)    ← NEW
  → build envelope with ULID + budget
  → find matching endpoints
  → FOR EACH endpoint:
    → BACKPRESSURE CHECK (per-endpoint)         ← NEW
    → CIRCUIT BREAKER CHECK (per-endpoint)      ← NEW
    → enforceBudget()
    → maildirStore.deliver()
    → CIRCUIT BREAKER: record success           ← NEW
    → sqliteIndex.insertMessage()
    → dispatchToSubscribers()
      → on handler error: CIRCUIT BREAKER: record failure  ← NEW
```

**Feature flags/config:** All reliability features controlled via `RelayOptions.reliability` config object. Each feature has an `enabled` boolean defaulting to sensible behavior.

**Potential blast radius:**

- Direct: 3 new modules + 3 modified modules in `packages/relay/src/`
- Shared: Schema extensions in `@dorkos/shared`
- Server: New HTTP endpoints for reliability status (builds on Spec 2 routes)
- Client: Relay panel UI additions (builds on Spec 2 panel)
- Tests: 3 new test files + expanded integration tests

## 4) Root Cause Analysis

N/A — this is a feature addition, not a bug fix.

## 5) Research

### Potential Solutions

**1. Sliding Window Log for Rate Limiting (Recommended)**

- Description: Derive rate limit state from the existing `messages` SQLite table. A single prepared statement counts messages from a sender within the configured time window. No auxiliary tables needed.
- Pros:
  - Zero additional state — derived from source of truth
  - Automatically recovers after restart (data is on disk)
  - Single SQL query: `SELECT COUNT(*) FROM messages WHERE sender = ? AND created_at > ?`
  - ~15 lines of TypeScript
- Cons:
  - Index scan touches more rows for high-frequency senders (negligible for local system)
  - Requires new composite index `(sender, created_at)` in SQLite migration
- Complexity: Low
- Maintenance: Low

**2. Token Bucket for Rate Limiting**

- Description: Per-sender bucket with configurable capacity and refill rate. Requires an auxiliary table to track `currentTokens` and `lastRefillTs` per sender.
- Pros:
  - Excellent burst handling (bucket capacity = max burst)
  - Industry standard for API rate limiting
- Cons:
  - Requires separate `rate_limit_state` table in SQLite
  - More complex math (token refill calculation)
  - State doesn't naturally derive from existing message data
  - ~40 lines vs ~15 for sliding window
- Complexity: Medium
- Maintenance: Medium

**3. In-Memory Three-State Circuit Breaker (Recommended)**

- Description: `Map<string, CircuitBreakerState>` keyed by endpoint hash. CLOSED → OPEN after N consecutive delivery failures. Auto-transitions to HALF_OPEN after cooldown. Single probe in HALF_OPEN; success → CLOSED, failure → OPEN.
- Pros:
  - Zero disk I/O for state transitions
  - ~80 lines of TypeScript
  - Clean restart behavior (all breakers reset to CLOSED)
  - Maps directly to the relay's delivery pipeline
- Cons:
  - State lost on restart (acceptable — research confirms this is desirable for local systems)
- Complexity: Low
- Maintenance: Low

**4. Reactive Load-Shedding for Backpressure (Recommended)**

- Description: Before each per-endpoint delivery, query SQLite for count of `status = 'new'` messages for that endpoint. If count >= `maxMailboxSize`, reject with structured `PublishResult`. Also return `mailboxPressure` (0-1 ratio) for proactive signaling.
- Pros:
  - One SQL query per endpoint delivery (sub-millisecond)
  - Aligns with at-most-once semantics (reject, don't buffer)
  - Proactive pressure metric lets cooperative agents throttle voluntarily
- Cons:
  - Adds one query per endpoint per publish (negligible latency)
- Complexity: Low
- Maintenance: Low

### Build vs Buy Analysis

All three features should be built from scratch:

- **Rate limiting**: `rate-limiter-flexible` uses fixed windows (wrong algorithm), adds transitive deps, designed for web APIs. `limiter`/`bottleneck` are in-memory only. Our implementation is ~15 lines of TS + 1 prepared SQL statement.
- **Circuit breakers**: `cockatiel` (zero deps, TypeScript-first) is the strongest library candidate, but its `execute(fn)` wrapper pattern doesn't fit the relay's pipeline model. `opossum` is heavier with peer deps. Our implementation is ~80 lines.
- **Backpressure**: No standard library handles message-queue backpressure. It's a domain-specific count check. ~20 lines of TS.

### Recommendation

Build all three from scratch. Combined implementation is ~120 lines of core logic plus types, config, and integration. Zero new dependencies added to `package.json`. Tight integration with existing SQLite index and Maildir pipeline.

### Sensible Defaults for Local Agent Systems

| Feature         | Parameter            | Default | Rationale                                                   |
| --------------- | -------------------- | ------- | ----------------------------------------------------------- |
| Rate Limit      | `windowSecs`         | 60      | One-minute sliding window                                   |
| Rate Limit      | `maxPerWindow`       | 100     | ~1.67 msg/sec sustained; handles normal agent communication |
| Rate Limit      | `perSenderOverrides` | `{}`    | High-frequency agents can be explicitly allowlisted         |
| Circuit Breaker | `failureThreshold`   | 5       | Five consecutive delivery failures                          |
| Circuit Breaker | `cooldownMs`         | 30,000  | 30 seconds before half-open probe                           |
| Circuit Breaker | `halfOpenProbeCount` | 1       | Single probe in half-open                                   |
| Circuit Breaker | `successToClose`     | 2       | Two consecutive successes to close                          |
| Backpressure    | `maxMailboxSize`     | 1,000   | 1,000 unprocessed messages = stalled agent                  |
| Backpressure    | `pressureWarningAt`  | 0.8     | Signal at 80% capacity                                      |

## 6) Decisions

| #   | Decision                          | Choice                                        | Rationale                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Circuit breaker scope             | Per-endpoint (not per-sender-endpoint pair)   | Research shows failure modes are endpoint health issues (broken handler, full disk), not sender-specific. Per-endpoint is simpler (one Map entry per registered endpoint), gives a coherent recovery story, and avoids confusion from multiple breakers opening at different times for the same broken endpoint. |
| 2   | Circuit breaker state persistence | In-memory only, reset on restart              | Single-process local system has no multi-instance synchronization needs. Restart resets all breakers to CLOSED, giving endpoints a fresh chance. If still broken, deliveries quickly re-open the breaker. Avoids SQLite write overhead on every state transition.                                                |
| 3   | Backpressure rejection handling   | Structured `PublishResult` rejection (no DLQ) | Backpressure rejection is a pre-delivery policy decision, not a delivery failure. DLQ is for actual delivery attempts that failed. Returning a `rejected` array in `PublishResult` with reason `'backpressure'` keeps the DLQ clean. Same treatment for `'circuit_open'` and `'rate_limited'` rejections.        |
| 4   | Rate limiting scope in fan-out    | Once at publish-time (before fan-out)         | Rate limiting is a per-sender policy. A message fanning out to 5 endpoints counts as 1 message against the sender's limit. Simpler and more predictable for agent developers. Prevents the same publish from consuming 5x the rate limit quota.                                                                  |
