---
slug: relay-advanced-reliability
number: 52
created: 2026-02-24
status: specified
---

# Tasks: Relay Advanced Reliability

**Spec:** [02-specification.md](./02-specification.md)
**Feature:** relay-advanced-reliability

---

## Phase 1: Foundation — Type Extensions & Schemas

### Task 1.1: Extend types.ts with reliability interfaces

Add new result types and config interfaces to `packages/relay/src/types.ts`, following the existing `BudgetResult` and `AccessResult` pattern.

**New types to add:**

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

**Extend existing `RelayOptions` interface:**

```typescript
export interface RelayOptions {
  dataDir?: string;
  maxHops?: number;
  defaultTtlMs?: number;
  defaultCallBudget?: number;
  reliability?: ReliabilityConfig; // NEW
}
```

**Acceptance Criteria:**

- All new types compile without errors
- Existing code remains unaffected (backward compatible)
- TSDoc comments on all new interfaces and fields

---

### Task 1.2: Add Zod schemas to relay-schemas.ts

Add Zod schemas for reliability configuration and extend SignalType with `'backpressure'` in `packages/shared/src/relay-schemas.ts`.

**New Zod schemas:**

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

**Extend `SignalTypeSchema`:**

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

**Acceptance Criteria:**

- All schemas parse valid configs correctly
- Schema defaults match spec defaults
- `backpressure` added to SignalTypeSchema
- Types exported for use by relay modules

---

### Task 1.3: Extend SQLite index with rate limit and backpressure queries

Add two new prepared statements, a new migration (version 2), and two new public methods to `packages/relay/src/sqlite-index.ts`.

**New migration (version 2):**

```sql
CREATE INDEX IF NOT EXISTS idx_messages_sender_created
  ON messages(sender, created_at DESC);
```

Add to the `MIGRATIONS` array as the second entry.

**New prepared statements (add to `this.stmts` in constructor):**

```typescript
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

**Tests (add to `sqlite-index.test.ts`):**

- `countSenderInWindow` returns 0 for no matching messages
- `countSenderInWindow` counts only messages from specified sender
- `countSenderInWindow` filters by window start time
- `countNewByEndpoint` returns 0 for empty endpoint
- `countNewByEndpoint` counts only 'new' status messages
- `countNewByEndpoint` excludes 'cur' and 'failed' messages
- Migration version 2 creates the new index

**Acceptance Criteria:**

- Migration runs automatically on construction
- Both prepared statements work with in-memory SQLite
- All new tests pass

---

## Phase 2: Core Modules

### Task 2.1: Create rate limiter module with tests

Create `packages/relay/src/rate-limiter.ts` following the `budget-enforcer.ts` pure function pattern.

**Full implementation:**

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

**Test file: `packages/relay/src/__tests__/rate-limiter.test.ts`**

Tests to write (~200 lines):

```typescript
describe('checkRateLimit', () => {
  it('allows message when count is below limit');
  it('rejects message when count equals limit');
  it('rejects message when count exceeds limit');
  it('allows message when rate limiting is disabled');
  it('returns current count and limit in result');
  it('includes rejection reason with count details');
});

