---
slug: relay-mesh-telegram-review-fixes-r2
number: 74
created: 2026-02-28
status: specified
---

# Specification: Relay, Mesh & Telegram Adapter — Code Review Remediation Round 2

## Overview

Fix 16 issues (6 critical, 10 important) from a second-round code review. This follows spec #73 and addresses bugs in the current code including issues introduced by the spec #73 implementation (reconnection logic). Scope: Critical + Important severity only.

**Scope:** 16 issues across Telegram adapter (5), Relay subsystem (4), and Mesh UI/Transport (7). Tests for changed code only. No backfilling unrelated test gaps.

## Technical Design

### Phase 1: Telegram Adapter Fixes (C1, C2, I1, I2, I3)

**File:** `packages/relay/src/adapters/telegram-adapter.ts`

#### C1: Stop old bot before reconnection — line 512-524

The `handlePollingError()` reconnection path creates a new `Bot` instance and assigns it to `this.bot` (line 521) without first calling `this.bot.stop()` on the old one. This leaks the previous grammy polling loop.

**Before** (`handlePollingError`, lines 512-524):

```typescript
setTimeout(() => {
  // If the adapter was stopped externally, do not reconnect
  if (this.status.state === 'disconnected') return;

  // Create a fresh bot instance for the reconnection attempt
  const newBot = new Bot(this.config.token);
  newBot.api.config.use(autoRetry());
  newBot.on('message', (ctx) => this.handleInboundMessage(ctx));
  newBot.catch((e) => this.recordError(e));
  this.bot = newBot;

  this.startPollingMode(newBot).catch((e) => this.handlePollingError(e));
}, delay);
```

**After:**

```typescript
this.reconnectTimer = setTimeout(async () => {
  // If the adapter was stopped externally or is stopping, do not reconnect
  if (this.status.state === 'disconnected' || this.status.state === 'stopping') return;

  // Stop the old bot before creating a replacement
  try {
    await this.bot?.stop();
  } catch {
    // Swallow — old bot is likely already dead
  }

  // Create a fresh bot instance for the reconnection attempt
  const newBot = new Bot(this.config.token);
  newBot.api.config.use(autoRetry());
  newBot.on('message', (ctx) => this.handleInboundMessage(ctx));
  newBot.catch((e) => this.recordError(e));
  this.bot = newBot;

  this.startPollingMode(newBot).catch((e) => this.handlePollingError(e));
}, delay);
```

#### C2: Track reconnect timer for cancellation — line 512

The `setTimeout` return value from `handlePollingError()` is discarded. If `stop()` is called during the delay window, the timer fires after the adapter is stopped and creates a zombie polling loop. Additionally, the reconnect guard (line 514) only checks `'disconnected'` but `stop()` transitions through `'stopping'` first.

**Add class field:**

```typescript
/** Pending reconnection timer — cleared in stop(). */
private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
```

**Update `stop()`** (line 345-369) — add timer cancellation before unsubscribing signals:

```typescript
async stop(): Promise<void> {
  if (this.bot === null) return; // Already stopped

  this.status = { ...this.status, state: 'stopping' };

  // Cancel any pending reconnection timer
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // Unsubscribe from relay signals before stopping the bot
  // ... rest unchanged
```

**Update reconnect guard** in the timer callback (C1 change above) to also check `'stopping'` state:

```typescript
if (this.status.state === 'disconnected' || this.status.state === 'stopping') return;
```

#### I1: Webhook error handler leak — lines 563-566

`server.on('error', reject)` registers a persistent error handler that is never removed. After the server starts successfully, subsequent `'error'` events invoke a stale `reject` on a resolved promise.

**Before:**

```typescript
await new Promise<void>((resolve, reject) => {
  server.listen(port, resolve);
  server.on('error', reject);
});
```

**After:**

```typescript
await new Promise<void>((resolve, reject) => {
  server.listen(port, resolve);
  server.once('error', reject);
});
```

Using `once` ensures the handler is automatically removed after the first error event fires (or after the server starts successfully and no error occurs during listen).

#### I2: Destroy keep-alive connections in `stopWebhookServer` — lines 572-579

`server.close()` only stops accepting new connections. Existing keep-alive connections (Telegram may reuse connections) keep the server alive indefinitely.

