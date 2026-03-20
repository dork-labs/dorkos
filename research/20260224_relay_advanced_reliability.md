---
title: 'Relay Advanced Reliability — Research Report'
date: 2026-02-24
type: internal-architecture
status: active
tags: [relay, reliability, rate-limiting, circuit-breaker, sliding-window, dead-letter]
feature_slug: relay-advanced-reliability
---

# Relay Advanced Reliability — Research Report

**Date**: 2026-02-24
**Feature**: relay-advanced-reliability
**Scope**: Rate limiting, circuit breakers, and backpressure for @dorkos/relay
**Research Depth**: Deep

---

## Research Summary

This report covers all three reliability primitives needed for the `@dorkos/relay` package: rate limiting
(per-sender), circuit breakers (per-endpoint-pair), and backpressure handling. Each section covers
algorithm comparisons, design decisions specific to a local single-machine agent messaging system, SQLite
integration strategies, and a build-vs-buy analysis. Concrete recommendations and sensible defaults are
given for each feature.

The primary conclusion: **build all three from scratch**. Each is a well-understood algorithm, the
implementations are 50–150 lines, dependency minimization is a hard constraint for a library package,
and the SQLite integration requirements don't fit off-the-shelf libraries cleanly.

---

## Key Findings

1. **Rate Limiting**: Sliding window counter is the recommended algorithm — it balances burst tolerance,
   low memory overhead, and clean SQLite derivation from the existing `messages` table, avoiding a
   separate state table.

2. **Circuit Breakers**: A simple in-memory three-state machine (closed → open → half-open) scoped
   per-endpoint (not per-sender-endpoint pair) is the right fit. Persistence to SQLite is unnecessary
   for a local system where restart recovery is fast.

3. **Backpressure**: Reactive load-shedding (count unprocessed messages in `new/` and reject when over
   threshold) aligns naturally with at-most-once delivery semantics. Proactive capacity reporting is a
   useful addition but secondary.

4. **Configuration**: A single `ReliabilityConfig` object with sensible defaults, injectable into
   `RelayCore`. Config hot-reload is achievable via `chokidar` (already a dependency) watching a JSON
   file.

5. **Build vs Buy**: Build all three. Libraries (rate-limiter-flexible, opossum, cockatiel) all add
   transitive dependencies, assume network/async contexts, and don't model at-most-once messaging
   semantics.

---

## Detailed Analysis

### 1. Rate Limiting Algorithms

#### How Each Algorithm Works

**Fixed Window Counter**

Time is divided into discrete windows (e.g., 60-second buckets). Each sender gets a counter per window.
When a request arrives, increment the counter; if it exceeds the limit, reject.

- Memory: O(1) per sender per window — just a count and a reset timestamp
- Burst handling: Poor. A sender can consume the full window quota in the last second of one window and
  the full quota again in the first second of the next — effectively 2x the intended rate at boundaries
- SQLite fit: An `INSERT OR REPLACE` with a trigger to reset on window expiry. The
  `summarity.com/sqlite-rate-limit` approach uses this pattern exactly with `resets_at` timestamps
- Implementation: ~25 lines of SQL, ~10 lines of TS

**Token Bucket**

A per-sender "bucket" holds a finite number of tokens. Tokens refill at a steady rate up to the bucket
capacity. Each message consumes one token. If no tokens remain, reject.

- Memory: O(1) per sender — store `tokens` (float) and `lastRefillTs` (integer)
- Burst handling: Excellent. Bucket capacity is the maximum burst size; refill rate governs sustained
  throughput. Agents sending flurries of messages will drain the bucket, then be throttled
- SQLite fit: Can be derived from message timestamps using
  `MIN(capacity, tokens_at_last_check + elapsed_seconds * refill_rate)`. Requires an auxiliary table
  per sender for `lastRefillTs` and `currentTokens`, since SQLite timestamps in the `messages` table
  cannot reconstruct bucket state without the prior token count
- Implementation: ~40 lines

**Sliding Window Log**

For each sender, store the timestamp of every message within the current window. On each send, prune
timestamps older than the window, then count remaining entries. If count >= limit, reject.

