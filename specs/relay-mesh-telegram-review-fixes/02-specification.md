---
slug: relay-mesh-telegram-review-fixes
number: 73
created: 2026-02-28
status: specified
---

# Specification: Relay, Mesh & Telegram Adapter — Code Review Remediation

## Overview

Fix 18 issues (3 critical, 8 important, 3 UI, 1 structural, 3 drive-bys) identified in a comprehensive code review of the Relay subsystem, Mesh topology UI, and Telegram adapter. Also split `relay-core.ts` (1028 lines) into focused modules. All issues were verified at exact line numbers against current HEAD.

**Scope:** Critical + Important severity only. Tests for changed code only. No backfilling unrelated test gaps.

## Technical Design

### Phase 1: Relay Core Split (S1)

Split `packages/relay/src/relay-core.ts` (1028 lines) into 4 files. Public API remains identical — this is a pure internal refactoring.

**New files:**

| File | Extracted From | Lines | Responsibility |
|------|---------------|-------|----------------|
| `packages/relay/src/delivery-pipeline.ts` | `deliverToEndpoint()`, `dispatchToSubscribers()` | ~170 | Endpoint delivery with backpressure, circuit breaker, budget enforcement, subscriber dispatch |
| `packages/relay/src/adapter-delivery.ts` | `deliverToAdapter()` | ~60 | Adapter routing, timeout management, audit trail indexing |
| `packages/relay/src/watcher-manager.ts` | `startWatcher()`, `handleNewMessage()`, `stopWatcher()` | ~95 | chokidar file watcher lifecycle for maildir endpoints |

**`relay-core.ts` after split:** ~450 lines (within 300-500 guideline). Retains constructor, `publish()` orchestration, subscription/signal delegation, endpoint management facade, access control delegation, config hot-reload, `close()`, and `assertOpen()`.

**Dependency injection pattern:**

```typescript
// delivery-pipeline.ts
export class DeliveryPipeline {
  constructor(
    private sqliteIndex: SqliteIndex,
    private maildirStore: MaildirStore,
    private subscriptionRegistry: SubscriptionRegistry,
    private circuitBreaker: CircuitBreakerManager,
    private backpressureConfig: BackpressureConfig,
    private signalEmitter: SignalEmitter,
    private deadLetterQueue: DeadLetterQueue,
  ) {}

  async deliverToEndpoint(endpoint: EndpointInfo, envelope: RelayEnvelope): Promise<EndpointDeliveryResult> { ... }
  async dispatchToSubscribers(endpoint: EndpointInfo, messageId: string, envelope: RelayEnvelope): Promise<void> { ... }
}

// adapter-delivery.ts
export class AdapterDelivery {
  static readonly TIMEOUT_MS = 30_000;

  constructor(
    private adapterRegistry: AdapterRegistryLike | undefined,
    private sqliteIndex: SqliteIndex,
  ) {}

  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    contextBuilder?: (subject: string) => AdapterContext | undefined,
  ): Promise<DeliveryResult | null> { ... }
}

// watcher-manager.ts
export class WatcherManager {
  private watchers = new Map<string, FSWatcher>();

  constructor(
    private maildirStore: MaildirStore,
    private subscriptionRegistry: SubscriptionRegistry,
    private sqliteIndex: SqliteIndex,
    private circuitBreaker: CircuitBreakerManager,
  ) {}

  async startWatcher(endpoint: EndpointInfo): Promise<void> { ... }
  stopWatcher(endpointHash: string): void { ... }
  async closeAll(): Promise<void> { ... }
}
```

**RelayCore composes them in constructor:**

```typescript
this.deliveryPipeline = new DeliveryPipeline(
  this.sqliteIndex, this.maildirStore, this.subscriptionRegistry,
  this.circuitBreaker, backpressureConfig, this.signalEmitter, this.deadLetterQueue,
);
this.adapterDelivery = new AdapterDelivery(this.adapterRegistry, this.sqliteIndex);
this.watcherManager = new WatcherManager(
  this.maildirStore, this.subscriptionRegistry, this.sqliteIndex, this.circuitBreaker,
);
```

**Move `EndpointDeliveryResult` type** to `delivery-pipeline.ts` (only consumer).

**Update `packages/relay/src/index.ts`**: No changes needed — only `RelayCore` and `PublishResult` are exported. The new classes are internal implementation details.

### Phase 2: Relay Bug Fixes (C1, C2, I1, I2, I3, I4, I5, I6, D1, D2)

#### C1: Race condition in `getOrCreateSession()` — `binding-router.ts:151-158`

Add per-key in-flight promise map to deduplicate concurrent session creation:

