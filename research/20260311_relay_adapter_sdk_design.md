---
title: 'Relay Adapter SDK Design — Plugin Patterns, DX, Versioning, and Testing'
date: 2026-03-11
type: external-best-practices
status: active
tags: [relay, adapter, sdk, plugin, typescript, dx, testing, versioning, factory-pattern]
feature_slug: relay-adapter-sdk
searches_performed: 18
sources_count: 32
---

# Research: Relay Adapter SDK Design

**Date:** 2026-03-11
**Depth:** Deep Research (18 searches + 12 web fetches)
**Context:** The `RelayAdapter` interface (4 required methods: `start`, `stop`, `deliver`, `getStatus`) is well-formed. This research covers the broader SDK design question: abstract class vs interface, factory conventions, versioning, onboarding DX, error handling patterns, and testing utilities that third-party adapter authors need.

---

## Research Summary

The TypeScript ecosystem has converged strongly on **interface + factory function** as the plugin pattern. Abstract base classes are used specifically when the framework has non-trivial shared behavior to provide — not as a general substitute for interfaces. For the relay adapter system, the right model is a **thin optional `BaseRelayAdapter` class** that handles boilerplate state tracking (`getStatus`, `lastError`, `messageCount`) while the `RelayAdapter` interface remains the canonical contract. The factory function export convention (`export default function createXxxAdapter(config): RelayAdapter`) is universal across Rollup, Vite, Fastify, unplugin, ESLint, Babel, and Winston. API versioning should use a `manifest.json`-style static field (`apiVersion: string`) checked at load time via semver. The highest-leverage DX investment is a compliance test harness modeled on `abstract-blob-store` and `abstract-winston-transport` — a vitest-compatible test suite that validates any adapter against the contract. Plugin authors deserve error messages that point to exactly which method is missing and why.

---

## Key Findings

### 1. Abstract Base Class vs Interface — The Right Split

The TypeScript ecosystem's consensus is nuanced: it is **not** "always interface" or "always abstract class" — it is "interface for the contract, abstract class for shared implementation the host can legitimately provide."

**Use a pure interface when:**

- The contract is purely structural and the implementor provides all the code
- You want to allow multiple inheritance (interfaces compose; abstract classes do not)
- You want zero risk of the base class becoming a maintenance burden for plugin authors

**Add an optional abstract base class when:**

- The framework has genuine shared behavior that belongs in the host (not the plugin)
- The shared code would otherwise need to be copy-pasted into every adapter
- The Template Method pattern applies — the algorithm skeleton is fixed, only steps vary

**Real examples showing the split:**

| System      | Interface                                     | Abstract Class                     | What the class provides                                                         |
| ----------- | --------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| Obsidian    | `Plugin` interface (conceptual contract)      | `Plugin extends Component`         | Lifecycle mgmt, `register()`, auto-cleanup on `unload()`, `loadData`/`saveData` |
| Winston     | `Transport` (duck-typed, no formal interface) | `TransportStream extends Writable` | Stream infrastructure, error events, backpressure, `exceptions.handle()`        |
| Socket.IO   | `Adapter` (conceptual)                        | `Adapter extends EventEmitter`     | Room management, broadcast bookkeeping                                          |
| Rollup/Vite | `Plugin` type (object interface)              | None — purely object-based         | N/A                                                                             |
| Fastify     | `FastifyPlugin` type                          | None — purely functional           | N/A                                                                             |
| ESLint      | Rule schema (plain object)                    | None                               | N/A                                                                             |
| Babel       | Plugin descriptor (plain object)              | None                               | N/A                                                                             |

The pattern is clear: **if the framework can own meaningful lifecycle or state management code, an abstract base class is worthwhile**. If the contract is purely about method signatures, an interface is the right choice.

**For DorkOS relay adapters specifically**, the base class case is moderate:

- `getStatus()` implementation (tracking `messageCount`, `errorCount`, `lastError`, `startedAt`, `state`) is identical boilerplate across all adapters
- `start()` / `stop()` idempotency guards (`if (this._started) return`) are identical
- Telemetry hooks (`this._emitEvent('adapter.started')`, `this._emitEvent('adapter.error', err)`) belong in the host