**Before:**

```typescript
private async stopWebhookServer(): Promise<void> {
  if (!this.webhookServer) return;
  const server = this.webhookServer;
  this.webhookServer = null;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
```

**After:**

```typescript
private async stopWebhookServer(): Promise<void> {
  if (!this.webhookServer) return;
  const server = this.webhookServer;
  this.webhookServer = null;

  // Destroy keep-alive connections so close() completes promptly
  server.closeAllConnections();

  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
```

`server.closeAllConnections()` (Node.js 18.2+) sends RST to all tracked connections, allowing `close()` to complete immediately.

#### I3: Reject float chat IDs — lines 80-96

`extractChatId()` accepts floats like `123.456` because `Number.isFinite()` passes for them. Telegram chat IDs are always integers.

**Before** (lines 89-95):

```typescript
// Group format: group.{chatId}
if (remainder.startsWith(`${GROUP_SEGMENT}.`)) {
  const idStr = remainder.slice(GROUP_SEGMENT.length + 1);
  const id = Number(idStr);
  return Number.isFinite(id) ? id : null;
}

// DM format: {chatId}
const id = Number(remainder);
return Number.isFinite(id) ? id : null;
```

**After:**

```typescript
// Group format: group.{chatId}
if (remainder.startsWith(`${GROUP_SEGMENT}.`)) {
  const idStr = remainder.slice(GROUP_SEGMENT.length + 1);
  const id = Number(idStr);
  return Number.isInteger(id) ? id : null;
}

// DM format: {chatId}
const id = Number(remainder);
return Number.isInteger(id) ? id : null;
```

### Phase 2: Relay Fixes (C3, C4, I4, I5, I6)

#### C3: Fix `BindingStore.skipNextReload` race — `binding-store.ts:44,182-205`

The `skipNextReload` boolean flag is consumed by the first chokidar `'change'` event regardless of whether it corresponds to the save that set it. If two rapid saves overlap, the first chokidar event consumes the flag and the second triggers a spurious reload.

**Fix:** Replace the boolean with a generation counter. Increment on each save, snapshot the value before save, and only skip the reload if the generation hasn't advanced further.

**Before** (lines 43-44, 181-205):

```typescript
/** Guard to skip reload when we just wrote the file ourselves. */
private skipNextReload = false;

// In save():
private async save(): Promise<void> {
  this.skipNextReload = true;
  const data = { bindings: this.getAll() };
  await mkdir(dirname(this.filePath), { recursive: true });
  const tmpPath = `${this.filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, this.filePath);
}

// In watch():
private watch(): void {
  this.watcher = chokidar.watch(this.filePath, {
    awaitWriteFinish: {
      stabilityThreshold: STABILITY_THRESHOLD_MS,
      pollInterval: POLL_INTERVAL_MS,
    },
  });
  this.watcher.on('change', async () => {
    if (this.skipNextReload) {
      this.skipNextReload = false;
      return;
    }
    logger.info('bindings.json changed on disk, reloading');
    await this.load();
  });
}
```

**After:**

```typescript
/**
 * Generation counter for skip-reload coordination.
 * Incremented on each save; chokidar handler skips reload when it
 * sees a generation it hasn't processed yet from our own writes.
 */
private saveGeneration = 0;
private lastReloadedGeneration = 0;

