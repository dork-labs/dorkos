# Relay Adapter DX Improvements

**Status:** Draft
**Authors:** Claude Code
**Date:** 2026-03-11
**Spec Number:** 119
**Slug:** relay-adapter-dx
**Branch:** preflight/relay-adapter-dx

---

## Overview

Resolve six DX gaps in the relay adapter system discovered during an architecture review. The current adapter authoring experience requires every adapter to independently implement ~30 lines of identical boilerplate, the plugin loader has a factory signature bug, test files are co-located inconsistently, and there is no API versioning, compliance test suite, or adapter template.

This specification covers:

1. **BaseRelayAdapter** abstract class (optional convenience)
2. **Fix plugin factory signature** (bug fix)
3. **API versioning** (future-proofing)
4. **Compliance test suite** (quality gate)
5. **Directory structure standardization** (consistency)
6. **Adapter template** (ecosystem growth)

## Background / Problem Statement

The `RelayAdapter` interface is well-designed and stable. However, every adapter must independently implement identical boilerplate:

- **Status initialization** (5 lines) — `state: 'disconnected'`, `messageCount`, `errorCount`
- **Error recording** (8-10 lines) — `recordError()` logic updating `state`, `errorCount`, `lastError`, `lastErrorAt`
- **`getStatus()`** (1-3 lines) — return a shallow copy
- **Idempotency guards** (2-3 lines per method) — skip `start()` if already started, skip `stop()` if already stopped
- **Relay ref lifecycle** (2-3 lines) — store relay ref on start, null on stop

Total: ~30 lines of identical code per adapter. Three built-in adapters share this pattern. Third-party authors will copy-paste it.

Additionally:

- The plugin loader's `AdapterPluginModule.default` signature is `(config) => RelayAdapter` but should include `id` — the adapter's `id` is lost during plugin loading (line 32, `adapter-plugin-loader.ts`)
- No API versioning mechanism exists — version mismatches between `@dorkos/relay` and adapters built against older versions will produce cryptic runtime errors
- No compliance test suite — "does my adapter work?" has no definitive answer
- Test co-location is inconsistent — telegram tests in `src/__tests__/adapters/`, claude-code and webhook tests in `src/adapters/__tests__/`
- Webhook adapter is a monolithic file not in a subdirectory (unlike telegram/ and claude-code/)
- No adapter template or scaffold — authors start from scratch

## Goals

- Eliminate adapter boilerplate via an optional `BaseRelayAdapter` abstract class
- Fix the plugin factory signature bug so adapter `id` is passed during loading
- Add API versioning to prevent silent version mismatch issues
- Provide a compliance test suite that definitively validates adapter correctness
- Standardize the per-adapter directory structure for consistency
- Create an adapter template for "working adapter in under 5 minutes"
- Zero breaking changes to existing imports

## Non-Goals

- CLI scaffold command (`dorkos adapter init`) — follow-up work
- Adapter marketplace or registry — future roadmap
- Changes to `AdapterRegistry`, `AdapterManager`, or routing logic
- Changes to the relay publish pipeline
- Breaking changes to the `RelayAdapter` interface shape
- Adapter hot-reload mechanism changes
- Making `BaseRelayAdapter` required — direct `RelayAdapter` implementation remains fully supported

## Technical Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| `vitest` | ^4.0.18 | Test runner for compliance suite |
| `@dorkos/shared` | workspace:* | AdapterManifest schema (add `apiVersion` field) |
| `@dorkos/test-utils` | workspace:* | Mock factories (add `createMockRelayPublisher`, `createMockRelayEnvelope`) |

No new external dependencies. API version comparison uses a simple manual `major.minor` check rather than adding `semver` as a dependency (the monorepo does not use `semver` anywhere).

## Related ADRs

- `decisions/0030-dynamic-import-for-adapter-plugins.md` — Factory export pattern (will be updated to document `id` parameter)
- `decisions/0044-adapter-manifest-schema.md` — Manifest schema (adding optional `apiVersion` field)

## Detailed Design