A `BaseRelayAdapter` abstract class that handles this state machinery — while leaving `start`, `stop`, and `deliver` abstract — is the right call. **The abstract class should be opt-in, not required.** Third-party adapters may implement `RelayAdapter` directly without extending it.

**Anti-pattern to avoid:** Making the abstract class load-bearing in ways that break composition. Specifically:

- Do not put network logic in the base class (Obsidian violates this with its `requestUrl` being a class method — every plugin carries HTTP machinery)
- Do not make the base class constructor require framework internals as parameters (the factory function pattern decouples instantiation from construction)
- Do not use protected members that plugin authors need to touch for basic functionality — if it needs to be protected, reconsider whether it belongs in the base at all

---

### 2. Plugin Factory Conventions

**The universal pattern across the ecosystem is:**

```typescript
// Plugin package exports a default factory function
export default function createMyAdapter(config: MyAdapterConfig): RelayAdapter {
  return { /* object implementing the interface */ };
}

// Optional: named manifest export
export function getManifest(): AdapterManifest {
  return { type: 'my-adapter', displayName: 'My Adapter', ... };
}
```

This is confirmed by:

- **Rollup/Vite**: "It is common convention to author a plugin as a factory function that returns the actual plugin object." The plugin object must have a `name` property.
- **Fastify**: `module.exports = function (fastify, options, done) {}` — a function, not a class.
- **unplugin**: `createUnplugin(factory)` where factory takes `(options, meta)` and returns the plugin object.
- **ESLint/Babel**: All plugins are factory functions returning plain objects.
- **Winston transports**: The exception — Winston uses class extension (`class MyTransport extends Transport`) — but this is because Winston transports ARE streams, and you cannot duck-type a Node.js stream.

**Why factory function wins over class export:**

1. **Config-time composition**: The factory receives config and closes over it — no constructor juggling
2. **Testable isolation**: `createAdapter(mockConfig)` in tests — simple, no `new` keyword complexity
3. **Private state**: Closure variables are private without TypeScript access modifiers
4. **Framework flexibility**: The host can call the factory at any time with a validated config object; it doesn't need to know the class constructor signature

**Naming convention:**

- Package: `dorkos-relay-adapter-slack` or `@my-org/relay-adapter-discord`
- Main export: `export default function createSlackAdapter(config: SlackAdapterConfig): RelayAdapter`
- Manifest export: `export function getManifest(): AdapterManifest`

The current codebase's `AdapterPluginModule` interface already enforces `default: (config) => RelayAdapter` — this is correct. The `getManifest?: () => AdapterManifest` optional export is also the right pattern.

**What the factory function receives:**

The current signature `(config: Record<string, unknown>)` is too loose for third-party DX. The right approach: the host passes a validated, typed config object. Each adapter package should export its own Zod schema for validation:

```typescript
// In the adapter package
export const slackConfigSchema = z.object({
  botToken: z.string(),
  channelId: z.string(),
  signingSecret: z.string().optional(),
});
export type SlackAdapterConfig = z.infer<typeof slackConfigSchema>;

export default function createSlackAdapter(config: SlackAdapterConfig): RelayAdapter { ... }
```

The plugin loader validates the config using the adapter's exported schema before calling the factory. This pattern is used by n8n (each node exports a `properties` schema + a `credentials` schema) and by Grafana (each plugin declares its settings schema in `plugin.json`).

---

### 3. API Versioning for Plugin Interfaces

**The two-part approach that major platforms use:**

**Part 1: Adapter declares what API version it was built against**

Every adapter package should export an `apiVersion` property or declare it in its manifest:

```typescript
// Option A: Static property on the factory (Obsidian/Figma pattern)
export const apiVersion = '1.0.0';

// Option B: Part of the manifest (Rollup/VS Code pattern)
export function getManifest(): AdapterManifest {
  return { ..., apiVersion: '1.0.0' };
}
```

**Part 2: The host validates compatibility at load time**

```typescript
// In the plugin loader, after importing the module
const adapterApiVersion = (mod as any).apiVersion ?? '0.0.0';
const hostApiVersion = '1.0.0'; // from @dorkos/relay package.json

if (!semver.satisfies(adapterApiVersion, `>=${hostApiVersion}`)) {
  logger.warn(
    `[PluginLoader] Adapter '${entry.id}' was built for relay API v${adapterApiVersion}, ` +
      `but host requires v${hostApiVersion}. It may not work correctly.`
  );
  // Non-fatal: proceed but warn. Breaking changes force a major bump.
}
```