describe('resolveLimit', () => {
  it('returns maxPerWindow when no overrides configured');
  it('returns override limit for exact prefix match');
  it('returns longest matching prefix override');
  it('returns maxPerWindow when no prefix matches');
});
```

**Acceptance Criteria:**

- Pure function, no side effects
- Per-sender override resolution with longest prefix match
- All test cases pass
- TSDoc on all exported functions

---

### Task 2.2: Create circuit breaker module with tests

Create `packages/relay/src/circuit-breaker.ts` as a class managing in-memory state per endpoint hash.

**Full implementation:**

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

**Test file: `packages/relay/src/__tests__/circuit-breaker.test.ts`**

Tests to write (~250 lines):

```typescript
describe('CircuitBreakerManager', () => {
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

Use `vi.useFakeTimers()` and `vi.setSystemTime()` for cooldown timing tests.

**Acceptance Criteria:**

- Standard three-state machine: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
- Separate state per endpoint hash (Map-based)
- Config update support for hot-reload
- All test cases pass
- TSDoc on all public methods

---

### Task 2.3: Create backpressure module with tests

Create `packages/relay/src/backpressure.ts` as a pure function that checks mailbox depth.

**Full implementation:**

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

**Test file: `packages/relay/src/__tests__/backpressure.test.ts`**

Tests to write (~150 lines):

```typescript
describe('checkBackpressure', () => {
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

**Acceptance Criteria:**

- Pure function, no side effects
- Pressure metric calculation: `currentSize / maxMailboxSize`, capped at 1.0
- Division by zero protection when `maxMailboxSize` is 0
- All test cases pass
- TSDoc on exported function

---

## Phase 3: Pipeline Integration

### Task 3.1: Extend PublishResult and deliverToEndpoint return type

Extend the `PublishResult` interface in `relay-core.ts` and create an internal `EndpointDeliveryResult` type for per-endpoint results.

**Updated `PublishResult`:**

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

**Internal type for per-endpoint delivery result:**

```typescript
interface EndpointDeliveryResult {
  delivered: boolean;
  rejected?: {
    endpointHash: string;
    reason: 'backpressure' | 'circuit_open' | 'rate_limited' | 'budget_exceeded';
  };
  pressure?: number;
}
```

**Acceptance Criteria:**

- `rejected` and `mailboxPressure` are omitted when empty (backward compatible)
- Existing `PublishResult` consumers unaffected
- `deliverToEndpoint` returns `EndpointDeliveryResult` instead of `boolean`

---

### Task 3.2: Integrate rate limiter into publish() pipeline

Wire the rate limiter into the `publish()` method in `relay-core.ts`.

**Constructor changes:**

```typescript
import { checkRateLimit, DEFAULT_RATE_LIMIT_CONFIG } from './rate-limiter.js';
import type { RateLimitConfig } from './types.js';

// In constructor:
private rateLimitConfig: RateLimitConfig;

this.rateLimitConfig = {
  ...DEFAULT_RATE_LIMIT_CONFIG,
  ...options?.reliability?.rateLimit,
};
```

**In `publish()` method, after access control check, before building envelope:**

```typescript
if (this.rateLimitConfig.enabled) {
  const windowStart = new Date(Date.now() - this.rateLimitConfig.windowSecs * 1000).toISOString();
  const count = this.sqliteIndex.countSenderInWindow(options.from, windowStart);
  const rateLimitResult = checkRateLimit(options.from, count, this.rateLimitConfig);

  if (!rateLimitResult.allowed) {
    return {
      messageId: '',
      deliveredTo: 0,
      rejected: [{ endpointHash: '', reason: 'rate_limited' }],
    };
  }
}
```

**Acceptance Criteria:**

- Rate limit check runs ONCE per publish, before fan-out
- Rate-limited publishes return `rejected` array with `reason: 'rate_limited'`
- No message created when rate-limited (`messageId: ''`)
- Rate limiting disabled by default does not affect existing behavior

---

### Task 3.3: Integrate backpressure and circuit breaker into deliverToEndpoint()

Wire backpressure and circuit breaker checks into `deliverToEndpoint()` in `relay-core.ts`.

**Constructor changes:**

```typescript
import { CircuitBreakerManager, DEFAULT_CB_CONFIG } from './circuit-breaker.js';
import { checkBackpressure, DEFAULT_BP_CONFIG } from './backpressure.js';
import type { BackpressureConfig } from './types.js';

// In constructor:
private circuitBreaker: CircuitBreakerManager;
private backpressureConfig: BackpressureConfig;

this.circuitBreaker = new CircuitBreakerManager(options?.reliability?.circuitBreaker);
this.backpressureConfig = {
  ...DEFAULT_BP_CONFIG,
  ...options?.reliability?.backpressure,
};
```

**In `deliverToEndpoint()`, BEFORE existing budget enforcement:**

```typescript
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
```

**AFTER successful Maildir delivery:**

```typescript
this.circuitBreaker.recordSuccess(endpoint.hash);
```

**ON delivery failure (Maildir write error or handler throw):**

```typescript
this.circuitBreaker.recordFailure(endpoint.hash);
```

**Acceptance Criteria:**

- Backpressure check runs per-endpoint, before budget enforcement
- Circuit breaker check runs per-endpoint, after backpressure
- Success/failure recorded after Maildir delivery attempt
- Backpressure warning signal emitted when pressure exceeds threshold
- Rejections do NOT go to dead letter queue

---

### Task 3.4: Aggregate results in publish() and update return type

Update the `publish()` method to collect per-endpoint results and build the extended `PublishResult`.

**Modified publish() fan-out loop:**

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

**Also update budget enforcement rejection in `deliverToEndpoint` to use the new `EndpointDeliveryResult` format:**

```typescript
// Budget enforcement rejection now returns structured result:
if (!budgetResult.allowed) {
  await this.deadLetterQueue.reject(
    endpoint.hash,
    envelope,
    budgetResult.reason ?? 'budget enforcement failed'
  );
  return { delivered: false, rejected: { endpointHash: endpoint.hash, reason: 'budget_exceeded' } };
}
```

**Acceptance Criteria:**

- `rejected` array only included when non-empty
- `mailboxPressure` only included when non-empty
- Budget rejections still go to DLQ (reliability rejections do NOT)
- Backward compatible when all features disabled

---

### Task 3.5: Config hot-reload for reliability settings

Add a config file watcher to `RelayCore` following the `access-control.ts` chokidar pattern.

**Implementation in `relay-core.ts`:**

```typescript
import { ReliabilityConfigSchema } from '@dorkos/shared/relay-schemas';

// In constructor:
private configPath: string;
private configWatcher: FSWatcher | null = null;

this.configPath = path.join(dataDir, 'config.json');
this.loadReliabilityConfig();
this.startConfigWatcher();

// New private methods:
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

**In `close()` method, add config watcher cleanup:**

```typescript
if (this.configWatcher) {
  await this.configWatcher.close();
  this.configWatcher = null;
}
```

**Acceptance Criteria:**

- Config loads from `{dataDir}/config.json` on startup
- Config hot-reloads on file change (chokidar watcher)
- Invalid config silently keeps current settings
- Watcher cleaned up in `close()`

---

## Phase 4: Exports & Integration Tests

### Task 4.1: Update barrel exports in index.ts

Add new exports to `packages/relay/src/index.ts`.

**New exports:**

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

**Acceptance Criteria:**

- All new public APIs accessible from `@dorkos/relay`
- Package builds successfully with `turbo build --filter=@dorkos/relay`
- No circular imports

---

### Task 4.2: Integration tests for reliability pipeline

Add integration tests to `packages/relay/src/__tests__/relay-core.test.ts` verifying all three reliability features compose correctly in the full publish pipeline.

**Tests to write (~100 lines):**

```typescript
describe('reliability pipeline integration', () => {
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

**Test setup pattern (matching existing relay-core.test.ts):**

```typescript
let tmpDir: string;
let relay: RelayCore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-reliability-test-'));
  relay = new RelayCore({
    dataDir: tmpDir,
    reliability: {
      rateLimit: { enabled: true, maxPerWindow: 5, windowSecs: 60 },
      circuitBreaker: { enabled: true, failureThreshold: 3, cooldownMs: 1000 },
      backpressure: { enabled: true, maxMailboxSize: 10, pressureWarningAt: 0.8 },
    },
  });
});

