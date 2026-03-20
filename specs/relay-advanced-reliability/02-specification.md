---
slug: relay-advanced-reliability
number: 52
created: 2026-02-24
status: specified
---

# Specification: Relay Advanced Reliability

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-02-24
**Ideation:** [01-ideation.md](./01-ideation.md)
**Relay Spec Plan:** [03-relay-advanced-reliability.md](../../plans/relay-specs/03-relay-advanced-reliability.md)

---

## Overview

Add three reliability features to the `@dorkos/relay` package: **rate limiting** (per-sender, sliding window log), **circuit breakers** (per-endpoint, in-memory three-state), and **backpressure handling** (reactive load-shedding with proactive pressure metric). These features harden the existing Relay core transport for production use where agents may generate high message volumes or encounter endpoint failures.

All three features integrate into the existing `deliverToEndpoint()` pipeline in `relay-core.ts`, follow the pure-function pattern established by `budget-enforcer.ts`, and require zero new npm dependencies. Reliability rejections are reported via a structured `PublishResult.rejected` array — they do not go to the dead letter queue.

## Background / Problem Statement

The Relay core library (spec #50) provides a working message transport with Maildir storage, SQLite indexing, budget enforcement, and access control. However, it lacks protection against three production failure modes:

1. **Message flooding:** A misbehaving or compromised agent can send messages at an unbounded rate, overwhelming recipients.
2. **Endpoint failures:** If an endpoint's Maildir directory becomes corrupted, full, or the subscription handler consistently throws, every delivery attempt fails and wastes resources.
3. **Slow consumers:** An agent that processes messages slowly (or crashes) accumulates unbounded messages in its `new/` directory, potentially filling disk.

The Relay litepaper Phase 2 roadmap explicitly calls for "Rate limiting per sender. Circuit breakers per endpoint pair. Backpressure handling."

## Goals

- Implement per-sender rate limiting with configurable limits and a sliding window log algorithm
- Implement per-endpoint circuit breakers with standard three-state machine (CLOSED → OPEN → HALF_OPEN)
- Implement backpressure detection and load-shedding based on endpoint mailbox depth
- Report all reliability rejections via structured `PublishResult` (not DLQ)
- Provide a `mailboxPressure` metric in `PublishResult` for proactive signaling
- Make all features configurable with sensible defaults that work out of the box
- Preserve the at-most-once delivery guarantee — reject, never retry
- Add zero new npm dependencies

## Non-Goals

- Server HTTP endpoints for reliability status (Spec 2: server/client integration scope)
- Client UI for reliability display (Spec 2 scope)
- External adapters (Spec 4)
- Distributed rate limiting (DorkOS is single-machine)
- Retry logic or guaranteed delivery
- Per-sender-endpoint pair circuit breakers (per-endpoint is sufficient for local systems)
- Circuit breaker state persistence across restarts (in-memory reset is desirable)

## Technical Dependencies

- `better-sqlite3` ^11.0.0 — existing dependency, used for rate limit and backpressure queries
- `chokidar` ^4.0.0 — existing dependency, used for config hot-reload
- `@dorkos/shared` — existing dependency, Zod schemas for config validation
- No new npm dependencies

## Detailed Design

### 1. Type Extensions

Add new result types and config interfaces to `packages/relay/src/types.ts`, following the existing `BudgetResult` and `AccessResult` pattern:

```typescript
// --- Rate Limiting ---

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  /** Current message count in the window (for diagnostics). */
  currentCount?: number;
  /** The configured limit that was checked against. */
  limit?: number;
}

export interface RateLimitConfig {
  enabled: boolean;
  /** Sliding window duration in seconds. Default: 60 */
  windowSecs: number;
  /** Maximum messages per sender per window. Default: 100 */
  maxPerWindow: number;
  /** Subject prefix → limit override for specific senders. */
  perSenderOverrides?: Record<string, number>;
}

// --- Circuit Breaker ---

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerState {
  state: CircuitState;
  consecutiveFailures: number;
  /** Timestamp (ms) when OPEN state was entered. Null when CLOSED. */
  openedAt: number | null;
  /** Consecutive successful probes in HALF_OPEN state. */
  halfOpenSuccesses: number;
}

export interface CircuitBreakerResult {
  allowed: boolean;
  reason?: string;
  state: CircuitState;
}

export interface CircuitBreakerConfig {
  enabled: boolean;
  /** Consecutive failures to trip the breaker. Default: 5 */
  failureThreshold: number;
  /** Milliseconds before OPEN → HALF_OPEN transition. Default: 30000 */
  cooldownMs: number;
  /** Probe messages allowed in HALF_OPEN. Default: 1 */
  halfOpenProbeCount: number;
  /** Consecutive successes to close from HALF_OPEN. Default: 2 */
  successToClose: number;
}

// --- Backpressure ---

export interface BackpressureResult {
  allowed: boolean;
  reason?: string;
  /** Current mailbox depth (messages with status='new'). */
  currentSize: number;
  /** Pressure ratio 0.0–1.0 (currentSize / maxMailboxSize). */
  pressure: number;
}

export interface BackpressureConfig {
  enabled: boolean;
  /** Maximum unprocessed messages before hard rejection. Default: 1000 */
  maxMailboxSize: number;
  /** Pressure ratio (0–1) at which to emit warning signal. Default: 0.8 */
  pressureWarningAt: number;
}

// --- Composite Config ---

export interface ReliabilityConfig {
  rateLimit?: Partial<RateLimitConfig>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  backpressure?: Partial<BackpressureConfig>;
}
```

Extend the existing `RelayOptions` interface:

```typescript
export interface RelayOptions {
  dataDir?: string;
  maxHops?: number;
  defaultTtlMs?: number;
  defaultCallBudget?: number;
  reliability?: ReliabilityConfig; // NEW
}
```

### 2. PublishResult Extension

Extend the existing `PublishResult` type in `relay-core.ts`:

```typescript
export interface PublishResult {
  messageId: string;
  deliveredTo: number;
  rejected?: Array<{
    endpointHash: string;
    reason: 'backpressure' | 'circuit_open' | 'rate_limited' | 'budget_exceeded';
  }>;
  /** Per-endpoint pressure ratios for proactive signaling (0.0–1.0). */
  mailboxPressure?: Record<string, number>;
}
```

When all reliability features are disabled or no rejections occur, `rejected` and `mailboxPressure` are omitted (backward compatible).

### 3. Rate Limiter Module

**File:** `packages/relay/src/rate-limiter.ts`

Follows the `budget-enforcer.ts` pattern — a pure function that accepts a SQLite query interface and returns a result object.

```typescript
import type { RateLimitConfig, RateLimitResult } from './types.js';

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  enabled: true,
  windowSecs: 60,
  maxPerWindow: 100,
};

/**
 * Check whether a sender has exceeded their rate limit.
 *
 * Uses a sliding window log derived from the messages table.
 * The rate limit check runs ONCE at publish-time, before fan-out.
 *
 * @param sender - The sender's subject identifier.
 * @param countInWindow - Number of messages sent by this sender in the current window.
 * @param config - Rate limit configuration.
 * @returns A RateLimitResult indicating whether the message is allowed.
 */
export function checkRateLimit(
  sender: string,
  countInWindow: number,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG
): RateLimitResult {
  if (!config.enabled) {
    return { allowed: true };
  }

  // Check per-sender overrides first (longest prefix match)
  const limit = resolveLimit(sender, config);

  if (countInWindow >= limit) {
    return {
      allowed: false,
      reason: `rate limit exceeded: ${countInWindow}/${limit} messages in ${config.windowSecs}s window`,
      currentCount: countInWindow,
      limit,
    };
  }

  return { allowed: true, currentCount: countInWindow, limit };
}

/**
 * Resolve the effective rate limit for a sender.
 * Checks perSenderOverrides (longest prefix match), falls back to maxPerWindow.
 */
export function resolveLimit(sender: string, config: RateLimitConfig): number {
  if (!config.perSenderOverrides) return config.maxPerWindow;

  let bestMatch = '';
  let bestLimit = config.maxPerWindow;

  for (const [prefix, limit] of Object.entries(config.perSenderOverrides)) {
    if (sender.startsWith(prefix) && prefix.length > bestMatch.length) {
      bestMatch = prefix;
      bestLimit = limit;
    }
  }

  return bestLimit;
}

export { DEFAULT_RATE_LIMIT_CONFIG };
```

### 4. Circuit Breaker Module

**File:** `packages/relay/src/circuit-breaker.ts`

A class managing in-memory state per endpoint hash. The state machine follows the standard three-state pattern.

```typescript
import type {
  CircuitState,
  CircuitBreakerState,
  CircuitBreakerResult,
  CircuitBreakerConfig,
} from './types.js';

const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenProbeCount: 1,
  successToClose: 2,
};

export class CircuitBreakerManager {
  private breakers = new Map<string, CircuitBreakerState>();
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CB_CONFIG, ...config };
  }

  /** Check if delivery to an endpoint is allowed. */
  check(endpointHash: string): CircuitBreakerResult {
    if (!this.config.enabled) {
      return { allowed: true, state: 'CLOSED' };
    }

    const breaker = this.getOrCreate(endpointHash);

    switch (breaker.state) {
      case 'CLOSED':
        return { allowed: true, state: 'CLOSED' };

      case 'OPEN': {
        // Check if cooldown has elapsed → transition to HALF_OPEN
        const elapsed = Date.now() - (breaker.openedAt ?? 0);
        if (elapsed >= this.config.cooldownMs) {
          breaker.state = 'HALF_OPEN';
          breaker.halfOpenSuccesses = 0;
          return { allowed: true, state: 'HALF_OPEN' };
        }
        return {
          allowed: false,
          reason: `circuit open for endpoint ${endpointHash}`,
          state: 'OPEN',
        };
      }

      case 'HALF_OPEN':
        // Allow limited probes
        return { allowed: true, state: 'HALF_OPEN' };
    }
  }

  /** Record a successful delivery to an endpoint. */
  recordSuccess(endpointHash: string): void {
    const breaker = this.breakers.get(endpointHash);
    if (!breaker) return;

    switch (breaker.state) {
      case 'CLOSED':
        breaker.consecutiveFailures = 0;
        break;

      case 'HALF_OPEN':
        breaker.halfOpenSuccesses++;
        if (breaker.halfOpenSuccesses >= this.config.successToClose) {
          // Recovery confirmed — close the circuit
          breaker.state = 'CLOSED';
          breaker.consecutiveFailures = 0;
          breaker.openedAt = null;
          breaker.halfOpenSuccesses = 0;
        }
        break;
    }
  }

  /** Record a failed delivery to an endpoint. */
  recordFailure(endpointHash: string): void {
    const breaker = this.getOrCreate(endpointHash);

    breaker.consecutiveFailures++;

    switch (breaker.state) {
      case 'CLOSED':
        if (breaker.consecutiveFailures >= this.config.failureThreshold) {
          breaker.state = 'OPEN';
          breaker.openedAt = Date.now();
        }
        break;

      case 'HALF_OPEN':
        // Probe failed — reopen
        breaker.state = 'OPEN';
        breaker.openedAt = Date.now();
        breaker.halfOpenSuccesses = 0;
        break;
    }
  }

  /** Get the current state of all circuit breakers. */
  getStates(): Map<string, CircuitBreakerState> {
    return new Map(this.breakers);
  }

  /** Reset a specific breaker to CLOSED. */
  reset(endpointHash: string): void {
    this.breakers.delete(endpointHash);
  }

  /** Update configuration (for hot-reload). */
  updateConfig(config: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private getOrCreate(endpointHash: string): CircuitBreakerState {
    let breaker = this.breakers.get(endpointHash);
    if (!breaker) {
      breaker = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        openedAt: null,
        halfOpenSuccesses: 0,
      };
      this.breakers.set(endpointHash, breaker);
    }
    return breaker;
  }
}

export { DEFAULT_CB_CONFIG };
```

### 5. Backpressure Module

**File:** `packages/relay/src/backpressure.ts`

A pure function that checks mailbox depth and returns a result with pressure metric.

```typescript
import type { BackpressureConfig, BackpressureResult } from './types.js';

const DEFAULT_BP_CONFIG: BackpressureConfig = {
  enabled: true,
  maxMailboxSize: 1000,
  pressureWarningAt: 0.8,
};

/**
 * Check backpressure for an endpoint.
 *
 * @param currentSize - Number of unprocessed messages (status='new') for this endpoint.
 * @param config - Backpressure configuration.
 * @returns A BackpressureResult with allowed flag and pressure metric.
 */
export function checkBackpressure(
  currentSize: number,
  config: BackpressureConfig = DEFAULT_BP_CONFIG
): BackpressureResult {
  if (!config.enabled) {
    return { allowed: true, currentSize, pressure: 0 };
  }

  const pressure =
    config.maxMailboxSize > 0 ? Math.min(currentSize / config.maxMailboxSize, 1.0) : 0;

  if (currentSize >= config.maxMailboxSize) {
    return {
      allowed: false,
      reason: `backpressure: mailbox full (${currentSize}/${config.maxMailboxSize})`,
      currentSize,
      pressure,
    };
  }

  return { allowed: true, currentSize, pressure };
}

export { DEFAULT_BP_CONFIG };
```

### 6. SQLite Index Extensions

Add two new prepared statements and a migration to `packages/relay/src/sqlite-index.ts`.

**New migration (version 2):**

```sql
CREATE INDEX IF NOT EXISTS idx_messages_sender_created
  ON messages(sender, created_at DESC);
```

This enables efficient sliding window rate limit queries on `(sender, created_at)`.

**New prepared statements:**

```typescript
// Add to this.stmts in constructor:

/** Count messages from a sender within a time window (for rate limiting). */
countSenderInWindow: this.db.prepare(
  `SELECT COUNT(*) as cnt FROM messages
   WHERE sender = ? AND created_at > ?`
),

/** Count unprocessed messages for an endpoint (for backpressure). */
countNewByEndpoint: this.db.prepare(
  `SELECT COUNT(*) as cnt FROM messages
   WHERE endpoint_hash = ? AND status = 'new'`
),
```

**New public methods:**

```typescript
/**
 * Count messages sent by a specific sender within a time window.
 * Used by the rate limiter for sliding window log checks.
 */
countSenderInWindow(sender: string, windowStartIso: string): number {
  const row = this.stmts.countSenderInWindow.get(sender, windowStartIso) as { cnt: number };
  return row.cnt;
}

/**
 * Count unprocessed (status='new') messages for an endpoint.
 * Used by backpressure detection.
 */
countNewByEndpoint(endpointHash: string): number {
  const row = this.stmts.countNewByEndpoint.get(endpointHash) as { cnt: number };
  return row.cnt;
}
```

### 7. Signal Extensions

Extend `SignalTypeSchema` in `packages/shared/src/relay-schemas.ts` with a new signal type for backpressure:

```typescript
export const SignalTypeSchema = z
  .enum([
    'typing',
    'presence',
    'read_receipt',
    'delivery_receipt',
    'progress',
    'backpressure', // NEW
  ])
  .openapi('SignalType');
```

Backpressure signals are emitted via the existing `SignalEmitter.emit()` method when endpoint pressure exceeds `pressureWarningAt`:

```typescript
signalEmitter.emit(senderSubject, {
  type: 'backpressure',
  state: 'warning', // or 'critical' when >= maxMailboxSize
  endpointSubject: endpoint.subject,
  timestamp: new Date().toISOString(),
  data: { pressure: 0.85, currentSize: 850, maxMailboxSize: 1000 },
});
```

### 8. Relay Config Schema

Add Zod schemas for reliability config to `packages/shared/src/relay-schemas.ts`:

```typescript
export const RateLimitConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    windowSecs: z.number().int().min(1).default(60),
    maxPerWindow: z.number().int().min(1).default(100),
    perSenderOverrides: z.record(z.string(), z.number().int().min(1)).optional(),
  })
  .openapi('RateLimitConfig');

export const CircuitBreakerConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    failureThreshold: z.number().int().min(1).default(5),
    cooldownMs: z.number().int().min(1000).default(30_000),
    halfOpenProbeCount: z.number().int().min(1).default(1),
    successToClose: z.number().int().min(1).default(2),
  })
  .openapi('CircuitBreakerConfig');

export const BackpressureConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxMailboxSize: z.number().int().min(1).default(1000),
    pressureWarningAt: z.number().min(0).max(1).default(0.8),
  })
  .openapi('BackpressureConfig');

export const ReliabilityConfigSchema = z
  .object({
    rateLimit: RateLimitConfigSchema.partial().optional(),
    circuitBreaker: CircuitBreakerConfigSchema.partial().optional(),
    backpressure: BackpressureConfigSchema.partial().optional(),
  })
  .openapi('ReliabilityConfig');

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;
export type BackpressureConfig = z.infer<typeof BackpressureConfigSchema>;
export type ReliabilityConfig = z.infer<typeof ReliabilityConfigSchema>;
```

### 9. Pipeline Integration

Modify `relay-core.ts` to integrate all three reliability checks into the publish pipeline.

**In constructor:** Initialize reliability modules:

```typescript
// In RelayCore constructor, after existing module initialization:
private rateLimitConfig: RateLimitConfig;
private circuitBreaker: CircuitBreakerManager;
private backpressureConfig: BackpressureConfig;

// Initialize from options.reliability (with defaults):
this.rateLimitConfig = {
  ...DEFAULT_RATE_LIMIT_CONFIG,
  ...options?.reliability?.rateLimit,
};
this.circuitBreaker = new CircuitBreakerManager(options?.reliability?.circuitBreaker);
this.backpressureConfig = {
  ...DEFAULT_BP_CONFIG,
  ...options?.reliability?.backpressure,
};
```

**In `publish()` method:** Add rate limit check BEFORE fan-out:

```typescript
// After access control check, before building envelope:
if (this.rateLimitConfig.enabled) {
  const windowStart = new Date(Date.now() - this.rateLimitConfig.windowSecs * 1000).toISOString();
  const count = this.sqliteIndex.countSenderInWindow(options.from, windowStart);
  const rateLimitResult = checkRateLimit(options.from, count, this.rateLimitConfig);

  if (!rateLimitResult.allowed) {
    return {
      messageId: '', // No message created
      deliveredTo: 0,
      rejected: [{ endpointHash: '', reason: 'rate_limited' }],
    };
  }
}
```

**In `deliverToEndpoint()` method:** Add backpressure and circuit breaker checks:

```typescript
// BEFORE existing budget enforcement:

// 1. Backpressure check
const newCount = this.sqliteIndex.countNewByEndpoint(endpoint.hash);
const bpResult = checkBackpressure(newCount, this.backpressureConfig);

// Emit backpressure warning signal if pressure exceeds threshold
if (bpResult.pressure >= this.backpressureConfig.pressureWarningAt) {
  this.signalEmitter.emit(envelope.from, {
    type: 'backpressure',
    state: bpResult.allowed ? 'warning' : 'critical',
    endpointSubject: endpoint.subject,
    timestamp: new Date().toISOString(),
    data: {
      pressure: bpResult.pressure,
      currentSize: bpResult.currentSize,
      maxMailboxSize: this.backpressureConfig.maxMailboxSize,
    },
  });
}

if (!bpResult.allowed) {
  return {
    delivered: false,
    rejected: { endpointHash: endpoint.hash, reason: 'backpressure' },
    pressure: bpResult.pressure,
  };
}

// 2. Circuit breaker check
const cbResult = this.circuitBreaker.check(endpoint.hash);
if (!cbResult.allowed) {
  return {
    delivered: false,
    rejected: { endpointHash: endpoint.hash, reason: 'circuit_open' },
    pressure: bpResult.pressure,
  };
}

// ... existing budget enforcement and delivery ...

// AFTER successful Maildir delivery:
this.circuitBreaker.recordSuccess(endpoint.hash);

// ON delivery failure (Maildir write error or handler throw):
this.circuitBreaker.recordFailure(endpoint.hash);
```

**In `publish()` result aggregation:** Collect per-endpoint results into `PublishResult`:

```typescript
const rejected: PublishResult['rejected'] = [];
const mailboxPressure: Record<string, number> = {};

for (const endpoint of matchingEndpoints) {
  const result = await this.deliverToEndpoint(endpoint, envelope);

  if (result.rejected) {
    rejected.push(result.rejected);
  }
  if (result.pressure !== undefined) {
    mailboxPressure[endpoint.hash] = result.pressure;
  }
  if (result.delivered) {
    deliveredCount++;
  }
}

return {
  messageId: envelope.id,
  deliveredTo: deliveredCount,
  ...(rejected.length > 0 && { rejected }),
  ...(Object.keys(mailboxPressure).length > 0 && { mailboxPressure }),
};
```

### 10. Config Hot-Reload

Add a config file watcher to `RelayCore` following the `access-control.ts` pattern. The config file lives at `{dataDir}/config.json`.

```typescript
// In RelayCore constructor:
this.configPath = path.join(dataDir, 'config.json');
this.loadReliabilityConfig();
this.startConfigWatcher();

private loadReliabilityConfig(): void {
  try {
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    const parsed = ReliabilityConfigSchema.safeParse(JSON.parse(raw).reliability);
    if (parsed.success) {
      this.rateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...parsed.data.rateLimit };
      this.circuitBreaker.updateConfig({ ...DEFAULT_CB_CONFIG, ...parsed.data.circuitBreaker });
      this.backpressureConfig = { ...DEFAULT_BP_CONFIG, ...parsed.data.backpressure };
    }
  } catch {
    // File doesn't exist or is invalid — keep current config
  }
}

private startConfigWatcher(): void {
  this.configWatcher = chokidar.watch(this.configPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  this.configWatcher.on('change', () => this.loadReliabilityConfig());
  this.configWatcher.on('add', () => this.loadReliabilityConfig());
}
```

### 11. Barrel Export Updates

Add new exports to `packages/relay/src/index.ts`:

```typescript
// Reliability modules
export { checkRateLimit, resolveLimit, DEFAULT_RATE_LIMIT_CONFIG } from './rate-limiter.js';
export { CircuitBreakerManager, DEFAULT_CB_CONFIG } from './circuit-breaker.js';
export { checkBackpressure, DEFAULT_BP_CONFIG } from './backpressure.js';

// Reliability types
export type {
  RateLimitResult,
  RateLimitConfig,
  CircuitState,
  CircuitBreakerState,
  CircuitBreakerResult,
  CircuitBreakerConfig,
  BackpressureResult,
  BackpressureConfig,
  ReliabilityConfig,
} from './types.js';
```

## User Experience

From an agent developer's perspective:

1. **Default behavior:** Reliability features are enabled with sensible defaults. No configuration required. Agents interact with `relay.publish()` as before.

2. **Rejection feedback:** When a publish is rejected for reliability reasons, the caller receives a structured `PublishResult` with a `rejected` array explaining why (rate_limited, circuit_open, or backpressure). The caller can decide whether to retry at the application layer.

3. **Proactive signaling:** The `mailboxPressure` field in `PublishResult` tells callers how full each recipient's mailbox is (0.0–1.0). Cooperative agents can throttle their send rate when pressure approaches 1.0.

4. **Backpressure signals:** High-pressure events are also emitted as signals on the sender's subject, so agents subscribed to signals can react in real-time.

5. **Configuration:** Operators can adjust thresholds by editing `~/.dork/relay/config.json`. Changes take effect immediately via hot-reload, no restart needed.

## Testing Strategy

### Unit Tests

**`rate-limiter.test.ts`** (~200 lines):

```typescript
describe('checkRateLimit', () => {
  // Purpose: Verify the sliding window log rate limiter correctly allows/rejects
  // based on message count in the configured time window.

  it('allows message when count is below limit');
  it('rejects message when count equals limit');
  it('rejects message when count exceeds limit');
  it('allows message when rate limiting is disabled');
  it('returns current count and limit in result');
  it('includes rejection reason with count details');
});

describe('resolveLimit', () => {
  // Purpose: Verify per-sender override resolution with longest prefix match.

  it('returns maxPerWindow when no overrides configured');
  it('returns override limit for exact prefix match');
  it('returns longest matching prefix override');
  it('returns maxPerWindow when no prefix matches');
});
```

**`circuit-breaker.test.ts`** (~250 lines):

```typescript
describe('CircuitBreakerManager', () => {
  // Purpose: Verify the three-state machine transitions correctly.

  describe('CLOSED state', () => {
    it('allows delivery when no failures recorded');
    it('tracks consecutive failures');
    it('transitions to OPEN after failureThreshold consecutive failures');
    it('resets failure count on success');
  });

  describe('OPEN state', () => {
    it('rejects delivery immediately');
    it('transitions to HALF_OPEN after cooldown elapses');
    it('remains OPEN if cooldown has not elapsed');
    it('includes endpoint hash in rejection reason');
  });

  describe('HALF_OPEN state', () => {
    it('allows a single probe message');
    it('transitions to CLOSED after successToClose consecutive successes');
    it('transitions back to OPEN on probe failure');
    it('resets halfOpenSuccesses on transition back to OPEN');
  });

  describe('state management', () => {
    it('creates new breaker in CLOSED state for unknown endpoint');
    it('maintains separate state per endpoint hash');
    it('reset() clears a specific breaker');
    it('getStates() returns a copy of all breaker states');
    it('updateConfig() changes thresholds for future checks');
  });

  describe('disabled', () => {
    it('always allows when enabled=false');
  });
});
```

**`backpressure.test.ts`** (~150 lines):

```typescript
describe('checkBackpressure', () => {
  // Purpose: Verify mailbox depth checking with pressure metric calculation.

  it('allows delivery when mailbox is empty');
  it('allows delivery when below maxMailboxSize');
  it('rejects delivery when at maxMailboxSize');
  it('rejects delivery when above maxMailboxSize');
  it('returns pressure ratio 0.0 for empty mailbox');
  it('returns pressure ratio 0.5 for half-full mailbox');
  it('returns pressure ratio 1.0 for full mailbox');
  it('caps pressure at 1.0 for overfull mailbox');
  it('allows all messages when disabled');
  it('handles maxMailboxSize of 0 without division error');
});
```

### Integration Tests

**`relay-core.test.ts`** (additions, ~100 lines):

```typescript
describe('reliability pipeline integration', () => {
  // Purpose: Verify all three reliability features compose correctly
  // in the full publish pipeline.

  it('rate limit check runs before fan-out (one check for multi-endpoint publish)');
  it('rate-limited publish returns rejected array with reason');
  it('backpressure rejection skips Maildir delivery');
  it('circuit breaker rejection skips Maildir delivery');
  it('circuit breaker records success after successful delivery');
  it('circuit breaker records failure on Maildir write error');
  it('backpressure signal emitted when pressure exceeds warning threshold');
  it('mailboxPressure included in PublishResult for all endpoints');
  it('reliability rejections do NOT appear in dead letter queue');
  it('publish works normally with all reliability features disabled');
  it('budget enforcement still runs after reliability checks pass');
  it('multiple endpoints: some rejected (backpressure), some delivered');
});
```

### Mocking Strategy

- Rate limiter tests: Pass `countInWindow` directly (no SQLite mock needed — pure function)
- Circuit breaker tests: Direct class instantiation with `Date.now()` mocking for cooldown
- Backpressure tests: Pass `currentSize` directly (no SQLite mock needed — pure function)
- Integration tests: Use real SQLite in-memory database (`better-sqlite3` with `:memory:`) and temp Maildir directories

## Performance Considerations

All reliability checks add negligible overhead to the publish pipeline:

| Check           | Type                      | Cost                                      | Frequency        |
| --------------- | ------------------------- | ----------------------------------------- | ---------------- |
| Rate limit      | SQLite prepared statement | <1ms (index scan on `sender, created_at`) | Once per publish |
| Circuit breaker | In-memory Map lookup      | <0.01ms                                   | Per endpoint     |
| Backpressure    | SQLite prepared statement | <1ms (index on `endpoint_hash, status`)   | Per endpoint     |

For a local system with dozens of agents and <1000 messages/minute, the total overhead per publish is under 2ms. The existing `(endpoint_hash, created_at DESC)` index supports the backpressure count query. The new `(sender, created_at DESC)` index supports the rate limit query.

`better-sqlite3`'s synchronous API means zero event-loop contention for these queries.

## Security Considerations

- **Rate limits prevent message flooding:** A misbehaving agent cannot overwhelm other agents' mailboxes
- **Backpressure prevents disk exhaustion:** A slow/crashed agent cannot cause unbounded growth
- **Circuit breakers prevent cascading failures:** Corrupted endpoints don't waste resources on repeated failed writes
- **Config is relay-level policy:** Rate limits and thresholds are NOT configurable by individual agents at publish time — they are operator-level settings in the config file
- **No new attack surface:** All features are local-only with no network exposure (HTTP endpoints are Spec 2 scope)

## Documentation

- Update `contributing/architecture.md` with reliability pipeline section
- Add inline TSDoc comments on all new public functions and types
- Config file format documented via Zod schema self-description
- No new external user-facing docs needed (Spec 2 handles API docs)

## Implementation Phases

### Phase 1: Core Modules

Create the three reliability modules with tests:

1. Extend `types.ts` with new interfaces
2. Create `rate-limiter.ts` + `rate-limiter.test.ts`
3. Create `circuit-breaker.ts` + `circuit-breaker.test.ts`
4. Create `backpressure.ts` + `backpressure.test.ts`
5. Extend `sqlite-index.ts` with new queries and migration

### Phase 2: Pipeline Integration

Wire modules into `relay-core.ts`:

1. Extend `PublishResult` type
2. Add rate limit check to `publish()` (before fan-out)
3. Add backpressure and circuit breaker checks to `deliverToEndpoint()`
4. Add circuit breaker success/failure recording
5. Aggregate `rejected` and `mailboxPressure` in publish result
6. Integration tests

### Phase 3: Configuration

Add config hot-reload:

1. Add Zod schemas to `@dorkos/shared/relay-schemas.ts`
2. Add `SignalType.backpressure` to signal schema
3. Add config file watcher to `RelayCore`
4. Update barrel exports in `index.ts`

## Related ADRs

- **ADR #10:** Use Maildir for Relay Message Storage — circuit breaker monitors Maildir delivery success/failure
- **ADR #13:** Use Hybrid Maildir + SQLite for Relay Storage — rate limit and backpressure queries run against the SQLite derived index

## References

- [01-ideation.md](./01-ideation.md) — Ideation document with research findings and decision rationale
- [Relay Litepaper](../../meta/modules/relay-litepaper.md) — Phase 2: "Rate limiting per sender. Circuit breakers per endpoint pair. Backpressure handling."
- [Relay Spec Plan](../../plans/relay-specs/03-relay-advanced-reliability.md) — Verification checklist and design constraints
- [Research Report](../../research/20260224_relay_advanced_reliability.md) — Algorithm comparisons, build-vs-buy analysis, sensible defaults