**Real systems studied:**

- **VS Code**: `engines.vscode: "^1.68.0"` in `package.json`. The extension host validates this before loading. Below minimum: extension is disabled. No silent loading.
- **Figma**: `"api": "1.0.0"` in `manifest.json`. Figma's loader checks this field and rejects plugins built for deprecated major versions.
- **Obsidian**: `minAppVersion` in `manifest.json`. The app refuses to load plugins requiring newer versions. `requireApiVersion(version)` function for runtime feature detection.
- **Rollup plugins**: Optional `version` field on the plugin object, used for inter-plugin version communication (e.g., a plugin that depends on another plugin can check the version).

**Recommended approach for DorkOS relay:**

1. The relay SDK package exports `RELAY_ADAPTER_API_VERSION = '1.0.0'` from its main index
2. The `AdapterManifest` schema gains an optional `apiVersion: string` field
3. The `AdapterPluginModule` interface gains `apiVersion?: string` as a named export
4. The plugin loader emits a `WARN`-level log (not an error, not an exception) when versions don't satisfy
5. Major version bumps break compatibility; minor/patch are always additive

**What not to do:**

- Do not check at type-check time only (TypeScript is erased at runtime — the check must be runtime)
- Do not hard-block on mismatched versions unless you KNOW the interface changed in a breaking way
- Do not require adapters to re-register or re-publish on every relay minor release

---

### 4. Plugin Developer Onboarding DX

The single highest-leverage investment for third-party adapter authors is a **working template repository** that can be used as a GitHub template. The difference between a plugin ecosystem that thrives (VS Code, Obsidian, ESLint) and one that stays small is almost entirely the quality of the day-one experience.

**What the ideal day-one experience looks like:**

```bash
# Day one — should be achievable in under 5 minutes
git clone --template https://github.com/dorkos/relay-adapter-template my-slack-adapter
cd my-slack-adapter
pnpm install
# Edit src/index.ts — one file, already has the shape
pnpm dev        # runs the validator in watch mode
pnpm test       # runs the compliance test suite
```

**Template contents:**

```
relay-adapter-template/
├── src/
│   └── index.ts          # Factory function + getManifest — the ONLY file to edit
├── __tests__/
│   └── index.test.ts     # Compliance test suite pre-wired — runs without editing
├── package.json          # Correct peer deps, keywords, scripts
├── tsconfig.json         # Configured for ESM + relay adapter patterns
├── vitest.config.ts      # Pre-configured for compliance tests
└── README.md             # Step-by-step: fill in these 4 things
```

**Lessons from successful plugin ecosystems:**

- **VS Code**: Provides `yo code` scaffolder that generates a complete extension in seconds. The generated code is runnable immediately (hit F5 in VS Code — the extension loads). The sample extension is a working "Hello World" that demonstrates all patterns.

- **Obsidian**: `obsidian-sample-plugin` GitHub template. Includes working `onload()`/`onunload()`, settings tab, and ribbon icon. First-time plugin authors can have something running in ~10 minutes.

- **Rollup**: The plugin guide explicitly says "you can write a plugin that works in both Rollup and Vite." The documentation consistently shows minimal, complete examples (not abstract descriptions).

- **ESLint**: `@eslint/create-config` scaffolds a complete plugin. The documentation separates "write your first rule" from "publish your first plugin" into distinct guides.

**What kills plugin DX:**

1. **Circular dependency errors** — adapters that fail cryptically because they import from the wrong place
2. **Missing type stubs** — plugin authors can't get autocomplete on the `RelayPublisher` or `RelayEnvelope` types
3. **No offline validation** — the only way to know if your adapter works is to deploy it
4. **Vague error messages** — "adapter validation failed" instead of "Adapter 'my-adapter': missing 'deliver()' method"

The existing `validateAdapterShape` function already gives specific errors. Good. But the errors need to surface to the adapter author during local development, not just at load time.

---

### 5. Error Handling in Plugin Systems