- Memory: O(messages_per_window) per sender — stores individual timestamps
- Burst handling: Perfect accuracy — the window always represents exactly the last N seconds
- SQLite fit: **This is the best fit for deriving rate limit state from the existing `messages` table
  without a separate state table.** The query is simply:
  `SELECT COUNT(*) FROM messages WHERE sender = ? AND created_at > datetime('now', '-60 seconds')`
  The `messages` table already has `sender` and `created_at` columns with an index on `subject` and
  `created_at`. Adding an index on `(sender, created_at)` makes this query sub-millisecond.
- Implementation: One SQL query + one prepared statement. ~15 lines of TS
- Downside: For high-frequency senders, the index scan touches more rows. For a local system with
  dozens of agents, this is completely negligible

**Sliding Window Counter (Hybrid)**

Maintains counts for the current and previous fixed windows. Applies a weighted formula to approximate
the sliding window:
`effective_count = (prev_window_count * overlap_fraction) + current_window_count`

Where `overlap_fraction = (window_duration - elapsed_time_in_current_window) / window_duration`.

- Memory: O(1) per sender — two counts and a window boundary timestamp
- Burst handling: Better than fixed window but still an approximation of true sliding behavior
- SQLite fit: Requires an auxiliary table (`rate_limit_state`) with `prev_count`, `curr_count`, and
  `window_start`. Cannot be derived from message timestamps alone
- Implementation: ~50 lines

#### Recommendation: Sliding Window Log Derived From SQLite

For the relay's specific context, **sliding window log** is the right choice because:

1. The `messages` table already exists with `sender` and `created_at` columns. Rate limiting state is
   derivable from the source of truth with zero auxiliary tables
2. A local system with dozens of agents sends nowhere near the volume where row-count scanning becomes
   a concern (not millions of records per window)
3. Adding a composite index `(sender, created_at)` to the SQLite migration makes the rate check a
   single fast query
4. The implementation is a single prepared statement — about 15 lines of TypeScript
5. After a relay restart, the rate limit state is automatically recovered from disk with no in-memory
   warmup needed

The one-query implementation:

```sql
-- Migration addition
CREATE INDEX IF NOT EXISTS idx_messages_sender_created
  ON messages(sender, created_at DESC);

-- Rate check query (prepared statement)
SELECT COUNT(*) as cnt
  FROM messages
 WHERE sender = @sender
   AND created_at > datetime('now', @windowSeconds || ' seconds', 'utc')
```

The TypeScript wrapper caches the prepared statement and compares `cnt >= limit`.

**Sensible defaults for local agent systems:**

| Parameter       | Default        | Rationale                                                |
| --------------- | -------------- | -------------------------------------------------------- |
| `windowSecs`    | 60             | One-minute sliding window                                |
| `maxPerWindow`  | 100            | 100 messages/min per sender (~1.67/sec sustained)        |
| `burstCapacity` | N/A (no burst) | Sliding window log naturally handles burst vs. sustained |
| Per-sender      | Yes (required) | Prevents one misbehaving agent from flooding others      |

A monitoring agent legitimately generating ~10 telemetry messages per second would hit 600 messages/min
and needs a higher per-sender override. The config should support per-sender overrides keyed by subject
prefix.

---

### 2. Circuit Breaker Patterns

#### Three-State Machine

The standard pattern has three states:

```
CLOSED → (failure threshold met) → OPEN → (cooldown elapsed) → HALF_OPEN → (probe success) → CLOSED
                                    ↑                                      → (probe failure) → OPEN
```

- **CLOSED**: Normal operation. All messages pass. Failures are counted.
- **OPEN**: Delivery is blocked immediately (fail-fast). No Maildir writes attempted. The breaker opens
  after `failureThreshold` consecutive delivery failures within `failureWindowMs`.
- **HALF_OPEN**: A single probe message is allowed through. If it succeeds, the circuit closes. If it
  fails, the circuit reopens and the cooldown resets.

#### What "Failure" Means in the Relay Context

Failure types to count toward the circuit breaker:

1. **Maildir write failure** — `maildirStore.deliver()` returns `{ ok: false }`. The filesystem may be
   full, the endpoint directory may have been deleted, or there is a permissions error.
2. **Handler throw** — A subscription handler throws during `dispatchToSubscribers()`, causing the
   message to be moved to `failed/`. Repeated handler failures indicate the receiving agent is broken.