// In save():
private async save(): Promise<void> {
  this.saveGeneration++;
  const data = { bindings: this.getAll() };
  await mkdir(dirname(this.filePath), { recursive: true });
  const tmpPath = `${this.filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, this.filePath);
}

// In watch():
private watch(): void {
  this.watcher = chokidar.watch(this.filePath, {
    awaitWriteFinish: {
      stabilityThreshold: STABILITY_THRESHOLD_MS,
      pollInterval: POLL_INTERVAL_MS,
    },
  });
  this.watcher.on('change', async () => {
    if (this.lastReloadedGeneration < this.saveGeneration) {
      // This change was triggered by our own save — skip reload
      this.lastReloadedGeneration = this.saveGeneration;
      return;
    }
    logger.info('bindings.json changed on disk, reloading');
    await this.load();
  });
}
```

This is safe because: (1) generation only increases, (2) each save bumps it by exactly 1, and (3) the chokidar handler catches up to the current generation on each own-write event. Multiple overlapping saves will each bump the counter, and multiple chokidar events will each skip until `lastReloadedGeneration` catches up.

#### C4: Prevent duplicate dispatch — `delivery-pipeline.ts` + `watcher-manager.ts`

When `DeliveryPipeline.dispatchToSubscribers()` (line 170) claims and dispatches a message, the file move from `new/` to `cur/` may trigger `WatcherManager.handleNewMessage()` (line 100) before the claim completes, causing a race where both attempt to claim the same message. While `claim()` is atomic (only one succeeds), handler side effects may not be idempotent, and the failed claim generates unnecessary I/O.

**Fix:** Add a `recentlyDispatched` set to `DeliveryPipeline` that tracks message IDs dispatched via the synchronous fast-path. Pass this set to `WatcherManager` via constructor so the watcher can skip messages already handled by the pipeline.

**In `delivery-pipeline.ts`:**

```typescript
export class DeliveryPipeline {
  /** Message IDs recently dispatched via the synchronous fast-path. */
  private readonly recentlyDispatched = new Set<string>();

  // ... existing constructor ...

  /** Check whether a message was already dispatched by this pipeline. */
  wasDispatched(messageId: string): boolean {
    return this.recentlyDispatched.has(messageId);
  }

  async dispatchToSubscribers(
    endpoint: EndpointInfo,
    messageId: string,
    envelope: RelayEnvelope
  ): Promise<void> {
    const handlers = this.deps.subscriptionRegistry.getSubscribers(endpoint.subject);
    if (handlers.length === 0) return;

    // Mark as dispatched before claiming so the watcher can skip it
    this.recentlyDispatched.add(messageId);

    // Cap the set size to prevent unbounded growth
    if (this.recentlyDispatched.size > 10_000) {
      const oldest = this.recentlyDispatched.values().next().value;
      if (oldest) this.recentlyDispatched.delete(oldest);
    }

    // Claim the message (move from new/ to cur/)
    const claimResult = await this.deps.maildirStore.claim(endpoint.hash, messageId);
    if (!claimResult.ok) return;
    // ... rest unchanged
  }
}
```

**In `watcher-manager.ts`:**

Update the constructor to accept a `DeliveryPipeline` reference (or a `wasDispatched` callback to avoid circular dependency):

```typescript
export class WatcherManager {
  private readonly watchers = new Map<string, FSWatcher>();

  constructor(
    private readonly maildirStore: MaildirStore,
    private readonly subscriptionRegistry: SubscriptionRegistry,
    private readonly sqliteIndex: SqliteIndex,
    private readonly circuitBreaker: CircuitBreakerManager,
    private readonly wasDispatched?: (messageId: string) => boolean
  ) {}

  // In handleNewMessage():
  private async handleNewMessage(endpoint: EndpointInfo, filePath: string): Promise<void> {
    const filename = path.basename(filePath);
    if (!filename.endsWith('.json')) return;
    const messageId = filename.slice(0, -5);

    // Skip messages already dispatched by the synchronous pipeline fast-path
    if (this.wasDispatched?.(messageId)) return;

    // ... rest unchanged
  }
}
```

**In `relay-core.ts`** — update the `WatcherManager` construction (line 214-219):

```typescript
this.watcherManager = new WatcherManager(
  this.maildirStore,
  this.subscriptionRegistry,
  this.sqliteIndex,
  this.circuitBreaker,
  (messageId) => this.deliveryPipeline.wasDispatched(messageId)
);
```

#### I4: Add Zod validation to adapter routes — `routes/relay.ts:376-444`

Three adapter routes use `as` type casts on `req.body` instead of Zod validation, violating the project's API rule requiring `safeParse`.

**Add Zod schemas** (top of file or in a local `const`):

```typescript
import { z } from 'zod';

const TestAdapterBodySchema = z.object({
  type: z.string().min(1),
  config: z.record(z.unknown()),
});

const CreateAdapterBodySchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  config: z.record(z.unknown()),
  enabled: z.boolean().optional(),
});

const UpdateAdapterConfigBodySchema = z.object({
  config: z.record(z.unknown()),
});
```

**Replace each route handler's body parsing:**

POST `/adapters/test` (line 377-389):

```typescript
router.post('/adapters/test', async (req, res) => {
  const parsed = TestAdapterBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }
  const { type, config } = parsed.data;
  // ... rest unchanged
});
```

POST `/adapters` (line 392-419):

```typescript
router.post('/adapters', async (req, res) => {
  const parsed = CreateAdapterBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }
  const { type, id, config, enabled } = parsed.data;
  // ... rest unchanged
});
```

PATCH `/adapters/:id/config` (line 440-444):

```typescript
router.patch('/adapters/:id/config', async (req, res) => {
  const parsed = UpdateAdapterConfigBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }
  const { config } = parsed.data;
  // ... rest unchanged
});
```

#### I5: Check `writableEnded` before SSE writes — `routes/relay.ts:303-337`

The SSE relay stream writes to `res` in subscription callbacks (lines 313-316, 321-323) and the keepalive interval (line 328) without checking whether the response has already been closed by the client. If the client disconnects between the `req.on('close')` cleanup and the next write, the write throws.

**Fix:** Guard all `res.write()` calls:

```typescript
router.get('/stream', (req, res) => {
  const pattern = (req.query.subject as string) || '>';

  initSSEStream(res);

  res.write(`event: relay_connected\n`);
  res.write(`data: ${JSON.stringify({ pattern, connectedAt: new Date().toISOString() })}\n\n`);

  const unsubMessages = relayCore.subscribe(pattern, (envelope) => {
    if (res.writableEnded) return;
    res.write(`id: ${envelope.id}\n`);
    res.write(`event: relay_message\n`);
    res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  });

  const unsubSignals = relayCore.onSignal(pattern, (_subject, signal) => {
    if (res.writableEnded) return;
    const eventType = signal.type === 'backpressure' ? 'relay_backpressure' : 'relay_signal';
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(signal)}\n\n`);
  });

  const keepalive = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepalive);
      return;
    }
    res.write(`: keepalive\n\n`);
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepalive);
    unsubMessages();
    unsubSignals();
  });
});
```

#### I6: Validate `sessionMap` JSON shape — `binding-router.ts:247-256`

`loadSessionMap()` parses the raw JSON and passes it directly to `new Map()` without validating its shape. Malformed JSON (e.g., `{}`, `[["key"]]`, `[[1, 2]]`) silently creates a corrupt session map.

**Before:**

```typescript
private async loadSessionMap(): Promise<void> {
  try {
    const raw = await readFile(this.sessionMapPath, 'utf-8');
    const entries: [string, string][] = JSON.parse(raw);
    this.sessionMap = new Map(entries);
  } catch {
    // File doesn't exist yet or is invalid — start fresh
    this.sessionMap = new Map();
  }
}
```

**After:**

```typescript
private async loadSessionMap(): Promise<void> {
  try {
    const raw = await readFile(this.sessionMapPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    // Validate shape: must be an array of [string, string] tuples
    if (!Array.isArray(parsed)) {
      console.warn('BindingRouter: sessionMap is not an array, starting fresh');
      this.sessionMap = new Map();
      return;
    }

    const valid = parsed.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string',
    );

    if (valid.length < parsed.length) {
      console.warn(
        `BindingRouter: discarded ${parsed.length - valid.length} malformed sessionMap entries`,
      );
    }

    this.sessionMap = new Map(valid);
  } catch {
    // File doesn't exist yet or JSON parse error — start fresh
    this.sessionMap = new Map();
  }
}
```

### Phase 3: Mesh & Transport Fixes (C5, C6, I7, I8, I9, I10)

#### C5: Fix Transport bypass in `useMeshScanRoots` — `use-mesh-scan-roots.ts:27-33`

The `useMeshScanRoots` hook uses raw `fetch('/api/config', ...)` to persist scan root changes. This bypasses the `Transport` interface, breaking the Obsidian plugin's `DirectTransport` (which has no server to `fetch` from).

**Step 1: Add `updateConfig()` to Transport interface** (`packages/shared/src/transport.ts`):

Add to the interface after the existing `getConfig()` method (after line 101):

```typescript
/** Partially update the persisted user config. */
updateConfig(patch: Record<string, unknown>): Promise<void>;
```

**Step 2: Implement in `HttpTransport`** (`apps/client/src/layers/shared/lib/http-transport.ts`):

Add method to the `HttpTransport` class:

```typescript
async updateConfig(patch: Record<string, unknown>): Promise<void> {
  await fetchJSON(this.baseUrl, '/config', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}
```

**Step 3: Implement in `DirectTransport`** (`apps/client/src/layers/shared/lib/direct-transport.ts`):

The `DirectTransport` wraps server services directly. Add the method delegating to `configManager`:

```typescript
async updateConfig(patch: Record<string, unknown>): Promise<void> {
  // DirectTransport delegates to the injected config manager
  if (!this.services.configManager?.applyPatch) {
    throw new Error('Config updates not available in embedded mode');
  }
  this.services.configManager.applyPatch(patch);
}
```

Also update the `DirectTransportServices` interface to include:

```typescript
configManager?: {
  applyPatch(patch: Record<string, unknown>): void;
};
```

Note: The exact integration with `DirectTransport` depends on what config management is available in the Obsidian plugin context. If `configManager` is not injected, the method throws a clear error. This is acceptable since mesh scan roots are primarily a standalone-server feature.

**Step 4: Update `useMeshScanRoots`** (`apps/client/src/layers/entities/mesh/model/use-mesh-scan-roots.ts`):

Replace the raw `fetch` with `transport.updateConfig()`:

**Before:**

```typescript
const { mutate: saveScanRoots, isPending: isSaving } = useMutation({
  mutationFn: async (newRoots: string[]) => {
    const res = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mesh: { scanRoots: newRoots } }),
    });
    if (!res.ok) throw new Error('Failed to save scan roots');
    return res.json();
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['config'] });
  },
});
```

**After:**

```typescript
const { mutate: saveScanRoots, isPending: isSaving } = useMutation({
  mutationFn: async (newRoots: string[]) => {
    await transport.updateConfig({ mesh: { scanRoots: newRoots } });
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['config'] });
  },
});
```

#### C6: Complete compensating transaction in MeshCore — `mesh-core.ts:212-221, 276-281`

In both `register()` and `registerByPath()`, when Step 3 (Relay registration) fails, the catch block removes the DB entry (`registry.remove()`) but does NOT remove the manifest file that was written in Step 1. This leaves an orphaned `.dork/agent.json` on disk.

**In `register()`** (lines 212-221) — add manifest cleanup to the Relay failure catch:

**Before:**

```typescript
// Step 3: Register with Relay
try {
  await this.relayBridge.registerAgent(manifest, candidate.path, namespace, effectiveScanRoot);
} catch (err) {
  // Compensate: remove DB entry
  this.registry.remove(manifest.id);
  throw err;
}
```

**After:**

```typescript
// Step 3: Register with Relay
try {
  await this.relayBridge.registerAgent(manifest, candidate.path, namespace, effectiveScanRoot);
} catch (err) {
  // Compensate: remove DB entry AND manifest file (written in Step 1)
  this.registry.remove(manifest.id);
  await removeManifest(candidate.path);
  throw err;
}
```

**In `registerByPath()`** (lines 276-281) — same fix:

**Before:**

```typescript
try {
  await this.relayBridge.registerAgent(manifest, projectPath, namespace, effectiveScanRoot);
} catch (err) {
  this.registry.remove(manifest.id);
  throw err;
}
```

**After:**

```typescript
try {
  await this.relayBridge.registerAgent(manifest, projectPath, namespace, effectiveScanRoot);
} catch (err) {
  // Compensate: remove DB entry AND manifest file (written above)
  this.registry.remove(manifest.id);
  await removeManifest(projectPath);
  throw err;
}
```

`removeManifest` is already imported from `@dorkos/shared/manifest` in this file (it is used in the Step 2 catch block for `register()`).

#### I7: Remove dead `CrossNamespaceEdge` animation — `CrossNamespaceEdge.tsx:55-61`

The SVG `<animateMotion>` with `<mpath xlinkHref={...}>` references the edge path by `props.id`, but React Flow's `<BaseEdge>` does not set an `id` attribute on the rendered `<path>` element. The `xlinkHref` resolves to nothing, so the animation circle renders at `(0,0)` and never moves.

**Before:**

```tsx
{
  /* Flow particle travelling along the edge */
}
{
  !prefersReducedMotion && (
    <circle r={3} fill="var(--color-primary)" opacity={0.8}>
      <animateMotion dur="3s" repeatCount="indefinite">
        <mpath xlinkHref={`#${props.id}`} />
      </animateMotion>
    </circle>
  );
}
```

**After:**

Remove the entire block (lines 54-61). The component already has the dashed stroke styling which visually communicates the cross-namespace relationship. The particle animation is dead code that renders an invisible or mispositioned circle.

```tsx
{/* Label tooltip on hover */}
{showLabel && label && (
```

If an animated particle is desired in the future, it must use the `edgePath` string directly (e.g., via a `<path>` with a defined `id`), but that is out of scope for this remediation pass.

#### I8: Fix `handleNodeClick` stale closure — `TopologyGraph.tsx:524-544`

`handleNodeClick` includes `layoutedNodes` in its `useCallback` dependency array (line 544). Since `layoutedNodes` is state set on every ELK layout pass (and after every drag via `onNodeDragStop`), this recreates the callback on every position change. This is wasteful and can cause stale-closure issues with React Flow's event system.

**Fix:** Use a ref for `layoutedNodes` and remove it from the dependency array:

Add a ref near the existing state declarations:

```typescript
const layoutedNodesRef = useRef<Node[]>([]);
```

Update the ref whenever `layoutedNodes` changes:

```typescript
useEffect(() => {
  layoutedNodesRef.current = layoutedNodes;
}, [layoutedNodes]);
```

**Update `handleNodeClick`:**

**Before:**

```typescript
const handleNodeClick = useCallback(
  (_: React.MouseEvent, node: Node) => {
    if (node.type !== 'agent') return;
    onSelectAgentRef.current?.(node.id);

    let centerX = node.position.x + AGENT_NODE_WIDTH / 2;
    let centerY = node.position.y + AGENT_NODE_HEIGHT / 2;

    if (node.parentId) {
      const parentNode = layoutedNodes.find((n) => n.id === node.parentId);
      if (parentNode) {
        centerX += parentNode.position.x;
        centerY += parentNode.position.y;
      }
    }

    const targetZoom = Math.max(getZoom(), 1.0);
    setCenter(centerX, centerY, { zoom: targetZoom, duration: 350 });
  },
  [setCenter, getZoom, layoutedNodes]
);
```

**After:**

```typescript
const handleNodeClick = useCallback(
  (_: React.MouseEvent, node: Node) => {
    if (node.type !== 'agent') return;
    onSelectAgentRef.current?.(node.id);

    let centerX = node.position.x + AGENT_NODE_WIDTH / 2;
    let centerY = node.position.y + AGENT_NODE_HEIGHT / 2;

    if (node.parentId) {
      const parentNode = layoutedNodesRef.current.find((n) => n.id === node.parentId);
      if (parentNode) {
        centerX += parentNode.position.x;
        centerY += parentNode.position.y;
      }
    }

    const targetZoom = Math.max(getZoom(), 1.0);
    setCenter(centerX, centerY, { zoom: targetZoom, duration: 350 });
  },
  [setCenter, getZoom]
);
```

#### I9: Prevent ELK layout thrashing on refetch — `TopologyGraph.tsx:497-522`, `use-mesh-topology.ts:19`

The `useTopology` hook refetches every 15 seconds (`refetchInterval: 15_000`). Each refetch creates new object references for `rawNodes` and `rawEdges` (computed in a `useMemo` that depends on `namespaces` and `accessRules`), triggering the ELK layout `useEffect` even when the topology data is structurally identical.

**Fix:** Add a structural fingerprint to the topology data and only re-layout when it changes. Use `JSON.stringify` on a stable representation of the topology IDs/edges as a dependency rather than the full node/edge arrays.

**Add a fingerprint memo** before the ELK layout effect:

```typescript
/** Stable fingerprint of the topology structure — only changes when nodes/edges actually change. */
const topologyFingerprint = useMemo(() => {
  const nodeIds = rawNodes
    .map((n) => `${n.id}:${n.type}:${n.parentId ?? ''}`)
    .sort()
    .join('|');
  const edgeIds = rawEdges
    .map((e) => `${e.source}->${e.target}:${e.type}`)
    .sort()
    .join('|');
  return `${nodeIds}::${edgeIds}`;
}, [rawNodes, rawEdges]);
```

**Update the ELK layout effect** to depend on the fingerprint instead of the raw arrays:

**Before:**

```typescript
useEffect(() => {
  let cancelled = false;
  setIsLayouting(true);
  applyElkLayout(rawNodes, rawEdges, useGroups);
  // ...
}, [rawNodes, rawEdges, useGroups, layoutVersion]);
```

**After:**

```typescript
useEffect(() => {
  let cancelled = false;
  setIsLayouting(true);
  applyElkLayout(rawNodes, rawEdges, useGroups);
  // ...
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fingerprint tracks structural changes
}, [topologyFingerprint, useGroups, layoutVersion]);
```

The `rawNodes` and `rawEdges` references are captured by the closure, so the effect body still has access to the current values. The fingerprint just prevents unnecessary re-runs when the refetch returns identical data.

#### I10: Extract `relativeTime` to shared utility

`relativeTime()` is duplicated between `AgentNode.tsx` (lines 50-68, robust version with `Number.isNaN` guard and seconds granularity) and `AgentHealthDetail.tsx` (lines 18-27, simpler version lacking `NaN`/negative guards and starting at minutes granularity). The `AgentNode` version is more correct.

**Create `apps/client/src/layers/features/mesh/lib/relative-time.ts`:**

```typescript
/**
 * Convert an ISO timestamp to a relative time string (e.g., "2m ago", "3d ago").
 *
 * Returns "just now" for invalid/future dates and "Never" for null input.
 *
 * @param isoString - ISO 8601 timestamp, or null
 */
export function relativeTime(isoString: string | null): string {
  if (!isoString) return 'Never';

  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (Number.isNaN(diffMs) || diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

This takes the robust version from `AgentNode.tsx` and adds `null` handling from `AgentHealthDetail.tsx`.

**Update `AgentNode.tsx`** — remove the inline `relativeTime` function (lines 49-68) and import from shared:

```typescript
import { relativeTime } from '../lib/relative-time';
```

**Update `AgentHealthDetail.tsx`** — remove the inline `relativeTime` function (lines 18-27) and import from shared:

```typescript
import { relativeTime } from '../lib/relative-time';
```

The function lives in `features/mesh/lib/` (not `shared/lib/`) because it is only used within the mesh feature. If other features need it in the future, it can be promoted.

## Testing Requirements

Tests cover changed code only. No backfilling unrelated test gaps.

### Phase 1: Telegram Adapter Tests

**File:** `packages/relay/src/__tests__/adapters/telegram-adapter.test.ts`

| Test                                                               | Covers |
| ------------------------------------------------------------------ | ------ |
| Reconnection stops old bot before creating a new one               | C1     |
| `stop()` clears pending reconnect timer                            | C2     |
| Reconnect timer does not fire after `stop()` is called             | C2     |
| `extractChatId` rejects float values like `123.456`                | I3     |
| `extractChatId` rejects float values in group format               | I3     |
| Webhook server uses `once` for error handler                       | I1     |
| `stopWebhookServer` calls `closeAllConnections()` before `close()` | I2     |

### Phase 2: Relay Tests

**File:** `apps/server/src/services/relay/__tests__/binding-router.test.ts`

| Test                                                                | Covers |
| ------------------------------------------------------------------- | ------ |
| `loadSessionMap` discards non-array JSON and starts fresh           | I6     |
| `loadSessionMap` filters out malformed entries and keeps valid ones | I6     |

**File:** `apps/server/src/services/relay/__tests__/binding-store.test.ts` (new or existing)

| Test                                                   | Covers |
| ------------------------------------------------------ | ------ |
| Rapid successive saves do not trigger spurious reloads | C3     |

**File:** `packages/relay/src/__tests__/delivery-pipeline.test.ts`

| Test                                                               | Covers |
| ------------------------------------------------------------------ | ------ |
| `wasDispatched()` returns true for pipeline-dispatched message IDs | C4     |
| `recentlyDispatched` set is capped at 10,000 entries               | C4     |

**File:** `packages/relay/src/__tests__/watcher-manager.test.ts`

| Test                                                           | Covers |
| -------------------------------------------------------------- | ------ |
| `handleNewMessage` skips messages that were already dispatched | C4     |

### Phase 3: Mesh & Transport Tests

**File:** `apps/client/src/layers/features/mesh/__tests__/MeshPanel.test.tsx` (or a new transport test)

| Test                                                                     | Covers |
| ------------------------------------------------------------------------ | ------ |
| `useMeshScanRoots` calls `transport.updateConfig()` instead of raw fetch | C5     |

**File:** `packages/mesh/src/__tests__/mesh-core.test.ts`

| Test                                                                   | Covers |
| ---------------------------------------------------------------------- | ------ |
| `register()` removes manifest file when Relay registration fails       | C6     |
| `registerByPath()` removes manifest file when Relay registration fails | C6     |

**File:** `apps/client/src/layers/features/mesh/ui/__tests__/CrossNamespaceEdge.test.tsx`

| Test                                                     | Covers |
| -------------------------------------------------------- | ------ |
| Does not render `<animateMotion>` or `<circle>` elements | I7     |

**File:** `apps/client/src/layers/features/mesh/ui/__tests__/TopologyGraph.test.tsx`

| Test                                                                            | Covers |
| ------------------------------------------------------------------------------- | ------ |
| ELK layout is not re-triggered when refetch returns structurally identical data | I9     |

**File:** `apps/client/src/layers/features/mesh/lib/__tests__/relative-time.test.ts` (new)

| Test                                           | Covers |
| ---------------------------------------------- | ------ |
| Returns "Never" for null input                 | I10    |
| Returns "just now" for future dates            | I10    |
| Returns seconds/minutes/hours/days granularity | I10    |
| Handles NaN dates gracefully                   | I10    |

## Implementation Phases

Execute in this order to minimize risk:

| Phase               | Issues                  | Files Changed                                                                                                                                                                                                                     | Risk                                                                                     |
| ------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1. Telegram         | C1, C2, I1, I2, I3      | `packages/relay/src/adapters/telegram-adapter.ts`, test file                                                                                                                                                                      | Low (isolated adapter, no cross-cutting changes)                                         |
| 2. Relay            | C3, C4, I4, I5, I6      | `binding-store.ts`, `delivery-pipeline.ts`, `watcher-manager.ts`, `relay-core.ts`, `routes/relay.ts`, `binding-router.ts`, test files                                                                                             | Medium (core delivery pipeline change, but `claim()` atomicity prevents data corruption) |
| 3. Mesh & Transport | C5, C6, I7, I8, I9, I10 | `transport.ts`, `http-transport.ts`, `direct-transport.ts`, `use-mesh-scan-roots.ts`, `mesh-core.ts`, `CrossNamespaceEdge.tsx`, `TopologyGraph.tsx`, `AgentNode.tsx`, `AgentHealthDetail.tsx`, new `relative-time.ts`, test files | Medium (Transport interface change requires all adapter implementations to be updated)   |

## Acceptance Criteria

- All 16 issues addressed per the fix descriptions above
- All existing tests pass
- New tests cover changed code paths
- `pnpm typecheck` passes
- `pnpm lint` passes
- No regressions in relay delivery, mesh topology rendering, or Telegram adapter connectivity

## Out of Scope

From ideation section 1 (explicit scope exclusions):

- Outbound message splitting for Telegram (suggestion -- product decision)
- Caption test path for Telegram (suggestion -- test gap)
- Zod/interface type drift assertion (suggestion -- compile-time nicety)
- `BindingDialog` state reset on reopen (suggestion -- minor UX)
- Pulse schedule basename heuristic (suggestion -- edge case)
- `enrichAgent` redundant health query (suggestion -- perf, defer to DB consolidation spec)
- `MeshStatsHeader` error state handling (suggestion -- minor UX)
- TopologyGraph file split (763 lines -- defer to separate pass since UI files have different split patterns than service code)
- `handleNodeClick` alternative approach using React Flow's `getInternalNode()` API (would be cleaner but higher risk)