### Improvement 1: BaseRelayAdapter Abstract Class

**File:** `packages/relay/src/base-adapter.ts` (new)

An optional abstract class that handles status tracking, idempotency guards, error recording, and relay ref lifecycle. Subclasses implement three protected methods.

```typescript
import type {
  RelayAdapter,
  RelayPublisher,
  AdapterStatus,
  AdapterContext,
  DeliveryResult,
  RelayEnvelope,
} from './types.js';

/**
 * Optional abstract base class for relay adapters.
 *
 * Handles boilerplate that every adapter needs: status tracking state machine,
 * start/stop idempotency guards, error recording, and relay ref lifecycle.
 *
 * Subclasses implement `_start()`, `_stop()`, and `deliver()`.
 * Direct `RelayAdapter` implementation remains fully supported.
 *
 * @example
 * ```typescript
 * class MyAdapter extends BaseRelayAdapter {
 *   constructor(id: string, config: MyConfig) {
 *     super(id, 'relay.custom.mine', 'My Adapter');
 *   }
 *
 *   protected async _start(relay: RelayPublisher): Promise<void> {
 *     // Connect to external service
 *   }
 *
 *   protected async _stop(): Promise<void> {
 *     // Disconnect and drain in-flight messages
 *   }
 *
 *   async deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult> {
 *     // Deliver message to external channel
 *     return { delivered: true };
 *   }
 * }
 * ```
 */
export abstract class BaseRelayAdapter implements RelayAdapter {
  readonly id: string;
  readonly subjectPrefix: string | readonly string[];
  readonly displayName: string;

  /** Reference to the relay publisher, set on start, cleared on stop. */
  protected relay: RelayPublisher | null = null;

  private _status: AdapterStatus = {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  constructor(
    id: string,
    subjectPrefix: string | readonly string[],
    displayName: string,
  ) {
    this.id = id;
    this.subjectPrefix = subjectPrefix;
    this.displayName = displayName;
  }

  /**
   * Start the adapter with idempotency guard and status tracking.
   *
   * Subclasses implement `_start()` for the actual connection logic.
   */
  async start(relay: RelayPublisher): Promise<void> {
    if (this._status.state === 'connected') return; // idempotent
    this._status = { ...this._status, state: 'starting' };
    this.relay = relay;
    try {
      await this._start(relay);
      this._status = {
        ...this._status,
        state: 'connected',
        startedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.recordError(err);
      this.relay = null;
      throw err; // re-throw — host (AdapterRegistry) handles isolation
    }
  }

  /**
   * Stop the adapter with idempotency guard and status tracking.
   *
   * Subclasses implement `_stop()` for the actual disconnection logic.
   */
  async stop(): Promise<void> {
    if (this._status.state === 'disconnected') return; // idempotent
    this._status = { ...this._status, state: 'stopping' };
    try {
      await this._stop();
    } finally {
      this.relay = null;
      this._status = { ...this._status, state: 'disconnected' };
    }
  }

  /** Return a snapshot of the current adapter status. */
  getStatus(): AdapterStatus {
    return { ...this._status };
  }

  /**
   * Track a successful delivery — increments outbound message count.
   * Call this from `deliver()` after successful delivery.
   */
  protected trackOutbound(): void {
    this._status = {
      ...this._status,
      messageCount: {
        ...this._status.messageCount,
        outbound: this._status.messageCount.outbound + 1,
      },
    };
  }

  /**
   * Track an inbound message — increments inbound message count.
   * Call this when receiving a message from an external channel.
   */
  protected trackInbound(): void {
    this._status = {
      ...this._status,
      messageCount: {
        ...this._status.messageCount,
        inbound: this._status.messageCount.inbound + 1,
      },
    };
  }

  /**
   * Record an error — updates status to 'error' state with error details.
   * Call this from `deliver()` or `_start()` when an error occurs.
   *
   * Does NOT catch or swallow the error — that's the host's job.
   */
  protected recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this._status = {
      ...this._status,
      state: 'error',
      errorCount: this._status.errorCount + 1,
      lastError: message,
      lastErrorAt: new Date().toISOString(),
    };
  }

  /** Subclass hook: connect to the external service. */
  protected abstract _start(relay: RelayPublisher): Promise<void>;

  /** Subclass hook: disconnect and drain in-flight messages. */
  protected abstract _stop(): Promise<void>;

  /** Deliver a relay message to the external channel. */
  abstract deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext,
  ): Promise<DeliveryResult>;
}
```