3. **Repeated DLQ rejection** — If an endpoint consistently receives messages that end up in
   `failed/`, the circuit breaker should respond.

Importantly, **budget enforcement failures** (hop count, TTL expiry) are not circuit breaker failures
— they are content-level rejections, not endpoint health indicators.

#### Granularity: Per-Endpoint vs. Per-Sender-Endpoint Pair

**Per-endpoint granularity** is recommended over per-sender-endpoint pair for the relay's local context.

Reasons:

- The failure modes being detected are endpoint health issues (broken handler, full filesystem), not
  sender-specific relationship problems. If endpoint `relay.agent.backend` fails, it fails for all
  senders, not just one
- Per-endpoint state is simpler: one Map entry per registered endpoint vs. a Map of Maps
- Per-sender-endpoint pairs would result in many breaker instances opening at different times for the
  same broken endpoint, giving a confusing recovery story
- The one scenario where per-pair matters (sender A's messages consistently fail at endpoint B while
  sender C's succeed) is better handled by access control rules, not the circuit breaker

The circuit breaker map key is the endpoint's `hash` (already the canonical identifier for endpoints
in the system).

#### State Persistence: In-Memory Only

**In-memory state is correct for a local system.** The reasons to persist circuit breaker state to
SQLite (multi-instance synchronization, serverless cold starts) do not apply here:

- There is a single relay process on a single machine
- A restart resets all breakers to CLOSED, which is desirable behavior — it gives each endpoint a
  fresh chance. The delivery failure will quickly re-open the breaker if the endpoint is still broken
- SQLite writes for every state transition (open/close/half-open) add latency and complexity for no
  benefit in the single-process case

In-memory implementation: a `Map<string, CircuitBreakerState>` where the key is `endpointHash`.

**Sensible defaults:**

| Parameter            | Default | Rationale                                                   |
| -------------------- | ------- | ----------------------------------------------------------- |
| `failureThreshold`   | 5       | Five consecutive delivery failures                          |
| `failureWindowMs`    | 30_000  | Within a 30-second window (consecutive failures is simpler) |
| `cooldownMs`         | 30_000  | 30 seconds before half-open probe                           |
| `halfOpenProbeCount` | 1       | Single probe in half-open state                             |
| `successToClose`     | 2       | Two consecutive successes to close from half-open           |

These align with industry consensus (5 failures, 30-second cooldown) documented across Resilience4J,
.NET Polly, and opossum default configurations.

#### State Type

```typescript
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerState {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null; // timestamp when OPEN state was entered
  halfOpenProbes: number; // successful probes in HALF_OPEN
}
```

The full implementation is approximately 80–100 lines.

---

### 3. Backpressure Handling

#### What Backpressure Means for the Relay

Backpressure in the relay context is the condition where an endpoint's `new/` directory contains
more unprocessed messages than it can reasonably handle. The consumer (agent) is slower than the
producers writing to its mailbox.

Unlike stream-based systems, there is no bidirectional channel to signal "please stop sending" to
upstream producers. The relay's response is **load shedding**: reject incoming messages with an
explicit error when the endpoint is over capacity.

#### Detection: Mailbox Count vs. Disk Usage

Two candidate metrics for backpressure detection:

**Option A: Message count in `new/`**

Count the number of files in an endpoint's `new/` directory. When `count >= maxMailboxSize`, reject.

- Pros: Directly represents unprocessed message backlog; easy to query (either from SQLite or via
  `fs.readdir`)
- Cons: Requires counting files or a SQLite query before each delivery
- SQLite query: `SELECT COUNT(*) FROM messages WHERE endpoint_hash = @hash AND status = 'new'`
  This can reuse the existing index on `(endpoint_hash, created_at DESC)` and `status`.
- Recommended: Query SQLite, not the filesystem, to avoid `readdir` latency

**Option B: Disk usage of the endpoint's Maildir**

- Pros: Guards against pathologically large message payloads filling disk
- Cons: Requires `du` or `statfs` syscalls, much slower to compute; payload size limits are better
  enforced separately at publish time

**Recommendation: Option A (count in SQLite).** The `messages` table already has the data. Disk
usage limits should be a separate concern (max payload size check at publish time, not backpressure).