**The OpenTelemetry specification is the gold standard for SDK error handling**. Its mandate, which DorkOS should follow:

> "OpenTelemetry implementations MUST NOT throw unhandled exceptions at run time."

This translates directly to the relay adapter system:

**The host (AdapterRegistry) MUST:**

- Wrap every call to `adapter.start()`, `adapter.stop()`, and `adapter.deliver()` in try/catch
- Never let an adapter failure propagate to the relay publish pipeline
- Log suppressed errors ("whenever the library suppresses an error that would otherwise have been exposed to the user, the library SHOULD log the error")
- Return a safe default (a `DeliveryResult { success: false, error: ... }`) rather than propagating the exception

**The base class (BaseRelayAdapter) SHOULD:**

- NOT wrap `deliver()` automatically — this would hide errors from plugin authors during development
- Instead, instrument telemetry hooks called by `AdapterRegistry` around each method call
- The division of responsibility: AdapterRegistry catches → BaseRelayAdapter tracks metrics

**The concrete pattern:**

```typescript
// AdapterRegistry (host) — never propagates adapter errors
async deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult | null> {
  const results = await Promise.allSettled(
    this.matchingAdapters(subject).map((adapter) =>
      this.callDeliverSafely(adapter, subject, envelope, context)
    )
  );
  // ... aggregate results
}

private async callDeliverSafely(
  adapter: RelayAdapter,
  subject: string,
  envelope: RelayEnvelope,
  context?: AdapterContext,
): Promise<DeliveryResult> {
  try {
    return await adapter.deliver(subject, envelope, context);
  } catch (err) {
    // Suppress — but log and track
    const error = err instanceof Error ? err.message : String(err);
    this.logger.error(`[AdapterRegistry] ${adapter.id} deliver() threw:`, err);
    this.emit('adapter.error', { adapterId: adapter.id, error, subject });
    return { success: false, error };
  }
}
```

**BaseRelayAdapter (optional base class) — tracks state, does NOT silently catch:**

```typescript
export abstract class BaseRelayAdapter implements RelayAdapter {
  // State tracking — the main value prop of the base class
  private _state: 'idle' | 'starting' | 'running' | 'stopping' | 'error' = 'idle';
  private _messageCount = 0;
  private _errorCount = 0;
  private _lastError: string | undefined;
  private _lastErrorAt: string | undefined;
  private _startedAt: string | undefined;
  private _started = false;

  abstract readonly id: string;
  abstract readonly subjectPrefix: string | readonly string[];
  abstract readonly displayName: string;

  // Idempotency guard — one of the few things worth sharing
  async start(relay: RelayPublisher): Promise<void> {
    if (this._started) return;
    this._state = 'starting';
    try {
      await this._start(relay);
      this._started = true;
      this._state = 'running';
      this._startedAt = new Date().toISOString();
    } catch (err) {
      this._state = 'error';
      this._lastError = err instanceof Error ? err.message : String(err);
      this._lastErrorAt = new Date().toISOString();
      throw err; // Re-throw — AdapterRegistry handles isolation
    }
  }

  // Subclasses implement this
  protected abstract _start(relay: RelayPublisher): Promise<void>;
  abstract stop(): Promise<void>;

  // deliver() is NOT wrapped — let errors propagate naturally to AdapterRegistry
  abstract deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext
  ): Promise<DeliveryResult>;

  // Provided implementation — no boilerplate for adapter authors
  getStatus(): AdapterStatus {
    return {
      state: this._state,
      messageCount: this._messageCount,
      errorCount: this._errorCount,
      lastError: this._lastError,
      lastErrorAt: this._lastErrorAt,
      startedAt: this._startedAt,
    };
  }

  // Helper for subclasses to track delivery
  protected _trackDelivery(result: DeliveryResult): void {
    this._messageCount++;
    if (!result.success) {
      this._errorCount++;
      this._lastError = result.error;
      this._lastErrorAt = new Date().toISOString();
    }
  }
}
```

**What the base class does NOT do:**

- Does not make HTTP requests (those belong to the concrete adapter)
- Does not own external connections (the subclass manages the lifecycle)
- Does not implement any delivery logic (purely tracking state)
- Does not silence exceptions (re-throws so the registry can isolate them)