**Design decisions:**

- **Re-throw errors, don't silently catch.** Per OpenTelemetry convention, the host (`AdapterRegistry`) handles isolation. The base class tracks state but lets errors propagate so adapter authors see failures during development.
- **`deliver()` is NOT wrapped.** The `AdapterRegistry` already wraps delivery in try/catch with timeout and circuit breaker. Adding another layer would hide errors.
- **`_start()` / `_stop()` naming.** Prefixed with `_` to clearly distinguish from the public `start()`/`stop()` lifecycle methods. This matches Winston's `TransportStream._write()` and Node's `Writable._write()` patterns.
- **`getStatus()` returns a shallow copy.** Prevents external mutation of internal state.

**Migration path for built-in adapters:**

Each built-in adapter can optionally extend `BaseRelayAdapter`. This is a refactor, not a requirement. The existing adapters continue to work unchanged. Migration is done per-adapter when convenient:

1. Change `class TelegramAdapter` to `extends BaseRelayAdapter`
2. Rename `start()` to `_start()`, `stop()` to `_stop()`
3. Remove duplicated status init, `recordError()`, `getStatus()`, idempotency guards
4. Call `this.trackInbound()` / `this.trackOutbound()` / `this.recordError()` from delivery logic

### Improvement 2: Fix Plugin Factory Signature

**Files:**
- `packages/relay/src/adapter-plugin-loader.ts` (fix)
- `contributing/relay-adapters.md` (update docs)

The `AdapterPluginModule.default` type is currently `(config: Record<string, unknown>) => RelayAdapter`. The `id` parameter is never passed to the factory function, even though `entry.id` is available.

**Changes to `adapter-plugin-loader.ts`:**

```typescript
// BEFORE (line 32):
export interface AdapterPluginModule {
  default: (config: Record<string, unknown>) => RelayAdapter;
  getManifest?: () => AdapterManifest;
}

// AFTER:
export interface AdapterPluginModule {
  default: (id: string, config: Record<string, unknown>) => RelayAdapter;
  getManifest?: () => AdapterManifest;
}
```

```typescript
// BEFORE (line 122-123 in validateAndCreate):
const factory = m.default as (config: Record<string, unknown>) => RelayAdapter;
const adapter = factory(entry.config);

// AFTER:
const factory = m.default as (id: string, config: Record<string, unknown>) => RelayAdapter;
const adapter = factory(entry.id, entry.config);
```

The built-in adapter factory map in `loadAdapters()` also needs the signature updated:

```typescript
// BEFORE (line 59):
builtinMap: Map<string, (config: Record<string, unknown>) => RelayAdapter>,

// AFTER:
builtinMap: Map<string, (id: string, config: Record<string, unknown>) => RelayAdapter>,
```

And the built-in map call site (line 76):

```typescript
// BEFORE:
adapter = factory(entry.config);

// AFTER:
adapter = factory(entry.id, entry.config);
```