```typescript
private inFlight = new Map<string, Promise<string>>();

private async getOrCreateSession(key: string, binding: AdapterBinding): Promise<string> {
  const existing = this.sessionMap.get(key);
  if (existing) return existing;

  const pending = this.inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const sessionId = await this.createNewSession(binding);
    this.sessionMap.set(key, sessionId);
    this.inFlight.delete(key);
    await this.saveSessionMap();
    return sessionId;
  })();

  this.inFlight.set(key, promise);
  return promise;
}
```

#### C2: Unhandled error in `handleInbound()` — `binding-router.ts:96-122`

Wrap entire method body in try/catch:

```typescript
private async handleInbound(envelope: RelayEnvelope): Promise<void> {
  try {
    // ... existing logic ...
  } catch (err) {
    console.error(
      `BindingRouter: failed to route ${envelope.subject}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
```

#### I1: Timer leak in `deliverToAdapter()` — `relay-core.ts:816-824` (moves to `adapter-delivery.ts`)

```typescript
async deliver(...): Promise<DeliveryResult | null> {
  // ...
  let timer: NodeJS.Timeout;
  try {
    const result = await Promise.race([
      deliveryPromise,
      new Promise<DeliveryResult>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('adapter delivery timeout (30s)')),
          AdapterDelivery.TIMEOUT_MS,
        );
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timer!);
  }
}
```

#### I2: Timer leak in `testConnection()` — `adapter-manager.ts:386-394`

Same pattern:

```typescript
let timer: NodeJS.Timeout;
try {
  return await Promise.race([
    adapter.testConnection(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Connection test timed out')),
        CONNECTION_TEST_TIMEOUT_MS,
      );
    }),
  ]);
} finally {
  clearTimeout(timer!);
}
```

#### I3: `console.warn` instead of logger — `relay-core.ts:843` (moves to `adapter-delivery.ts`)

Replace `console.warn(...)` with a configurable logger or structured console call. Since `packages/relay` is a standalone library without access to the server's logger, use a simple pattern:

```typescript
// In adapter-delivery.ts constructor, accept optional logger
constructor(
  private adapterRegistry: AdapterRegistryLike | undefined,
  private sqliteIndex: SqliteIndex,
  private logger: { warn: (...args: unknown[]) => void } = console,
) {}
```

This allows the server to inject its structured logger while keeping the package dependency-free.

#### I4: Dynamic import of `hashSubject` in hot paths — `relay-core.ts:360, 828`

Move to static top-level import in the files that need it:

```typescript
// In relay-core.ts (for publish path)
import { EndpointRegistry, hashSubject } from './endpoint-registry.js';

// In adapter-delivery.ts (for adapter delivery path)
import { hashSubject } from './endpoint-registry.js';
```

Remove the two `await import('./endpoint-registry.js')` calls.

#### I5: Non-atomic `saveConfig()` — `adapter-manager.ts:621-628`

Use tmp+rename pattern consistent with BindingStore:

```typescript
private async saveConfig(): Promise<void> {
  await mkdir(dirname(this.configPath), { recursive: true });
  const tmpPath = `${this.configPath}.tmp`;
  await writeFile(
    tmpPath,
    JSON.stringify({ adapters: this.configs }, null, 2),
    'utf-8',
  );
  await rename(tmpPath, this.configPath);
}
```

Add `import { rename } from 'node:fs/promises'` if not already imported.

#### I6: Unbounded sessionMap growth — `binding-router.ts:53`

Add a configurable max-size with LRU eviction. When the map exceeds the limit, evict the oldest entries (by insertion order — `Map` preserves insertion order):

```typescript
private static readonly MAX_SESSIONS = 10_000;

private evictOldestSessions(): void {
  const excess = this.sessionMap.size - BindingRouter.MAX_SESSIONS;
  if (excess <= 0) return;
  const keys = this.sessionMap.keys();
  for (let i = 0; i < excess; i++) {
    const { value } = keys.next();
    if (value) this.sessionMap.delete(value);
  }
}
```

Call `this.evictOldestSessions()` after `this.sessionMap.set(key, sessionId)` in `getOrCreateSession()`.

#### D1: Rename `agentId` to `sessionId` — `adapter-manager.ts:330`

```typescript
const segments = subject.split('.');
const sessionId = segments[2]; // relay.agent.{sessionId}
if (!sessionId) return undefined;
```

Update all references within `buildContext()`.

#### D2: Extract `defaultAdapterStatus()` — `adapter-manager.ts:250-256, 280-284`

```typescript
function defaultAdapterStatus(): AdapterStatus {
  return {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };
}
```

Replace both occurrences with `adapter?.getStatus() ?? defaultAdapterStatus()`.

### Phase 3: Telegram Adapter Fixes (C3, I7, I8, D3, D4)

#### C3: Webhook missing secret token — `telegram-adapter.ts:480-500`

**Schema changes** (`packages/shared/src/relay-schemas.ts`):

```typescript
export const TelegramAdapterConfigSchema = z
  .object({
    token: z.string().min(1),
    mode: z.enum(['polling', 'webhook']).default('polling'),
    webhookUrl: z.string().url().optional(),
    webhookPort: z.number().int().positive().optional(),
    webhookSecret: z.string().min(1).optional(),
  })
  .openapi('TelegramAdapterConfig');