This matches the Obsidian `Component` → `Plugin` pattern exactly: `Component` owns lifecycle bookkeeping (register, unregister, clean up on unload), `Plugin` owns plugin-specific APIs (commands, settings, ribbon icons), user plugin owns business logic.

---

### 6. Testing Utilities for Plugin Authors

**The `abstract-blob-store` / `abstract-winston-transport` pattern is the gold standard.**

Both packages export a test suite that third-party implementors can run against their implementations. The insight: "Publishing a test suite as a module lets multiple modules all ensure compatibility since they use the same test suite." Over 17 blob store implementations validate against identical tests.

`abstract-winston-transport` goes further: it provides both a test suite AND a compile-time interface, so adapter authors get both static type checking AND behavioral validation.

**What the DorkOS relay adapter compliance suite should look like:**

````typescript
// @dorkos/relay/testing — a sub-export from the relay package
// (or @dorkos/relay-test-utils as a separate lightweight package)

/**
 * Run the relay adapter compliance suite against your adapter.
 *
 * Usage in your vitest test file:
 * ```
 * import { runAdapterComplianceSuite } from '@dorkos/relay/testing';
 * import createMyAdapter from '../src/index.js';
 *
 * runAdapterComplianceSuite({
 *   create: () => createMyAdapter({ token: 'test-token' }),
 *   destroy: (adapter) => adapter.stop(),
 * });
 * ```
 */
export function runAdapterComplianceSuite(options: {
  create: () => RelayAdapter;
  destroy?: (adapter: RelayAdapter) => Promise<void>;
}): void;
````

**What the suite tests:**

1. **Shape compliance** — all required members present and callable (mirrors `validateAdapterShape`)
2. **`start()` idempotency** — calling `start()` twice does not throw or start two connections
3. **`stop()` idempotency** — calling `stop()` twice does not throw
4. **`stop()` without `start()`** — should not throw (defensive shutdown)
5. **`getStatus()` after start** — returns an object with `state`, `messageCount`, `errorCount`
6. **`deliver()` returns DeliveryResult shape** — `{ success: boolean }` always present
7. **`deliver()` error case** — when delivery fails, returns `{ success: false, error: string }`
8. **`getStatus()` after failed deliver** — `errorCount` is incremented
9. **`testConnection()` when present** — returns `{ ok: boolean }` without starting polling loops

**Template test file for adapter authors:**

```typescript
// __tests__/compliance.test.ts — pre-generated in the starter template
import { describe } from 'vitest';
import { runAdapterComplianceSuite } from '@dorkos/relay/testing';
import createMyAdapter from '../src/index.js';

describe('MyAdapter compliance', () => {
  runAdapterComplianceSuite({
    create: () =>
      createMyAdapter({
        // Test credentials — use environment variables in CI
        token: process.env.MY_ADAPTER_TEST_TOKEN ?? 'test-token',
      }),
  });
});
```

**Mock RelayPublisher for testing:**

```typescript
// Exported from @dorkos/relay/testing
export function createMockRelayPublisher(): RelayPublisher & {
  published: Array<{ subject: string; payload: unknown; options: PublishOptions }>;
  signalHandlers: Map<string, SignalHandler>;
} {
  const published: Array<...> = [];
  const signalHandlers = new Map<string, SignalHandler>();
  return {
    published,
    signalHandlers,
    async publish(subject, payload, options) {
      published.push({ subject, payload, options });
      return { messageId: `test-${Date.now()}`, deliveredTo: 1 };
    },
    onSignal(pattern, handler) {
      signalHandlers.set(pattern, handler);
      return () => signalHandlers.delete(pattern);
    },
  };
}
```

**Why this matters for third-party authors:**

Without a compliance suite, every adapter author must independently discover and implement the same set of edge cases (idempotency, error shape, status tracking). With a suite, the pattern is: "Does your adapter pass the tests? Then it will work in DorkOS." This is the message of `abstract-blob-store` — it gives a clear, testable definition of what "implementing the interface" actually means at runtime.

---

## Detailed Analysis

### The Abstract Base Class Decision for Relay Adapters

The question "should we have a `BaseRelayAdapter`?" comes down to: what is the non-trivial shared behavior the host can legitimately provide?