**Impact on `adapter-factory.ts`:** The `builtinMap` construction in `apps/server/src/services/relay/adapter-manager.ts` (or wherever it's built) needs to pass `id` to each built-in factory. Currently the built-in adapters are not loaded via `loadAdapters()` — they go through `createAdapter()` which already passes `config.id`. No change needed there.

### Improvement 3: API Versioning

**Files:**
- `packages/relay/src/version.ts` (new)
- `packages/relay/src/index.ts` (add export)
- `packages/relay/src/adapter-plugin-loader.ts` (add version check)
- `packages/shared/src/relay-adapter-schemas.ts` (add field)

**Version constant:**

```typescript
// packages/relay/src/version.ts

/**
 * Relay adapter API version.
 *
 * Bump this when the RelayAdapter interface changes:
 * - MAJOR: Breaking changes to required interface members
 * - MINOR: New optional members, new types, behavioral changes
 *
 * Pre-1.0: No stability guarantees.
 * Post-1.0: Follow SemVer — MAJOR for breaking, MINOR for additive.
 */
export const RELAY_ADAPTER_API_VERSION = '0.1.0';
```

**AdapterManifest schema update:**

```typescript
// In AdapterManifestSchema, add optional field:
apiVersion: z.string().optional(),
```

**Plugin loader version check:**

```typescript
// In adapter-plugin-loader.ts, after loading the manifest:
function checkApiVersion(manifest: AdapterManifest, adapterId: string, logger: Logger): void {
  if (!manifest.apiVersion) return; // no version declared — skip check

  const [hostMajor, hostMinor] = RELAY_ADAPTER_API_VERSION.split('.').map(Number);
  const [adapterMajor, adapterMinor] = manifest.apiVersion.split('.').map(Number);

  if (hostMajor !== adapterMajor) {
    logger.warn(
      `[PluginLoader] Adapter '${adapterId}' targets API v${manifest.apiVersion} ` +
      `but host is v${RELAY_ADAPTER_API_VERSION} (major version mismatch)`,
    );
  } else if (adapterMinor > hostMinor) {
    logger.warn(
      `[PluginLoader] Adapter '${adapterId}' targets API v${manifest.apiVersion} ` +
      `but host is v${RELAY_ADAPTER_API_VERSION} (adapter expects newer features)`,
    );
  }
}
```

**Design decisions:**

- **Warning-level log, not hard block.** Hard-blocking on version mismatch would break adapters unnecessarily. Warnings give adapter authors time to update. Modeled on VS Code's `engines.vscode` behavior.
- **Simple manual comparison instead of `semver` dependency.** The monorepo doesn't use `semver` anywhere. A 3-line `major.minor` check is sufficient for the pre-1.0 era. Can add `semver` later if needed.

### Improvement 4: Compliance Test Suite

**Files:**
- `packages/relay/src/testing/index.ts` (new)
- `packages/relay/src/testing/compliance-suite.ts` (new)
- `packages/relay/src/testing/mock-relay-publisher.ts` (new)
- `packages/relay/src/testing/mock-relay-envelope.ts` (new)
- `packages/relay/package.json` (add `./testing` export)

**Package.json export:**

```json
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    },
    "./testing": {
      "types": "./src/testing/index.ts",
      "default": "./dist/testing/index.js"
    }
  }
}
```

**Mock utilities:**

```typescript
// packages/relay/src/testing/mock-relay-publisher.ts
import type { RelayPublisher } from '../types.js';
import { vi } from 'vitest';

/**
 * Create a mock RelayPublisher for adapter tests.
 *
 * All methods are vi.fn() stubs. `publish()` resolves with a default result.
 * `onSignal()` returns a no-op unsubscribe function.
 */
export function createMockRelayPublisher(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'test-msg-001', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
  };
}
```

```typescript
// packages/relay/src/testing/mock-relay-envelope.ts
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

/**
 * Create a mock RelayEnvelope for adapter delivery tests.
 *
 * Provides sensible defaults that can be overridden.
 */
export function createMockRelayEnvelope(
  overrides: Partial<RelayEnvelope> = {},
): RelayEnvelope {
  return {
    id: 'test-envelope-001',
    from: 'relay.test.sender',
    subject: 'relay.test.recipient',
    payload: { type: 'text', body: 'Test message' },
    budget: { maxHops: 5, ttlMs: 30_000, currentHop: 1 },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}
```

**Compliance suite:**

```typescript
// packages/relay/src/testing/compliance-suite.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RelayAdapter, AdapterStatus } from '../types.js';
import { createMockRelayPublisher } from './mock-relay-publisher.js';
import { createMockRelayEnvelope } from './mock-relay-envelope.js';

/** Options for the adapter compliance test suite. */
export interface ComplianceSuiteOptions {
  /** Human-readable name for the test suite (e.g., 'TelegramAdapter'). */
  name: string;
  /** Factory function that creates a fresh adapter instance for each test. */
  createAdapter: () => RelayAdapter;
  /** Subject to use for delivery tests. Must match the adapter's subjectPrefix. */
  deliverSubject: string;
}

/**
 * Run the adapter compliance test suite.
 *
 * Validates that an adapter correctly implements the RelayAdapter contract:
 * 1. Shape compliance (all required properties and methods exist)
 * 2. Status lifecycle (initial state, connected after start, disconnected after stop)
 * 3. Start/stop idempotency (calling start twice or stop twice doesn't throw)
 * 4. getStatus() returns a valid AdapterStatus shape
 * 5. deliver() returns a DeliveryResult
 * 6. Error tracking (errorCount increments, lastError populated)
 * 7. testConnection() shape (if present)
 *
 * Modeled on the abstract-blob-store compliance pattern.
 *
 * @example
 * ```typescript
 * import { runAdapterComplianceSuite } from '@dorkos/relay/testing';
 *
 * runAdapterComplianceSuite({
 *   name: 'MyAdapter',
 *   createAdapter: () => new MyAdapter('test', { ... }),
 *   deliverSubject: 'relay.custom.mine.test',
 * });
 * ```
 */
export function runAdapterComplianceSuite(options: ComplianceSuiteOptions): void {
  const { name, createAdapter, deliverSubject } = options;

  describe(`${name} — Adapter Compliance Suite`, () => {
    let adapter: RelayAdapter;
    let relay: ReturnType<typeof createMockRelayPublisher>;

    beforeEach(() => {
      adapter = createAdapter();
      relay = createMockRelayPublisher();
    });

    afterEach(async () => {
      try {
        await adapter.stop();
      } catch {
        // Swallow — adapter may already be stopped
      }
    });

    // --- Shape compliance ---

    it('has a string id', () => {
      expect(typeof adapter.id).toBe('string');
      expect(adapter.id.length).toBeGreaterThan(0);
    });

    it('has a subjectPrefix (string or string[])', () => {
      const prefix = adapter.subjectPrefix;
      const isValid =
        typeof prefix === 'string' ||
        (Array.isArray(prefix) && prefix.every((p) => typeof p === 'string'));
      expect(isValid).toBe(true);
    });

    it('has a string displayName', () => {
      expect(typeof adapter.displayName).toBe('string');
      expect(adapter.displayName.length).toBeGreaterThan(0);
    });

    it('has start, stop, deliver, and getStatus methods', () => {
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.stop).toBe('function');
      expect(typeof adapter.deliver).toBe('function');
      expect(typeof adapter.getStatus).toBe('function');
    });

    // --- Status lifecycle ---

    it('initial status state is "disconnected"', () => {
      const status = adapter.getStatus();
      expect(status.state).toBe('disconnected');
    });

    it('getStatus() returns a valid AdapterStatus shape', () => {
      const status = adapter.getStatus();
      expect(status).toHaveProperty('state');
      expect(status).toHaveProperty('messageCount');
      expect(status.messageCount).toHaveProperty('inbound');
      expect(status.messageCount).toHaveProperty('outbound');
      expect(typeof status.messageCount.inbound).toBe('number');
      expect(typeof status.messageCount.outbound).toBe('number');
      expect(status).toHaveProperty('errorCount');
      expect(typeof status.errorCount).toBe('number');
    });

    it('getStatus() returns a copy (not a reference)', () => {
      const status1 = adapter.getStatus();
      const status2 = adapter.getStatus();
      expect(status1).not.toBe(status2);
      expect(status1).toEqual(status2);
    });

    // --- Start/stop idempotency ---

    it('start() is idempotent (calling twice does not throw)', async () => {
      await adapter.start(relay);
      await expect(adapter.start(relay)).resolves.not.toThrow();
    });

    it('stop() is idempotent (calling twice does not throw)', async () => {
      await adapter.start(relay);
      await adapter.stop();
      await expect(adapter.stop()).resolves.not.toThrow();
    });

    it('stop() without start() does not throw', async () => {
      await expect(adapter.stop()).resolves.not.toThrow();
    });

    // --- deliver() ---

    it('deliver() returns a result (not undefined)', async () => {
      await adapter.start(relay);
      const envelope = createMockRelayEnvelope({ subject: deliverSubject });
      const result = await adapter.deliver(deliverSubject, envelope);
      // DeliveryResult can be { delivered: true } or { delivered: false, reason: string }
      // or void/undefined for legacy adapters — we just check it doesn't throw
      expect(result).toBeDefined();
    });

    // --- testConnection() ---

    it('testConnection() returns { ok: boolean } if present', async () => {
      if (!adapter.testConnection) return; // optional method
      const result = await adapter.testConnection();
      expect(result).toHaveProperty('ok');
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) {
        expect(result).toHaveProperty('error');
        expect(typeof result.error).toBe('string');
      }
    });
  });
}
```

**Barrel export:**

```typescript
// packages/relay/src/testing/index.ts

/**
 * Testing utilities for relay adapter development.
 *
 * @module relay/testing
 */
export { runAdapterComplianceSuite } from './compliance-suite.js';
export type { ComplianceSuiteOptions } from './compliance-suite.js';
export { createMockRelayPublisher } from './mock-relay-publisher.js';
export { createMockRelayEnvelope } from './mock-relay-envelope.js';
```

### Improvement 5: Standardize Directory Structure

**Goal:** All adapters follow the same directory convention:

```
packages/relay/src/adapters/
├── telegram/
│   ├── telegram-adapter.ts
│   ├── index.ts
│   └── __tests__/
│       └── telegram-adapter.test.ts
├── webhook/
│   ├── webhook-adapter.ts
│   ├── index.ts
│   └── __tests__/
│       └── webhook-adapter.test.ts
└── claude-code/
    ├── claude-code-adapter.ts
    ├── index.ts
    └── __tests__/
        ├── claude-code-adapter.test.ts
        └── claude-code-adapter-correlation.test.ts
```

**Changes:**

1. **Move `webhook-adapter.ts`** from `src/adapters/webhook-adapter.ts` to `src/adapters/webhook/webhook-adapter.ts`
2. **Create `src/adapters/webhook/index.ts`** that re-exports everything from `webhook-adapter.ts`
3. **Move `src/adapters/__tests__/webhook-adapter.test.ts`** to `src/adapters/webhook/__tests__/webhook-adapter.test.ts`
4. **Move `src/__tests__/adapters/telegram-adapter.test.ts`** to `src/adapters/telegram/__tests__/telegram-adapter.test.ts`
5. **Move `src/adapters/__tests__/claude-code-adapter.test.ts`** and `claude-code-adapter-correlation.test.ts` to `src/adapters/claude-code/__tests__/`
6. **Update `src/index.ts`** import for `WebhookAdapter` from `./adapters/webhook-adapter.js` to `./adapters/webhook/index.js`
7. **Delete empty parent `__tests__` directories** after moving

**Backward compatibility:** The `index.ts` barrel re-exports ensure all existing `import { WebhookAdapter } from '@dorkos/relay'` statements continue to work.

### Improvement 6: Adapter Template

**Directory:** `templates/relay-adapter/` (new)

```
templates/relay-adapter/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # Factory default export + getManifest
│   ├── my-adapter.ts     # Working no-op adapter extending BaseRelayAdapter
│   └── __tests__/
│       └── my-adapter.test.ts  # Pre-wired compliance suite
└── README.md
```

**`package.json`:**

```json
{
  "name": "dorkos-relay-my-adapter",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "keywords": ["dorkos", "relay", "adapter"],
  "peerDependencies": {
    "@dorkos/relay": ">=0.0.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vitest": "^4.0.0",
    "@dorkos/relay": "workspace:*"
  }
}
```

**`src/my-adapter.ts`:**

```typescript
import { BaseRelayAdapter } from '@dorkos/relay';
import type {
  RelayPublisher,
  RelayEnvelope,
  AdapterContext,
  DeliveryResult,
} from '@dorkos/relay';

/**
 * Example relay adapter.
 *
 * Replace this with your adapter implementation.
 */
export class MyAdapter extends BaseRelayAdapter {
  constructor(id: string, config: Record<string, unknown>) {
    super(id, 'relay.custom.mine', config.displayName as string ?? 'My Adapter');
  }

  protected async _start(relay: RelayPublisher): Promise<void> {
    // TODO: Connect to your external service
    // Store `relay` for publishing inbound messages later:
    //   await relay.publish('relay.custom.mine.inbound', envelope);
  }

  protected async _stop(): Promise<void> {
    // TODO: Disconnect and drain in-flight messages
  }

  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    _context?: AdapterContext,
  ): Promise<DeliveryResult> {
    // TODO: Send the message to your external channel
    this.trackOutbound();
    return { delivered: true };
  }
}
```

**`src/index.ts`:**

```typescript
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import type { RelayAdapter } from '@dorkos/relay';
import { RELAY_ADAPTER_API_VERSION } from '@dorkos/relay';
import { MyAdapter } from './my-adapter.js';

/** Factory function — called by the DorkOS plugin loader. */
export default function createAdapter(
  id: string,
  config: Record<string, unknown>,
): RelayAdapter {
  return new MyAdapter(id, config);
}

/** Adapter manifest — describes capabilities for the adapter catalog. */
export function getManifest(): AdapterManifest {
  return {
    type: 'my-adapter',
    displayName: 'My Adapter',
    description: 'A custom relay adapter.',
    category: 'custom',
    builtin: false,
    apiVersion: RELAY_ADAPTER_API_VERSION,
    configFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        description: 'Your service API key',
      },
    ],
    multiInstance: false,
  };
}
```

**`src/__tests__/my-adapter.test.ts`:**

```typescript
import { runAdapterComplianceSuite } from '@dorkos/relay/testing';
import { MyAdapter } from '../my-adapter.js';

runAdapterComplianceSuite({
  name: 'MyAdapter',
  createAdapter: () => new MyAdapter('test-mine', {}),
  deliverSubject: 'relay.custom.mine.test',
});
```

**`README.md`:** Step-by-step guide covering:
1. Clone the template
2. Rename `MyAdapter` → your adapter name
3. Update `subjectPrefix` and manifest
4. Implement `_start()`, `_stop()`, `deliver()`
5. Run `pnpm test` (compliance suite should pass)
6. Configure in `~/.dork/adapters.json`

## User Experience

### For Internal Developers

Before: Copy-paste 30+ lines of boilerplate from an existing adapter, hope you got the error recording right, check three different test directories to find examples.

After: `extends BaseRelayAdapter`, implement three methods, run the compliance suite. Tests co-located next to the adapter code.

### For Third-Party Authors

Before: Read the 1018-line contributing guide, study three built-in adapters to reverse-engineer the patterns, hope your factory function receives the right parameters.

After: Copy the template, rename, implement three methods, run `pnpm test`. The compliance suite tells you exactly what's working and what isn't. The API version in your manifest warns if the host is incompatible.

## Testing Strategy

### Unit Tests

**`base-adapter.test.ts`** — Test the `BaseRelayAdapter` directly using a concrete test subclass:

```typescript
class TestAdapter extends BaseRelayAdapter {
  startCalled = false;
  stopCalled = false;

  constructor() {
    super('test', 'relay.test.', 'Test');
  }

  protected async _start(): Promise<void> {
    this.startCalled = true;
  }

  protected async _stop(): Promise<void> {
    this.stopCalled = true;
  }

  async deliver(): Promise<DeliveryResult> {
    this.trackOutbound();
    return { delivered: true };
  }
}
```

Test cases:
- Initial status is `{ state: 'disconnected', messageCount: { inbound: 0, outbound: 0 }, errorCount: 0 }`
- After `start()`, status state is `'connected'` and `startedAt` is set
- After `stop()`, status state is `'disconnected'`
- `start()` is idempotent — second call is a no-op
- `stop()` is idempotent — second call is a no-op
- `stop()` without `start()` does not throw
- `_start()` error updates status to `'error'` and re-throws
- `trackOutbound()` increments `messageCount.outbound`
- `trackInbound()` increments `messageCount.inbound`
- `recordError()` sets `state: 'error'`, increments `errorCount`, sets `lastError` and `lastErrorAt`
- `getStatus()` returns a copy (mutating the return value doesn't affect internal state)
- `relay` ref is set on start and cleared on stop

**`adapter-plugin-loader.test.ts`** — Update existing tests:
- Test that factory receives `(id, config)` — not just `(config)`
- Test version warning log for mismatched `apiVersion`
- Test no warning when `apiVersion` matches or is absent

**`version.test.ts`** — Verify `RELAY_ADAPTER_API_VERSION` exports correctly and matches `major.minor.patch` format.

### Integration Tests

**Compliance suite on built-in adapters** — Run `runAdapterComplianceSuite` against `TelegramAdapter`, `WebhookAdapter`, and `ClaudeCodeAdapter` in their respective test files. This validates both the suite itself and the adapters.

### Template Tests

The template's `my-adapter.test.ts` pre-wires the compliance suite. Running `pnpm test` in the template directory validates the template is functional.

## Performance Considerations

- **BaseRelayAdapter:** Zero runtime overhead. Status tracking uses simple object spreads (no deep cloning, no immutable libraries). The abstract class adds one level of vtable dispatch per method call — negligible.
- **API version check:** Runs once per adapter load (startup only). String split + number comparison — sub-microsecond.
- **Compliance suite:** Test-time only — no production impact.

## Security Considerations

- **Plugin factory signature fix:** The `id` parameter is already in the config entry. Passing it to the factory function doesn't introduce new attack surface.
- **API version field:** Read-only metadata. No code execution based on the version string.
- **Template:** The template ships with no credentials. The README explicitly notes that API keys should be stored in `adapters.json` (which lives in `~/.dork/` and is not committed to git).

## Documentation Updates

1. **`contributing/relay-adapters.md`** — Add sections for:
   - Using `BaseRelayAdapter` (with code examples)
   - Updated factory signature `(id, config) => RelayAdapter`
   - Running the compliance suite
   - API versioning guidance
   - Template quick-start

2. **ADR update** — Update `decisions/0030-dynamic-import-for-adapter-plugins.md` to document the `id` parameter addition.

## Implementation Phases

### Phase 1: Foundation

1. Create `BaseRelayAdapter` abstract class
2. Fix plugin factory signature (bug fix)
3. Add `RELAY_ADAPTER_API_VERSION` constant

### Phase 2: Quality Infrastructure

4. Create compliance test suite and mock utilities
5. Add `./testing` subpath export to `package.json`
6. Add `apiVersion` field to `AdapterManifest` schema
7. Add version check to plugin loader

### Phase 3: Consistency

8. Move `webhook-adapter.ts` into `webhook/` directory
9. Co-locate all adapter tests into per-adapter `__tests__/` directories
10. Update all import paths and barrel re-exports

### Phase 4: Ecosystem

11. Create adapter template with README
12. Update `contributing/relay-adapters.md` with new guidance

## Open Questions

None — all decisions were resolved during ideation (see `specs/relay-adapter-dx/01-ideation.md` Section 6).

## References

- **Ideation:** `specs/relay-adapter-dx/01-ideation.md`
- **Research:** `research/20260311_relay_adapter_sdk_design.md`
- **RelayAdapter interface:** `packages/relay/src/types.ts:262-313`
- **Plugin loader:** `packages/relay/src/adapter-plugin-loader.ts`
- **Contributing guide:** `contributing/relay-adapters.md`
- **Patterns studied:** VS Code Extension API, Obsidian Plugin API, Winston Transport, Socket.IO Adapter, OpenTelemetry SDK, abstract-blob-store, Fastify Plugin, Rollup Plugin