```

**Type changes** (`packages/relay/src/types.ts`):

```typescript
export interface TelegramAdapterConfig {
  token: string;
  mode: 'polling' | 'webhook';
  webhookUrl?: string;
  webhookPort?: number;
  webhookSecret?: string;
}
```

**Manifest changes** (`telegram-adapter.ts` TELEGRAM_MANIFEST):

Add config field:
```typescript
{
  key: 'webhookSecret',
  label: 'Webhook Secret',
  type: 'password',
  required: false,
  placeholder: 'Auto-generated if empty',
  description: 'Secret token for validating incoming webhook requests from Telegram.',
  showWhen: { field: 'mode', equals: 'webhook' },
}
```

**Implementation** (`telegram-adapter.ts` `startWebhookMode()`):

```typescript
private async startWebhookMode(webhookUrl: string, webhookPort: number): Promise<void> {
  // Auto-generate secret if not provided
  const secret = this.config.webhookSecret ?? crypto.randomUUID();

  await this.bot!.api.setWebhook(webhookUrl, { secret_token: secret });

  const handler = webhookCallback(this.bot!, 'http', { secretToken: secret });
  // ... rest of server setup
}
```

#### I7: No reconnection logic for polling — `telegram-adapter.ts:454-469`

Add exponential backoff reconnection:

```typescript
private static readonly RECONNECT_DELAYS = [5_000, 10_000, 30_000, 60_000, 60_000];
private reconnectAttempts = 0;

private async startPollingMode(): Promise<void> {
  // ... existing init ...
  this.bot!.start({
    drop_pending_updates: true,
    onStart: () => {
      this.reconnectAttempts = 0; // Reset on successful connection
      // ... existing status update
    },
  }).catch((err) => this.handlePollingError(err));
}