For relay adapters, three things qualify:

**1. Status tracking state machine**
Every adapter needs `messageCount`, `errorCount`, `lastError`, `lastErrorAt`, `startedAt`, and a `state` enum. This is identical boilerplate. The base class owns this with `_trackDelivery(result)` as the opt-in hook for subclasses.

**2. Idempotency guards**
`start()` must be safe to call twice. `stop()` must be safe to call before `start()`. The pattern is always:

```typescript
if (this._started) return;
this._started = true;
```

This belongs in the base class, not in every adapter.

**3. Lifecycle event emission**
Emitting `adapter.started`, `adapter.stopped`, `adapter.error` events on the host event bus — this is cross-cutting infrastructure, not adapter-specific logic.

**What does NOT belong in the base class:**

- Any retry logic — retry policy belongs to `AdapterRegistry`
- Any delivery buffering — that's `AdapterRegistry` territory
- Any external connection management — the subclass controls the network
- Any routing decisions — that's `RelayCore`

**The Obsidian comparison is instructive**: Obsidian's `Plugin` class provides `addCommand()`, `addSettingTab()`, `registerEvent()`. These are all "things the framework can do on behalf of the plugin" — declarative registrations with automatic cleanup. The plugin author just calls them; they don't implement them. DorkOS's `BaseRelayAdapter` should provide the same category of service: things the framework does on behalf of the adapter.

### Factory Naming: `createXxx` vs `defineXxx`

Both appear in the wild:

- `createUnplugin()` (unplugin)
- `createVitePlugin()` (Vite ecosystem)
- `defineConfig()` (Vite config)
- `definePlugin()` (some esbuild patterns)

The emerging convention in 2024–2025:

- `create*` = creates an instance of something (`createSlackAdapter`, `createWebhookAdapter`)
- `define*` = declares/registers something without creating an instance (`defineConfig`, `defineManifest`)

For adapter authors, `createSlackAdapter(config)` is the right shape. It creates an adapter instance. The word "create" signals that this function returns something new each time it is called.

### The `name` Property Requirement

Every major plugin system requires a `name` or `id` property on the plugin object:

- Rollup: `name` is required for error messages
- Vite: same (`name` is mandatory, used in warnings)
- Elysia: `name` on the instance for deduplication
- unplugin: `name` in the plugin object

For DorkOS, `id` on `RelayAdapter` serves this role and is already well-established. The adapter's `id` is used in logging, the registry map key, hot-reload targeting, and trace spans. This is correct.

### VS Code Extension API Process vs DorkOS Adapter API Process

VS Code's three-stage model is instructive:

1. **Proposed API** (in vscode.proposed.X.d.ts): available in Insiders only, cannot be published, can break anytime
2. **Experimental stable** (in stable, but flagged): available to all, but explicitly not covered by the stability guarantee
3. **Stable API** (committed): backward-compatible guarantee

For DorkOS adapters, a simpler two-stage model suffices:

- **Pre-1.0 / `apiVersion < "1.0.0"`**: No breaking change guarantees. Adapters built against pre-1.0 may break.
- **Post-1.0**: SemVer guarantees. Minor versions are additive. Major versions can break.

The `apiVersion` field in the manifest enables the loader to enforce this: if the host is on API `1.x` and the adapter declares `apiVersion: "0.9.0"`, the host can warn that the adapter was built before the stability guarantee.

### Fastify Plugin Encapsulation as a Model

Fastify's design has one property that's particularly valuable for relay adapters: **the `fastify-plugin` wrapper that escapes encapsulation**. In Fastify's scoped model, plugin modifications stay within the plugin's scope by default. The `fp()` wrapper makes them global.

The relay analog: some future adapters might want to contribute to the relay routing table (e.g., "I handle all subjects matching `relay.human.slack.*`") while others are instance-scoped. The current `subjectPrefix` property on `RelayAdapter` is the right escape valve — adapters declare their scope statically, and the registry respects it.

---

## Concrete Recommendations

### A. Interface + Optional Base Class (Implement This)

Keep `RelayAdapter` as the canonical interface. Add `BaseRelayAdapter` as an optional abstract class:

```typescript
// packages/relay/src/base-adapter.ts
export abstract class BaseRelayAdapter implements RelayAdapter {
  // Implements getStatus() + _trackDelivery() + start/stop idempotency
  // Does NOT implement deliver() — that stays abstract
}
```

Export from the relay package index so adapter authors can import it:

```typescript
// packages/relay/src/index.ts
export type {
  RelayAdapter,
  DeliveryResult,
  AdapterStatus,
  AdapterContext,
  RelayPublisher,
} from './types.js';
export { BaseRelayAdapter } from './base-adapter.js';
```

### B. Factory Function Export Convention (Document This)

The starter template should show this exact shape:

```typescript
// Required exports from any adapter package
export default function createMyAdapter(config: MyAdapterConfig): RelayAdapter { ... }

// Optional — improves catalog integration
export const apiVersion = '1.0.0';
export function getManifest(): AdapterManifest { ... }
export { MyAdapterConfigSchema } from './config.js'; // the Zod schema
```

The plugin loader should be updated to check for `apiVersion` as a named export in addition to the manifest.

### C. API Versioning (Implement This)

1. Export `RELAY_ADAPTER_API_VERSION` from `@dorkos/relay` (e.g., `'1.0.0'`)
2. Add `apiVersion?: string` to `AdapterManifest` in `@dorkos/shared/relay-schemas`
3. Update `adapter-plugin-loader.ts` to check the adapter's `apiVersion` against the host's version using `semver.satisfies` and log a warning on mismatch
4. Document the breaking change policy in the adapter authoring guide

### D. Compliance Test Suite (Implement This)

Create `packages/relay/src/testing/index.ts` (or a separate `packages/relay-testing` package):

- `runAdapterComplianceSuite(options)` — the main export
- `createMockRelayPublisher()` — for adapter unit tests
- `createMockRelayEnvelope(overrides?)` — returns a valid `RelayEnvelope` for testing `deliver()`

This becomes the primary quality gate for third-party adapters. "Does it pass the compliance suite?" is the answer to "does my adapter work?"

### E. Onboarding Template (Implement This)

Create a `relay-adapter-template` repository (or directory in the DorkOS monorepo under `templates/relay-adapter/`) with:

- Complete, working implementation of a minimal no-op adapter
- Compliance tests pre-wired
- `package.json` with correct keywords (`dorkos-relay-adapter`), peer deps, and build scripts
- `README.md` that covers: "1. Fill in these 4 config fields. 2. Implement \_start(), stop(), deliver(). 3. Run pnpm test. 4. Publish."

### F. Error Message Quality (Already Mostly There)

The existing `validateAdapterShape` function is good. Enhance it with:

```typescript
// More specific messages that tell plugin authors what to do
throw new Error(
  `Adapter '${id}': missing 'deliver()' method.\n` +
    `Your factory function must return an object with a deliver(subject, envelope, context?) method.\n` +
    `See: https://dorkos.dev/docs/relay/adapter-authoring`
);
```

Error messages should always link to the authoring guide. VS Code, Rollup, and Fastify all do this.

---

## Contradictions and Disputes

### Abstract Class vs Interface: The TypeScript Community Debate

The TypeScript community leans toward "prefer interfaces," with `no-extraneous-class` as a lint rule in `@typescript-eslint`. The rule warns against classes used purely as namespaces or data holders. However, the rule explicitly allows abstract classes used as templates (it is designed to catch classes with no instance-only members — abstract classes with abstract methods are intentional).

The Azure SDK guideline says: "YOU SHOULD prefer interface types to class types" — but then adds "if you find yourself constrained by this, use abstract classes instead." This is a pragmatic middle ground, not a prohibition.

**Verdict for DorkOS**: `BaseRelayAdapter` passes the "is there genuine shared behavior?" test (status tracking, idempotency). It is not an extraneous class. The lint rule should not fire.

### Factory Function vs Class Export for Adapters

Winston transports are the main counterexample — they require class extension because Node.js streams require it. Every other plugin system uses factory functions. For relay adapters, there is no stream requirement, so factory functions win.

However, some adapter authors may prefer the class style even when using `BaseRelayAdapter`:

```typescript
class SlackAdapter extends BaseRelayAdapter { ... }
// Option A: export class (author instantiates)
export default SlackAdapter;