#### Reactive vs. Proactive Signaling

**Reactive (load-shedding)**: When a message would push an endpoint over the `maxMailboxSize` limit,
the `publish()` call returns an error or a structured result indicating the message was rejected for
backpressure reasons (not DLQ'd, just dropped).

**Proactive (capacity reporting)**: Before delivery, check the mailbox level and return a `pressure`
metric in the `PublishResult`. Callers can throttle themselves based on this signal.

Both approaches should be implemented:

- Reactive: Hard reject at `>= maxMailboxSize` (required for protection)
- Proactive: Return `mailboxPressure: number` (0–1 ratio) in `PublishResult` so callers can
  adapt their send rate voluntarily (useful for cooperative agents)

#### Interaction With At-Most-Once Delivery

The relay's design is at-most-once: messages are delivered or they aren't. There is no retry or
buffer. This aligns perfectly with reactive load-shedding:

- A message rejected for backpressure is **not** sent to the DLQ (the DLQ is for delivery failures,
  not capacity rejections)
- The publisher receives a clear rejection code in the `PublishResult` or via a thrown error
- No retry logic — at-most-once means the publisher is responsible for deciding whether to retry
  at the application layer

A suitable return type extension:

```typescript
export interface PublishResult {
  messageId: string;
  deliveredTo: number;
  rejected?: Array<{
    subject: string;
    reason: 'backpressure' | 'circuit_open' | 'rate_limited';
  }>;
  mailboxPressure?: Record<string, number>; // endpointHash → 0–1 ratio
}
```

**Sensible defaults:**

| Parameter           | Default | Rationale                                          |
| ------------------- | ------- | -------------------------------------------------- |
| `maxMailboxSize`    | 1000    | 1,000 unprocessed messages signals a stalled agent |
| `pressureWarningAt` | 0.8     | Report pressure signal when mailbox is 80% full    |
| `enabled`           | true    | Default on; agents can opt out per-endpoint        |

For a local system with reasonably small messages (JSON payloads), 1,000 messages in `new/` is a
clear signal of a stuck or crashed agent. Active agents should process messages in milliseconds.

---

### 4. Configuration Patterns

#### Single Configuration Object

All three reliability features should be configured through a single `ReliabilityConfig` interface
injected into `RelayOptions`:

```typescript
interface RateLimitConfig {
  enabled: boolean;
  windowSecs: number; // default: 60
  maxPerWindow: number; // default: 100
  perSenderOverrides?: Record<string, number>; // subject prefix → limit override
}

interface CircuitBreakerConfig {
  enabled: boolean;
  failureThreshold: number; // default: 5
  cooldownMs: number; // default: 30_000
  halfOpenProbeCount: number; // default: 1
  successToClose: number; // default: 2
}

interface BackpressureConfig {
  enabled: boolean;
  maxMailboxSize: number; // default: 1000
  pressureWarningAt: number; // default: 0.8 (80%)
}

interface ReliabilityConfig {
  rateLimit?: RateLimitConfig;
  circuitBreaker?: CircuitBreakerConfig;
  backpressure?: BackpressureConfig;
}
```

The config extends the existing `RelayOptions`:

```typescript
interface RelayOptions {
  dataDir?: string;
  maxHops?: number;
  defaultTtlMs?: number;
  defaultCallBudget?: number;
  reliability?: ReliabilityConfig; // new
}
```

#### Hot-Reload

Config hot-reload is achievable without a restart using `chokidar`, which is already a dependency
in the relay package (`package.json` shows `"chokidar": "^4.0.0"`).

Pattern:

1. Accept a `configPath?: string` in `RelayOptions` pointing to a JSON file with `ReliabilityConfig`
2. On startup, load and validate the JSON config
3. Watch the file with chokidar; on `change`, reload and validate; swap the internal config reference
   atomically (a single `this.config = newConfig` assignment is safe in Node.js's single-threaded event
   loop)

Validation should use a small Zod schema to reject malformed config files (wrong types, negative
values). Invalid files should be ignored with a warning log, keeping the previous valid config.

The in-flight rate limit and circuit breaker state are unaffected by config hot-reload — only the
thresholds change. This means:

- A rate limit threshold lowered mid-operation takes effect on the next check
- A circuit breaker cooldown change takes effect on the next state transition
- No state needs to be flushed or reset

---

### 5. Build vs. Buy Analysis

#### Rate Limiting Libraries

**rate-limiter-flexible**

- Weekly downloads: ~2M
- SQLite support: Yes, via `better-sqlite3` or `knex` adapter
- Algorithm: Fixed window only (its own documentation states "uses a fixed window, as it is much
  faster than a rolling window")
- Verdict: **Do not use.** Adds a transitive dependency, implements the wrong algorithm for this use
  case (we want sliding window log derived from the existing messages table), and is designed for
  high-throughput web APIs, not local agent messaging

**bottleneck**

- Designed for rate-limiting outbound requests (throttling a client, not protecting a server)
- No SQLite backend
- Verdict: **Wrong use case.** Not applicable.

**limiter**

- Simple token bucket for Node.js
- In-memory only, no persistence
- Verdict: **Build is simpler.** The SQLite-derived sliding window log is ~15 lines of TypeScript and
  zero transitive dependencies.

**Recommendation: Build.** The implementation is a single prepared SQL statement and a TypeScript
wrapper class of ~40 lines. Adding the `(sender, created_at)` index to the existing migration
handles the SQLite side.

#### Circuit Breaker Libraries

**cockatiel**

- Weekly downloads: ~1.1M
- Zero dependencies
- MIT license
- Supports `ConsecutiveBreaker` (opens after N consecutive failures) and `SamplingBreaker` (opens
  based on failure rate across a sampling window)
- Also provides retry, timeout, bulkhead, and fallback policies
- TypeScript-first with excellent type signatures

`cockatiel` is the strongest candidate if using a library. It has no dependencies, is TypeScript-first,
and has a clean API.

However, it is designed around wrapping async function calls (network requests, database queries) and
its `execute(fn)` model adds a layer of indirection that doesn't fit the relay's pipeline model cleanly.
The relay pipeline checks conditions before writing to Maildir; it doesn't wrap a function call.

A bespoke implementation directly models the relay's delivery pipeline:

```typescript
class CircuitBreaker {
  isOpen(endpointHash: string): boolean { ... }
  recordSuccess(endpointHash: string): void { ... }
  recordFailure(endpointHash: string): void { ... }
}
```

This is ~80 lines and integrates directly into `deliverToEndpoint()` with two guard clauses.

**opossum**

- Weekly downloads: ~540K
- Has peer dependencies, larger API surface
- Wraps async function calls — same mismatch with relay's pipeline model
- Verdict: **opossum** adds more weight than cockatiel for the same mismatch

**Recommendation: Build.** The bespoke implementation is ~80 lines. `cockatiel` is genuinely good
and could be used as a reference implementation, but the `execute(fn)` wrapper pattern is an API
mismatch. Zero new dependencies is preferable for a library package.

#### Backpressure Libraries

No standard library handles this use case. Backpressure in the relay is a domain-specific count
check against SQLite + a result field in `PublishResult`. Node.js stream backpressure (the `drain`
event, `highWaterMark`) operates on byte streams, not message queues.

**Recommendation: Build.** One prepared SQL statement + a result shape extension. ~20 lines of TS.

---

### 6. Integration with Existing Pipeline

The existing `deliverToEndpoint()` method is the single point where all three features should be
applied. The current pipeline:

```
1. Budget enforcement (enforceBudget)
2. Maildir deliver
3. SQLite index
4. Dispatch to subscribers
```

The enhanced pipeline:

```
1. Backpressure check           ← NEW (query SQLite count for endpoint)
2. Rate limit check             ← NEW (query SQLite count for sender)
3. Circuit breaker check        ← NEW (in-memory state check)
4. Budget enforcement           (existing)
5. Maildir deliver
6. Circuit breaker success      ← NEW (record success)
7. SQLite index
8. Dispatch to subscribers
   └── on handler error → Circuit breaker failure ← NEW
```

Steps 1–3 are reads only, adding negligible latency. The circuit breaker state mutation (steps 6 and
the error path) is an in-memory Map update, also negligible.

The backpressure check uses the same SQLite database connection (prepared statement) and the existing
`endpoint_hash + status` index. The rate limit check uses the existing `sender + created_at` column
pair with a new index.

Both checks run before Maildir delivery — if either rejects, no filesystem write occurs and no circuit
breaker failure is recorded (these are filter-layer rejections, not endpoint failures).

---

### 7. Security and Performance Considerations

#### Security

- **Rate limiting prevents message flooding**: A misbehaving or compromised agent cannot flood
  another agent's mailbox by sending messages faster than the window limit allows
- **Backpressure prevents disk exhaustion**: A slow or crashed agent cannot cause unbounded growth
  of its `new/` directory, which could fill the disk and affect the entire system
- **Circuit breaker prevents cascading filesystem failures**: If a specific endpoint's Maildir
  directory is corrupted or has permission errors, the circuit breaker prevents repeated failed
  write attempts that could degrade the SQLite index or exhaust file handles
- **No denial-of-service vector from config**: Rate limits and backpressure limits should not be
  configurable by individual agents at publish time; they must be a relay-level policy

#### Performance

- **SQLite query cost**: The sliding window log query is an index-range scan on `(sender, created_at)`.
  With dozens of agents and a 60-second window, this is typically scanning 10–200 rows, completing
  in under 1ms on modern hardware. better-sqlite3's synchronous API means zero event-loop contention.
- **Backpressure count query**: `COUNT(*) WHERE endpoint_hash = ? AND status = 'new'` hits the
  existing `(endpoint_hash, created_at)` index. Also sub-millisecond.
- **Circuit breaker overhead**: In-memory Map lookup. Zero latency.
- **No auxiliary tables needed**: All rate limit and backpressure data is derived from the existing
  `messages` table. Schema stays minimal.
- **Prepared statement caching**: All new queries should be pre-prepared in the `SqliteIndex`
  constructor alongside the existing statements, following the established pattern in `sqlite-index.ts`.

#### Edge Cases

- **Relay restart recovery**: Rate limit and backpressure state recover automatically from the
  persistent `messages` table. Circuit breaker state resets to CLOSED (correct and intentional).
- **TTL expiry and rate limits**: Expired messages should be excluded from the rate limit window
  count. The `deleteExpired()` method prunes old records; calling it periodically (e.g., on a timer
  or on each publish) prevents the rate limit query from scanning stale rows.
- **Fan-out and rate limits**: When a message fans out to multiple endpoints, the rate limit check
  should run once per `publish()` call, not once per endpoint delivery. Rate limiting is a per-sender
  policy enforced at publish time.
- **Fan-out and backpressure**: Backpressure should be checked per-endpoint during fan-out. One
  overloaded endpoint should not block delivery to healthy endpoints. The `PublishResult.rejected`
  array should list which endpoints were skipped and why.
- **Circuit breaker and DLQ**: A message rejected because a circuit is open should NOT go to the DLQ.
  The DLQ is for delivery attempts that failed after reaching the endpoint. Circuit open is a
  pre-delivery policy decision. Return it as a `rejected` entry in `PublishResult`.

---

## Contradictions and Disputes

- **Sliding window log memory concern**: Most articles cite memory consumption as the main downside
  of sliding window log (storing one timestamp per request). In the relay's case, this concern is
  irrelevant because timestamps live in the SQLite `messages` table on disk, not in process memory.
  The "memory" concern for the relay is actually a disk concern, which TTL-based pruning already handles.

- **Circuit breaker per-pair arguments**: Some sources argue that per-sender-endpoint pair granularity
  provides better fault isolation. For distributed microservices where sender A and sender B call
  endpoint C independently, this can be valid. For a local agent bus where endpoint health is a
  single-machine concern, it adds complexity without benefit.

- **Proactive vs. reactive backpressure**: Some reactive systems frameworks advocate purely proactive
  (pull-based) backpressure where producers only send when consumers signal readiness. This requires
  bidirectional coordination. The relay's at-most-once, fire-and-forget model is incompatible with
  pure pull-based backpressure. The hybrid (reactive load-shedding + proactive pressure metric) is
  the appropriate compromise.

---

## Research Gaps and Limitations

- **Benchmark data for SQLite sliding window log**: No specific benchmarks for this exact query
  pattern at the volumes expected in a local agent system. The sub-millisecond estimate is based on
  general better-sqlite3 performance characteristics and the index design, not measured data. A
  micro-benchmark during implementation is recommended.

- **Optimal `maxMailboxSize` for specific agent workloads**: The 1,000 message default is a
  reasonable starting point but may need tuning based on observed agent behavior. Agents that batch
  process (reading many messages at once) will have different backpressure signatures than agents
  that process one message at a time.

- **Config hot-reload atomicity**: The analysis assumes Node.js single-threaded event loop makes
  a reference swap atomic. This holds for synchronous operations but `better-sqlite3` prepared
  statements cached in the `SqliteIndex` class would need to be re-prepared if config changes alter
  the SQL query structure (which sliding window log queries would, if the window size is embedded
  as a parameter). Using parameterized queries (window size as a bind parameter, not embedded SQL)
  avoids this problem entirely.

---

## Search Methodology

- Searches performed: 12
- Most productive search terms:
  - "token bucket vs sliding window rate limiting algorithm comparison"
  - "cockatiel typescript circuit breaker library API 2025"
  - "backpressure handling Node.js messaging systems mailbox size"
  - "circuit breaker failure thresholds defaults 5 failures 30 seconds"
  - "at-most-once delivery backpressure reject no buffer no retry"
  - "rate-limiter-flexible npm SQLite backend comparison"
- Primary information sources: GitHub repositories (cockatiel, opossum, rate-limiter-flexible),
  architecture blogs (Martin Fowler, Microsoft Azure docs), algorithm deep-dives (algomaster.io,
  arpit bhayani), Clear Measure backpressure article

---

## Sources and Evidence

- "Tokens are added to the bucket at a fixed rate. When a request arrives, it must obtain a token from
  the bucket to proceed." — [Rate Limiting Algorithms Explained with Code](https://blog.algomaster.io/p/rate-limiting-algorithms-explained-with-code)
- Sliding window counter formula: `weight = (100 - overlap_percentage)% × previousWindowRequests + currentWindowRequests` — [algomaster.io](https://blog.algomaster.io/p/rate-limiting-algorithms-explained-with-code)
- "rate-limiter-flexible uses a fixed window, as it is much faster than a rolling window." — [GitHub Wiki SQLite](https://github.com/animir/node-rate-limiter-flexible/wiki/SQLite)
- Cockatiel: "no dependencies" with 1,112,665 weekly downloads and 1,748 GitHub stars — [npm trends](https://npmtrends.com/brakes-vs-circuit-breaker-js-vs-circuitbreaker-vs-cockatiel-vs-levee-vs-opossum)
- Circuit breaker defaults: "failure threshold of 5, a recovery timeout of 30 seconds, and allowing 3 test requests in the half-open state" — [groundcover.com](https://www.groundcover.com/learn/performance/circuit-breaker-pattern)
- "have a limit on your queues and drop messages that are added over the limit" — [Clear Measure backpressure](https://clearmeasure.com/backpressure-in-message-based-systems/)
- "At-most-once delivery is the simplest and fastest approach where the producer sends a message and immediately moves on — no waiting for acknowledgments, no retry logic" — [oneuptime.com](https://oneuptime.com/blog/post/2026-01-30-at-most-once-delivery/view)
- Opossum circuit breaker: ~538K weekly downloads, wraps async functions — [GitHub nodeshift/opossum](https://github.com/nodeshift/opossum)
- Three-state circuit breaker: `type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN'` — [DEV Community](https://dev.to/wallacefreitas/circuit-breaker-pattern-in-nodejs-and-typescript-enhancing-resilience-and-stability-bfi)
- "backpressure mechanism where, when the cache starts to fill up, the agents slow the rate of dequeuing events" — [Microsoft Orleans docs](https://learn.microsoft.com/en-us/dotnet/orleans/implementation/streams-implementation/)
- "Circuit breaker policies can be defined per HTTP route, allowing fine-grained control" — [linkerd2 issue](https://github.com/linkerd/linkerd2/issues/13406)
- SQLite sliding window via triggers and `resets_at`: [GitHub animir/node-rate-limiter-flexible/wiki/SQLite](https://github.com/animir/node-rate-limiter-flexible/wiki/SQLite)