private handlePollingError(err: unknown): void {
  this.recordError(err instanceof Error ? err : new Error(String(err)));

  if (this.reconnectAttempts >= TelegramAdapter.RECONNECT_DELAYS.length) {
    console.error('TelegramAdapter: max reconnection attempts reached, giving up');
    return;
  }

  const delay = TelegramAdapter.RECONNECT_DELAYS[this.reconnectAttempts]!;
  this.reconnectAttempts++;

  console.warn(`TelegramAdapter: reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
  setTimeout(() => {
    if (this.status.state === 'disconnected') return; // Stopped externally
    this.startPollingMode().catch((e) => this.handlePollingError(e));
  }, delay);
}
```

#### I8: Webhook server no timeout/size limits — `telegram-adapter.ts:493-499`

Harden the HTTP server:

```typescript
const server = createServer(handler);
server.headersTimeout = 10_000;     // 10s for headers
server.requestTimeout = 30_000;     // 30s total request
server.maxHeadersCount = 50;        // Limit header count
server.keepAliveTimeout = 5_000;    // 5s keep-alive
```

#### D3: `startedAt` not cleared on stop — `telegram-adapter.ts:347-349`

In the `stop()` finally block:

```typescript
this.status = {
  state: 'disconnected',
  messageCount: this.status.messageCount,
  errorCount: this.status.errorCount,
  // startedAt intentionally omitted — cleared on stop
};
```

#### D4: No input length validation — `telegram-adapter.ts:532-558`

Cap inbound content at 32KB:

```typescript
private static readonly MAX_CONTENT_LENGTH = 32_768;

private handleInboundMessage(message: TelegramMessage): void {
  const rawText = message.text ?? message.caption ?? '';
  const text = rawText.slice(0, TelegramAdapter.MAX_CONTENT_LENGTH);
  // ... rest of handler
}
```

### Phase 4: Mesh UI Fixes (U1, U2, U3)

#### U1: Unsafe type casts in TopologyGraph — `TopologyGraph.tsx:378-429`

The shared schema already defines `TopologyAgentSchema` with all enrichment fields (`healthStatus`, `relayAdapters`, `relaySubject`, `pulseScheduleCount`, `lastSeenAt`, `lastSeenEvent`). The `NamespaceInfoSchema` already references `TopologyAgentSchema`.

**Fix:** Import and use the `TopologyAgent` type from `@dorkos/shared/mesh-schemas` in TopologyGraph. Replace all `Record<string, unknown>` casts with direct typed field access:

```typescript
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';

// Before (unsafe):
const enriched = agent as Record<string, unknown>;
healthStatus: (enriched.healthStatus as AgentNodeData['healthStatus']) ?? 'stale',

// After (type-safe):
const typedAgent = agent as TopologyAgent;
healthStatus: typedAgent.healthStatus ?? 'stale',
```

Also fix the `handleConnect` casts at lines 562-563:

```typescript
// Before:
const sourceData = sourceNode.data as unknown as AdapterNodeData;
// After:
const sourceData = sourceNode.data as AdapterNodeData;
```

#### U2: Missing `type="button"` — `TopologyGraph.tsx:206, 626`

Add `type="button"` to both the "Go to Discovery" button (line 206) and the "Retry" button (line 626):

```tsx
<button type="button" onClick={onGoToDiscovery} className="...">
<button type="button" onClick={() => refetch()} className="...">
```

#### U3: Inline `<style>` tag — `TopologyGraph.tsx:655-690`

Extract the inline styles to a new CSS file:

**Create `apps/client/src/layers/features/mesh/ui/topology-graph.css`:**

```css
/* React Flow topology graph custom styles */
.topology-graph {
  --xy-background-color: var(--color-background);
  --xy-node-border-radius: 8px;
  --xy-edge-stroke: var(--color-border);
  --xy-edge-stroke-width: 1.5;
}

/* ... remaining styles from the inline block */

@keyframes pulse-glow { /* ... */ }
```

**In TopologyGraph.tsx:** Replace the `<style>` JSX element with an import:

```typescript
import './topology-graph.css';
```

## Testing Requirements

Tests cover changed code only — no backfilling.

### New tests for binding-router:

| Test | Covers |
|------|--------|
| `handleInbound` catches and logs errors when `publish()` throws | C2 |
| `getOrCreateSession` deduplicates concurrent calls for same key | C1 |
| Session map eviction when exceeding MAX_SESSIONS | I6 |

### Updated tests for relay-core split:

| Test | Covers |
|------|--------|
| Existing relay-core tests pass with updated imports | S1 |
| `DeliveryPipeline.deliverToEndpoint()` unit test | S1 |
| `AdapterDelivery.deliver()` clears timer on success | I1 |

### Updated tests for adapter-manager:

| Test | Covers |
|------|--------|
| `testConnection` clears timer on success | I2 |
| `saveConfig` uses atomic write (tmp file created, renamed) | I5 |

### New tests for telegram-adapter:

| Test | Covers |
|------|--------|
| Webhook mode passes secret_token to setWebhook and webhookCallback | C3 |
| Polling reconnection with exponential backoff | I7 |
| Inbound message content capped at MAX_CONTENT_LENGTH | D4 |

## Implementation Phases

Execute in this order to minimize risk:

| Phase | Issues | Files | Risk |
|-------|--------|-------|------|
| 1. Relay Core Split | S1 | `relay-core.ts` → 4 files | Medium (many internal changes, but public API stable) |
| 2. Relay Bug Fixes | C1, C2, I1-I6, D1, D2 | `binding-router.ts`, `adapter-manager.ts`, extracted files | Low (isolated fixes) |
| 3. Telegram Fixes | C3, I7, I8, D3, D4 | `telegram-adapter.ts`, `relay-schemas.ts`, `types.ts` | Low (isolated adapter) |
| 4. Mesh UI Fixes | U1, U2, U3 | `TopologyGraph.tsx`, new CSS file | Low (UI-only, no server changes) |

## Acceptance Criteria

- All 18 issues addressed per the fix descriptions above
- `relay-core.ts` reduced from 1028 to ~450 lines
- Public API of `RelayCore` unchanged (no consumer import changes outside `packages/relay/`)
- All existing tests pass after split
- New tests cover changed code paths
- `pnpm typecheck` passes
- `pnpm lint` passes
- No regressions in relay message delivery or mesh topology rendering

## Out of Scope

- AgentNode DefaultCard/ExpandedCard deduplication
- `useLodBand` hysteresis buffer
- `relativeTime` extraction to shared lib
- BindingEdge hover mechanism refactor
- `edited_message` / `channel_post` Telegram handlers
- Test backfill for untouched code (AgentNode, AdapterNode compact LOD, BindingEdge hover)
- TopologyGraph file split (763 lines — defer to separate pass since UI files have different split patterns than service code)