// Option B: export factory
export default (config: SlackConfig) => new SlackAdapter(config);
```

Option B (factory) is preferable because the host's plugin loader always receives a factory — it never needs to know the class structure. The `AdapterPluginModule.default` type signature should remain `(config) => RelayAdapter`, not `new (config) => RelayAdapter`.

---

## Research Gaps and Limitations

- Specific Slack SDK / Discord SDK adapter patterns for relay-style systems were not investigated (focused on the SDK design layer, not specific integrations)
- The `compliance` npm package (bzb-stcnx) was found but is mocha-based; a vitest-specific compliance harness pattern was not found in the wild and would need to be designed fresh
- esbuild plugin patterns for declaring `apiVersion` were not investigated (esbuild plugins are typically simpler objects without versioning)
- The TypeScript server plugin versioning issue (#19224) mentioned runtime version checks but the full implementation was not reviewed

---

## Sources and Evidence

- "It is common convention to author a Vite/Rollup plugin as a factory function that returns the actual plugin object." — [Plugin API | Vite](https://vite.dev/guide/api-plugin)
- "register creates a new Fastify context" — [The hitchhiker's guide to plugins | Fastify](https://fastify.dev/docs/latest/Guides/Plugins-Guide/)
- Obsidian `Plugin extends Component` — lifecycle hooks, `register()`, auto-cleanup — [Plugin Development | Obsidian DeepWiki](https://deepwiki.com/obsidianmd/obsidian-api/3-plugin-development)
- Winston: `abstract-winston-transport` — test suite + interface — [abstract-winston-transport | GitHub](https://github.com/winstonjs/abstract-winston-transport)
- `abstract-blob-store` compliance pattern — [abstract-blob-store | GitHub](https://github.com/max-mapper/abstract-blob-store)
- "OpenTelemetry implementations MUST NOT throw unhandled exceptions at run time." — [Error handling in OpenTelemetry](https://opentelemetry.io/docs/specs/otel/error-handling/)
- "API methods that accept external callbacks MUST handle all errors." — [OpenTelemetry Error Handling Spec](https://opentelemetry.io/docs/specs/otel/error-handling/)
- VS Code `engines.vscode` versioning — [Publishing Extensions | VS Code](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- Figma `"api"` manifest field + major version support — [Plugin Manifest | Figma](https://developers.figma.com/docs/plugins/manifest/)
- Obsidian `minAppVersion` + `requireApiVersion()` — [Manifest | Obsidian Developer Docs](https://docs.obsidian.md/Reference/Manifest)
- unplugin `createUnplugin` factory pattern — [Getting Started | Unplugin](https://unplugin.unjs.io/guide/)
- Rollup plugin `name` required, factory function convention — [Plugin Development | Rollup](https://rollupjs.org/plugin-development/)
- Azure SDK: "YOU SHOULD prefer interface types to class types" — [TypeScript Guidelines | Azure SDK](https://azure.github.io/azure-sdk/typescript_design.html)
- Elysia plugin `name`+`seed` deduplication, factory via `.use()` — [Plugin | ElysiaJS](https://elysiajs.com/essential/plugin)
- tRPC adapters: `createContext`, `onError` conventions — [Adapters Overview | tRPC](https://trpc.io/docs/server/adapters)
- When to use abstract classes in TypeScript — [When to Use TypeScript Abstract Classes | Khalil Stemmler](https://khalilstemmler.com/blogs/typescript/abstract-class/)
- "Avoid cross-package class extension" — [Azure SDK TypeScript Guidelines](https://azure.github.io/azure-sdk/typescript_design.html)
- bzb-stcnx compliance test pattern — [compliance | GitHub](https://github.com/bzb-stcnx/compliance)

---

## Search Methodology

- Searches performed: 18 web searches + 12 web fetches
- Most productive search terms: "abstract base class plugin anti-patterns typescript inheritance", "abstract-blob-store compliance test suite", "socket.io adapter abstract class", "winston transport adapter abstract class", "unplugin createUnplugin factory", "OpenTelemetry plugin SDK error handling"
- Primary domains: vite.dev, rollupjs.org, fastify.dev, opentelemetry.io, obsidian.md, figma.com, elysiajs.com, trpc.io, github.com