afterEach(async () => {
  await relay.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});
```

Uses real SQLite in-memory database and temp Maildir directories, matching existing integration test patterns.

**Acceptance Criteria:**

- All 12 integration test cases pass
- Tests use real SQLite and temp Maildir (not mocks)
- Tests clean up temp directories in afterEach
- No flaky tests from timing issues

---

## Dependency Graph

```
Task 1.1 (types.ts) ──┐
                       ├──→ Task 2.1 (rate-limiter)
Task 1.2 (schemas)   ──┤   Task 2.2 (circuit-breaker)  ──┐
                       ├──→ Task 2.3 (backpressure)       │
Task 1.3 (sqlite-index)┘                                  │
                                                           │
                       Task 3.1 (PublishResult) ──────────────┐
                       Task 3.2 (rate limiter integration) ───┤
                       Task 3.3 (bp + cb integration) ────────┤──→ Task 3.4 (result aggregation)
                                                              │
                       Task 3.5 (config hot-reload) ──────────┘
                                                           │
                       Task 4.1 (barrel exports) ──────────┤──→ Task 4.2 (integration tests)
```

**Parallel opportunities:**

- Tasks 1.1, 1.2, 1.3 can run in parallel (all are foundation)
- Tasks 2.1, 2.2, 2.3 can run in parallel (each is independent)
- Tasks 3.1, 3.2, 3.3, 3.5 can run in parallel (different parts of relay-core.ts)
- Task 3.4 depends on 3.1, 3.2, 3.3
- Task 4.2 depends on all Phase 3 tasks
