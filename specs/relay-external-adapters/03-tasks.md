# Tasks: Relay External Adapters

**Last Decompose: 2026-02-24**
**Spec**: [02-specification.md](./02-specification.md)
**Status**: Decomposed

---

## Phase 1: Core Infrastructure

### Task 1: [relay-external-adapters] [P1] Add RelayAdapter interface and adapter config types

**Files to modify:**
- `packages/relay/src/types.ts`
- `packages/relay/src/index.ts`

**Implementation:**

Add the following to `packages/relay/src/types.ts` after the existing `RelayOptions` interface:

```typescript
/**
 * Plugin interface for external channel adapters.
 * Each adapter bridges an external communication channel (Telegram, webhooks, etc.)
 * into the Relay subject hierarchy.
 */
export interface RelayAdapter {
  /** Unique identifier (e.g., 'telegram', 'webhook-github') */
  readonly id: string;

  /** Subject prefix this adapter handles (e.g., 'relay.human.telegram') */
  readonly subjectPrefix: string;

  /** Human-readable display name */
  readonly displayName: string;

  /**
   * Start the adapter — connect to external service, register Relay endpoints.
   * Called by AdapterRegistry on startup or hot-reload.
   * Must be idempotent (safe to call if already started).
   */
  start(relay: RelayCore): Promise<void>;

  /**
   * Stop the adapter — disconnect from external service, unregister endpoints.
   * Must drain in-flight messages before resolving.
   * Must be idempotent (safe to call if already stopped).
   */
  stop(): Promise<void>;

  /**
   * Deliver a Relay message to the external channel.
   * Called by RelayCore when a published message matches this adapter's subjectPrefix.
   */
  deliver(subject: string, envelope: RelayEnvelope): Promise<void>;

  /** Current adapter status */
  getStatus(): AdapterStatus;
}

export interface AdapterStatus {
  state: 'connected' | 'disconnected' | 'error' | 'starting' | 'stopping';
  messageCount: { inbound: number; outbound: number };
  errorCount: number;
  lastError?: string;
  lastErrorAt?: string;
  startedAt?: string;
}

export interface AdapterConfig {
  id: string;
  type: 'telegram' | 'webhook';
  enabled: boolean;
  config: TelegramAdapterConfig | WebhookAdapterConfig;
}

export interface TelegramAdapterConfig {
  token: string;
  mode: 'polling' | 'webhook';
  webhookUrl?: string;
  webhookPort?: number;
}

export interface WebhookAdapterConfig {
  /** Inbound webhook configuration */
  inbound: {
    /** Subject to publish inbound messages to */
    subject: string;
    /** HMAC-SHA256 secret for signature verification */
    secret: string;
    /** Previous secret for rotation (optional, 24h transition window) */
    previousSecret?: string;
  };
  /** Outbound delivery configuration */
  outbound: {
    /** URL to POST messages to */
    url: string;
    /** HMAC-SHA256 secret for signing outbound requests */
    secret: string;
    /** Custom headers to include */
    headers?: Record<string, string>;
  };
}
```

Note: `RelayAdapter.start()` takes `RelayCore` which creates a circular type dependency. Use `import type { RelayCore } from './relay-core.js'` at the top of types.ts, or define a minimal `RelayPublisher` interface that RelayCore implements:

```typescript
/** Minimal interface for adapter → relay communication. Avoids circular dependency. */
export interface RelayPublisher {
  publish(subject: string, payload: unknown, options: PublishOptions): Promise<PublishResult>;
  onSignal(pattern: string, handler: SignalHandler): Unsubscribe;
}
```

Then `RelayAdapter.start(relay: RelayPublisher)` instead.

Update `packages/relay/src/index.ts` to export the new types:

```typescript
// Adapter types
export type {
  RelayAdapter,
  AdapterStatus,
  AdapterConfig,
  TelegramAdapterConfig,
  WebhookAdapterConfig,
  RelayPublisher,
} from './types.js';
```

**Acceptance Criteria:**
- [ ] `RelayAdapter` interface exported from `packages/relay`
- [ ] `AdapterStatus`, `AdapterConfig`, `TelegramAdapterConfig`, `WebhookAdapterConfig` types exported
- [ ] No circular dependency between types.ts and relay-core.ts
- [ ] `npm run typecheck` passes across the monorepo

---

### Task 2: [relay-external-adapters] [P1] Add adapter Zod schemas to shared relay-schemas

**Files to modify:**
- `packages/shared/src/relay-schemas.ts`

**Implementation:**

Add the following schemas to `packages/shared/src/relay-schemas.ts`:

```typescript
export const AdapterTypeSchema = z.enum(['telegram', 'webhook']);

export const TelegramAdapterConfigSchema = z.object({
  token: z.string().min(1),
  mode: z.enum(['polling', 'webhook']).default('polling'),
  webhookUrl: z.string().url().optional(),
  webhookPort: z.number().int().positive().optional(),
}).openapi('TelegramAdapterConfig');

export const WebhookInboundConfigSchema = z.object({
  subject: z.string().min(1),
  secret: z.string().min(16),
  previousSecret: z.string().optional(),
}).openapi('WebhookInboundConfig');

export const WebhookOutboundConfigSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(16),
  headers: z.record(z.string()).optional(),
}).openapi('WebhookOutboundConfig');

export const WebhookAdapterConfigSchema = z.object({
  inbound: WebhookInboundConfigSchema,
  outbound: WebhookOutboundConfigSchema,
}).openapi('WebhookAdapterConfig');

export const AdapterConfigSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/),
  type: AdapterTypeSchema,
  enabled: z.boolean().default(true),
  config: z.union([TelegramAdapterConfigSchema, WebhookAdapterConfigSchema]),
}).openapi('AdapterConfig');

export const AdapterStatusSchema = z.object({
  id: z.string(),
  type: AdapterTypeSchema,
  displayName: z.string(),
  state: z.enum(['connected', 'disconnected', 'error', 'starting', 'stopping']),
  messageCount: z.object({
    inbound: z.number().int().nonnegative(),
    outbound: z.number().int().nonnegative(),
  }),
  errorCount: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  lastErrorAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
}).openapi('AdapterStatus');

export const AdaptersConfigFileSchema = z.object({
  adapters: z.array(AdapterConfigSchema),
}).openapi('AdaptersConfigFile');
```

Also export inferred TypeScript types:

```typescript
export type AdapterType = z.infer<typeof AdapterTypeSchema>;
export type TelegramAdapterConfigZ = z.infer<typeof TelegramAdapterConfigSchema>;
export type WebhookAdapterConfigZ = z.infer<typeof WebhookAdapterConfigSchema>;
export type AdapterConfigZ = z.infer<typeof AdapterConfigSchema>;
export type AdapterStatusZ = z.infer<typeof AdapterStatusSchema>;
export type AdaptersConfigFile = z.infer<typeof AdaptersConfigFileSchema>;
```

**Acceptance Criteria:**
- [ ] All schemas exported from `@dorkos/shared/relay-schemas`
- [ ] Schemas validate correctly (token min 1, secret min 16, id regex, etc.)
- [ ] `npm run typecheck` passes
- [ ] OpenAPI metadata attached via `.openapi()` calls

---

### Task 3: [relay-external-adapters] [P1] Implement AdapterRegistry class

**Files to create:**
- `packages/relay/src/adapter-registry.ts`

**Implementation:**

```typescript
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RelayAdapter, RelayPublisher } from './types.js';

/**
 * Registry for external channel adapters.
 * Manages adapter lifecycle (register, unregister, hot-reload) and routes
 * outbound messages to the correct adapter by subject prefix matching.
 */
export class AdapterRegistry {
  private adapters = new Map<string, RelayAdapter>();
  private relay: RelayPublisher | null = null;

  /** Set the RelayCore instance. Called once during initialization. */
  setRelay(relay: RelayPublisher): void {
    this.relay = relay;
  }

  /**
   * Register and start an adapter.
   * If an adapter with the same ID exists, perform hot-reload:
   * 1. Start new adapter first
   * 2. Replace in registry
   * 3. Stop old adapter (drain in-flight)
   * If new adapter fails to start, old adapter stays active.
   */
  async register(adapter: RelayAdapter): Promise<void> {
    if (!this.relay) throw new Error('AdapterRegistry: relay not set');

    const existing = this.adapters.get(adapter.id);

    // Start the new adapter — if this throws, abort (old stays active)
    await adapter.start(this.relay);

    // Swap in the new adapter
    this.adapters.set(adapter.id, adapter);

    // Stop the old adapter (non-blocking drain)
    if (existing) {
      try {
        await existing.stop();
      } catch (err) {
        // Log but don't throw — new adapter is already active
        console.warn(`AdapterRegistry: failed to stop old adapter ${adapter.id}:`, err);
      }
    }
  }

  /** Unregister and stop an adapter by ID. */
  async unregister(id: string): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    this.adapters.delete(id);
    await adapter.stop();
    return true;
  }

  /** Get adapter by ID. */
  get(id: string): RelayAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Find adapter whose subjectPrefix matches a given subject. */
  getBySubject(subject: string): RelayAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (subject.startsWith(adapter.subjectPrefix)) {
        return adapter;
      }
    }
    return undefined;
  }

  /** List all registered adapters. */
  list(): RelayAdapter[] {
    return [...this.adapters.values()];
  }

  /**
   * Deliver a message to the matching adapter.
   * Called by RelayCore publish pipeline.
   * Returns true if an adapter was found and delivery was attempted.
   */
  async deliver(subject: string, envelope: RelayEnvelope): Promise<boolean> {
    const adapter = this.getBySubject(subject);
    if (!adapter) return false;
    await adapter.deliver(subject, envelope);
    return true;
  }

  /** Stop all adapters gracefully. Uses Promise.allSettled for error isolation. */
  async shutdown(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.adapters.values()].map(a => a.stop())
    );
    // Log failures but don't throw — all adapters get a chance to stop
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('AdapterRegistry: adapter shutdown failed:', result.reason);
      }
    }
    this.adapters.clear();
  }
}
```

Export from `packages/relay/src/index.ts`:
```typescript
export { AdapterRegistry } from './adapter-registry.js';
```

**Acceptance Criteria:**
- [ ] `AdapterRegistry` class created in `packages/relay/src/adapter-registry.ts`
- [ ] register() starts adapter, supports hot-reload (start new, swap, stop old)
- [ ] Hot-reload abort: if new adapter start() throws, old stays active
- [ ] unregister() stops and removes adapter
- [ ] deliver() routes by subjectPrefix match
- [ ] shutdown() uses Promise.allSettled for error isolation
- [ ] Exported from `packages/relay/src/index.ts`

---

### Task 4: [relay-external-adapters] [P1] Integrate AdapterRegistry into RelayCore publish pipeline

**Files to modify:**
- `packages/relay/src/relay-core.ts`
- `packages/relay/src/types.ts` (RelayOptions update)

**Implementation:**

In `packages/relay/src/types.ts`, add `adapterRegistry` to `RelayOptions`:
```typescript
import type { AdapterRegistry } from './adapter-registry.js';

export interface RelayOptions {
  dataDir?: string;
  maxHops?: number;
  defaultTtlMs?: number;
  defaultCallBudget?: number;
  reliability?: ReliabilityConfig;
  adapterRegistry?: AdapterRegistry;  // NEW
}
```

In `packages/relay/src/relay-core.ts`:

1. Store the adapter registry in the constructor:
```typescript
private adapterRegistry?: AdapterRegistry;

constructor(options: RelayOptions = {}) {
  // ... existing constructor code ...
  this.adapterRegistry = options.adapterRegistry;
  if (this.adapterRegistry) {
    this.adapterRegistry.setRelay(this);
  }
}
```

2. In the `publish()` method, after delivering to Maildir endpoints, add adapter delivery:
```typescript
// After delivering to Maildir endpoints, also deliver to matching adapters
if (this.adapterRegistry) {
  try {
    const adapterDelivered = await this.adapterRegistry.deliver(subject, envelope);
    if (adapterDelivered) {
      result.deliveredTo.push({ type: 'adapter', subject });
    }
  } catch (err) {
    // Log but don't fail the overall publish
    console.warn('RelayCore: adapter delivery failed:', err);
  }
}
```

3. In the `shutdown()` method, shut down adapters:
```typescript
if (this.adapterRegistry) {
  await this.adapterRegistry.shutdown();
}
```

**Acceptance Criteria:**
- [ ] `RelayOptions` includes optional `adapterRegistry`
- [ ] RelayCore constructor accepts and stores adapter registry
- [ ] RelayCore calls `adapterRegistry.setRelay(this)` during construction
- [ ] publish() delivers to adapters after endpoint delivery
- [ ] Adapter delivery failure does not fail the overall publish
- [ ] shutdown() shuts down adapter registry
- [ ] Existing relay-core tests still pass
- [ ] `npm run typecheck` passes

---

### Task 5: [relay-external-adapters] [P1] Write AdapterRegistry unit tests

**Files to create:**
- `packages/relay/src/__tests__/adapter-registry.test.ts`

**Test helper** (add to `packages/test-utils/`):
```typescript
export function createMockAdapter(overrides?: Partial<RelayAdapter>): RelayAdapter {
  return {
    id: 'mock-adapter',
    subjectPrefix: 'relay.test.mock',
    displayName: 'Mock Adapter',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    }),
    ...overrides,
  };
}
```

**Test cases:**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdapterRegistry } from '../adapter-registry';

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry;
  let mockRelay: RelayPublisher;

  beforeEach(() => {
    registry = new AdapterRegistry();
    mockRelay = { publish: vi.fn(), onSignal: vi.fn() } as unknown as RelayPublisher;
    registry.setRelay(mockRelay);
  });

  // Registration
  it('register() starts adapter and adds to list', async () => { ... });
  it('register() throws if relay not set', async () => { ... });
  it('unregister() stops and removes adapter', async () => { ... });
  it('unregister() returns false for unknown adapter', async () => { ... });

  // Lookup
  it('get() returns adapter by ID', () => { ... });
  it('getBySubject() matches by prefix', () => { ... });
  it('getBySubject() returns undefined when no match', () => { ... });
  it('list() returns all registered adapters', () => { ... });

  // Delivery
  it('deliver() routes to correct adapter by subject prefix', async () => { ... });
  it('deliver() returns false when no adapter matches', async () => { ... });

  // Hot-reload
  it('hot-reload: new adapter starts before old stops', async () => { ... });
  it('hot-reload: if new start() throws, old adapter stays active', async () => { ... });

  // Shutdown
  it('shutdown() calls stop() on all adapters via Promise.allSettled', async () => { ... });
  it('shutdown: one adapter stop() rejection does not prevent others', async () => { ... });
  it('shutdown() clears the adapter map', async () => { ... });
});
```

**Acceptance Criteria:**
- [ ] All test cases listed above are implemented and passing
- [ ] Mock adapter factory reusable from test-utils
- [ ] Tests cover hot-reload edge cases (abort on failure, start-before-stop ordering)
- [ ] Tests cover error isolation in shutdown
- [ ] `npx vitest run packages/relay/src/__tests__/adapter-registry.test.ts` passes

---

## Phase 2: Server Service Restructuring

### Task 6: [relay-external-adapters] [P2] Create domain folder structure and move services

**Implementation:**

Create four domain folders under `apps/server/src/services/`:

```
apps/server/src/services/
├── core/
│   ├── agent-manager.ts
│   ├── agent-types.ts
│   ├── sdk-event-mapper.ts
│   ├── context-builder.ts
│   ├── interactive-handlers.ts
│   ├── stream-adapter.ts
│   ├── config-manager.ts
│   ├── command-registry.ts
│   ├── file-lister.ts
│   ├── git-status.ts
│   ├── update-checker.ts
│   ├── mcp-tool-server.ts
│   ├── openapi-registry.ts
│   └── tunnel-manager.ts
├── session/
│   ├── session-broadcaster.ts
│   ├── session-lock.ts
│   ├── transcript-reader.ts
│   ├── transcript-parser.ts
│   ├── task-reader.ts
│   └── build-task-event.ts
├── pulse/
│   ├── pulse-store.ts
│   ├── pulse-state.ts
│   └── scheduler-service.ts
└── relay/
    └── relay-state.ts
```

Steps:
1. `mkdir -p apps/server/src/services/{core,session,pulse,relay}`
2. `git mv` each file to its domain folder
3. Use `git mv` to preserve history

**Acceptance Criteria:**
- [ ] All 24 service files moved to their domain folders
- [ ] No service files remain directly in `apps/server/src/services/` (only subdirectories)
- [ ] Git history preserved via `git mv`

---

### Task 7: [relay-external-adapters] [P2] Update all import paths across apps/server

**Implementation:**

After moving files in Task 6, update all imports. The main consumers are:

1. **Route files** (`apps/server/src/routes/*.ts`): These import from `../services/`. Update to `../services/{domain}/`.
2. **`apps/server/src/index.ts`**: Main server entry, imports many services.
3. **`apps/server/src/lib/*.ts`**: Utility files that may import services.
4. **Cross-service imports**: Services that import from each other (e.g., `agent-manager.ts` imports `agent-types.ts`).
5. **Test files** (`apps/server/src/services/__tests__/*.ts`): Move to `apps/server/src/services/{domain}/__tests__/` and update imports.

Pattern: `from '../services/foo.js'` becomes `from '../services/core/foo.js'` (or session/, pulse/, relay/ as appropriate).

For intra-domain imports within the same folder, update to `./` relative imports.

**Acceptance Criteria:**
- [ ] All route files import from correct domain paths
- [ ] `index.ts` imports from correct domain paths
- [ ] Cross-service imports updated
- [ ] Test file imports updated (move test files to domain `__tests__/` dirs)
- [ ] `npm run typecheck` passes
- [ ] No remaining imports of `../services/foo.ts` without a domain subfolder

---

### Task 8: [relay-external-adapters] [P2] Add barrel exports for domain folders and verify tests

**Files to create:**
- `apps/server/src/services/core/index.ts`
- `apps/server/src/services/session/index.ts`
- `apps/server/src/services/pulse/index.ts`
- `apps/server/src/services/relay/index.ts`

**Implementation:**

```typescript
// services/core/index.ts
export { AgentManager } from './agent-manager.js';
export type { AgentSession, ToolState } from './agent-types.js';
export { createToolState } from './agent-types.js';
export { mapSdkMessage } from './sdk-event-mapper.js';
export { buildSystemPromptAppend } from './context-builder.js';
export { createCanUseTool } from './interactive-handlers.js';
export { initSSEStream, sendSSEEvent, endSSEStream } from './stream-adapter.js';
export { initConfigManager, getConfigManager } from './config-manager.js';
export { CommandRegistryService } from './command-registry.js';
export { FileLister } from './file-lister.js';
export { getGitStatus } from './git-status.js';
export { checkForUpdates } from './update-checker.js';
export { createDorkOsToolServer } from './mcp-tool-server.js';
export type { McpToolDeps } from './mcp-tool-server.js';
export { OpenApiRegistry } from './openapi-registry.js';
export { TunnelManager } from './tunnel-manager.js';

// services/session/index.ts
export { SessionBroadcaster } from './session-broadcaster.js';
export { SessionLock } from './session-lock.js';
export { TranscriptReader } from './transcript-reader.js';
export { parseTranscriptLine } from './transcript-parser.js';
export { TaskReader } from './task-reader.js';
export { buildTaskEvent } from './build-task-event.js';

// services/pulse/index.ts
export { PulseStore } from './pulse-store.js';
export { isPulseEnabled, setPulseEnabled } from './pulse-state.js';
export { SchedulerService } from './scheduler-service.js';

// services/relay/index.ts
export { isRelayEnabled, setRelayEnabled } from './relay-state.js';
```

Note: These barrel exports are for convenience. Existing direct imports still work. Barrel imports are recommended for new code.

Run full test suite: `npm test -- --run`

**Acceptance Criteria:**
- [ ] Barrel `index.ts` created for each domain folder
- [ ] All existing tests pass without modifications beyond import path fixes
- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds

---

## Phase 3: Adapter Implementations

### Task 9: [relay-external-adapters] [P3] Install grammy dependencies in packages/relay

**Implementation:**

```bash
cd packages/relay
npm install grammy @grammyjs/auto-retry
```

Add as regular dependencies (not peer deps) since the adapter implementations live in this package.

Verify `packages/relay/package.json` has:
```json
{
  "dependencies": {
    "grammy": "^1.x",
    "@grammyjs/auto-retry": "^2.x"
  }
}
```

**Acceptance Criteria:**
- [ ] `grammy` and `@grammyjs/auto-retry` in `packages/relay/package.json` dependencies
- [ ] `npm install` completes without errors
- [ ] `npm run typecheck` passes (grammy types available)

---

### Task 10: [relay-external-adapters] [P3] Implement Telegram adapter

**Files to create:**
- `packages/relay/src/adapters/telegram-adapter.ts`

**Implementation:**

```typescript
import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type {
  RelayAdapter,
  AdapterStatus,
  TelegramAdapterConfig,
  RelayPublisher,
  Unsubscribe,
} from '../types.js';

/**
 * Telegram adapter — bridges Telegram Bot API into the Relay subject hierarchy.
 *
 * Subject mapping:
 * - DM: relay.human.telegram.{chatId} (positive chat IDs)
 * - Group: relay.human.telegram.group.{chatId} (negative chat IDs — abs value used)
 */
export class TelegramAdapter implements RelayAdapter {
  readonly id: string;
  readonly subjectPrefix = 'relay.human.telegram';
  readonly displayName: string;

  private config: TelegramAdapterConfig;
  private bot: Bot | null = null;
  private relay: RelayPublisher | null = null;
  private signalUnsub: Unsubscribe | null = null;
  private lastSentAt = new Map<number, number>(); // chatId -> timestamp ms
  private status: AdapterStatus = {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  constructor(id: string, config: TelegramAdapterConfig, displayName?: string) {
    this.id = id;
    this.config = config;
    this.displayName = displayName ?? `Telegram (${id})`;
  }

  async start(relay: RelayPublisher): Promise<void> {
    if (this.status.state === 'connected') return; // Idempotent
    this.status.state = 'starting';
    this.relay = relay;

    this.bot = new Bot(this.config.token);
    this.bot.api.config.use(autoRetry());

    // Error handler
    this.bot.catch((err) => {
      this.status.errorCount++;
      this.status.lastError = err.message ?? String(err);
      this.status.lastErrorAt = new Date().toISOString();
      this.status.state = 'error';
    });

    // Inbound message handler
    this.bot.on('message', async (ctx) => {
      const chatId = ctx.chat.id;
      const subject = chatId < 0
        ? `${this.subjectPrefix}.group.${Math.abs(chatId)}`
        : `${this.subjectPrefix}.${chatId}`;

      const payload = {
        type: 'text',
        text: ctx.message.text ?? '',
        metadata: {
          platform: 'telegram',
          chatId,
          senderId: ctx.from?.id,
          senderName: ctx.from?.first_name,
          messageId: ctx.message.message_id,
        },
        responseContext: {
          platform: 'telegram',
          maxLength: 4096,
          supportedFormats: ['text', 'markdown'],
        },
      };

      try {
        await relay.publish(subject, payload, {
          from: subject,
        });
        this.status.messageCount.inbound++;
      } catch (err) {
        this.status.errorCount++;
        this.status.lastError = err instanceof Error ? err.message : String(err);
        this.status.lastErrorAt = new Date().toISOString();
      }
    });

    // Subscribe to Relay signals for typing indicators
    this.signalUnsub = relay.onSignal(`${this.subjectPrefix}.>`, (subject, signal) => {
      if (signal.type === 'typing') {
        const chatId = this.extractChatId(subject);
        if (chatId !== null && this.bot) {
          this.bot.api.sendChatAction(chatId, 'typing').catch(() => {
            // Best effort — don't fail on typing indicators
          });
        }
      }
    });

    // Start long polling (non-blocking)
    this.bot.start({
      onStart: () => {
        this.status.state = 'connected';
        this.status.startedAt = new Date().toISOString();
      },
    });
  }

  async stop(): Promise<void> {
    if (this.status.state === 'disconnected') return; // Idempotent
    this.status.state = 'stopping';
    if (this.signalUnsub) {
      this.signalUnsub();
      this.signalUnsub = null;
    }
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
    this.relay = null;
    this.status.state = 'disconnected';
  }

  async deliver(subject: string, envelope: RelayEnvelope): Promise<void> {
    if (!this.bot) throw new Error('TelegramAdapter: bot not started');

    const chatId = this.extractChatId(subject);
    if (chatId === null) throw new Error(`TelegramAdapter: cannot extract chatId from ${subject}`);

    // Per-chat rate limiting: 1 msg/s
    const now = Date.now();
    const lastSent = this.lastSentAt.get(chatId) ?? 0;
    const waitMs = Math.max(0, 1000 - (now - lastSent));
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    const text = typeof envelope.payload === 'object' && envelope.payload !== null
      ? (envelope.payload as { text?: string }).text ?? JSON.stringify(envelope.payload)
      : String(envelope.payload);

    await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
    this.lastSentAt.set(chatId, Date.now());
    this.status.messageCount.outbound++;
  }

  getStatus(): AdapterStatus {
    return { ...this.status };
  }

  /** Extract chat ID from subject like relay.human.telegram.{chatId} or relay.human.telegram.group.{chatId} */
  private extractChatId(subject: string): number | null {
    const parts = subject.split('.');
    if (parts.length < 4) return null;
    // relay.human.telegram.group.{id} -> negative
    // relay.human.telegram.{id} -> positive
    if (parts[3] === 'group' && parts[4]) {
      return -Math.abs(Number(parts[4]));
    }
    const id = Number(parts[3]);
    return Number.isFinite(id) ? id : null;
  }
}
```

Export from `packages/relay/src/index.ts`:
```typescript
export { TelegramAdapter } from './adapters/telegram-adapter.js';
```

**Acceptance Criteria:**
- [ ] `TelegramAdapter` implements `RelayAdapter` interface
- [ ] Inbound: Telegram messages published to correct Relay subjects
- [ ] Outbound: deliver() sends messages via bot.api.sendMessage with HTML parse mode
- [ ] DM subject: `relay.human.telegram.{chatId}`
- [ ] Group subject: `relay.human.telegram.group.{chatId}` (negative IDs)
- [ ] Per-chat rate limit: 1 msg/s with delay
- [ ] Typing signals: sendChatAction on relay typing signal
- [ ] start() is idempotent
- [ ] stop() is idempotent, drains via bot.stop()
- [ ] Error handler increments errorCount, sets lastError
- [ ] `npm run typecheck` passes

---

### Task 11: [relay-external-adapters] [P3] Implement Webhook adapter

**Files to create:**
- `packages/relay/src/adapters/webhook-adapter.ts`

**Implementation:**

```typescript
import crypto from 'node:crypto';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type {
  RelayAdapter,
  AdapterStatus,
  WebhookAdapterConfig,
  RelayPublisher,
} from '../types.js';

const TIMESTAMP_WINDOW_SECS = 300; // ±5 minutes (Stripe standard)
const NONCE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NONCE_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Webhook adapter — bridges generic HTTP webhooks into the Relay subject hierarchy.
 *
 * Inbound: Receives HTTP POST with HMAC-SHA256 signature verification.
 * Outbound: Sends HTTP POST with HMAC-SHA256 signed headers.
 */
export class WebhookAdapter implements RelayAdapter {
  readonly id: string;
  readonly subjectPrefix: string;
  readonly displayName: string;

  private config: WebhookAdapterConfig;
  private relay: RelayPublisher | null = null;
  private nonceMap = new Map<string, number>(); // nonce -> expiresAt
  private nonceInterval: NodeJS.Timeout | null = null;
  private status: AdapterStatus = {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  constructor(id: string, config: WebhookAdapterConfig, displayName?: string) {
    this.id = id;
    this.config = config;
    this.subjectPrefix = config.inbound.subject;
    this.displayName = displayName ?? `Webhook (${id})`;
  }

  async start(relay: RelayPublisher): Promise<void> {
    if (this.status.state === 'connected') return;
    this.relay = relay;
    this.status.state = 'connected';
    this.status.startedAt = new Date().toISOString();

    // Start nonce pruning interval
    this.nonceInterval = setInterval(() => {
      const now = Date.now();
      for (const [nonce, expires] of this.nonceMap) {
        if (now > expires) this.nonceMap.delete(nonce);
      }
    }, NONCE_PRUNE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.status.state === 'disconnected') return;
    if (this.nonceInterval) {
      clearInterval(this.nonceInterval);
      this.nonceInterval = null;
    }
    this.nonceMap.clear();
    this.relay = null;
    this.status.state = 'disconnected';
  }

  /**
   * Handle an inbound webhook POST.
   * Verifies HMAC-SHA256 signature, timestamp window, and nonce uniqueness.
   */
  async handleInbound(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.relay) return { ok: false, error: 'Adapter not started' };

    const signature = String(headers['x-signature'] ?? '');
    const timestamp = String(headers['x-timestamp'] ?? '');
    const nonce = String(headers['x-nonce'] ?? '');

    // 1. Verify timestamp window
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_WINDOW_SECS) {
      return { ok: false, error: 'Timestamp expired or invalid' };
    }

    // 2. Check nonce replay
    const nonceKey = `${this.id}:${nonce}`;
    if (this.nonceMap.has(nonceKey)) {
      return { ok: false, error: 'Nonce already seen (replay)' };
    }

    // 3. Verify HMAC signature
    const valid = verifySignature(
      rawBody,
      timestamp,
      signature,
      this.config.inbound.secret,
      this.config.inbound.previousSecret,
    );
    if (!valid) {
      return { ok: false, error: 'Invalid signature' };
    }

    // 4. Record nonce
    this.nonceMap.set(nonceKey, Date.now() + NONCE_TTL_MS);

    // 5. Parse and publish
    try {
      const body = JSON.parse(rawBody.toString());
      const payload = {
        type: 'webhook',
        data: body,
        metadata: { platform: 'webhook', adapterId: this.id, nonce },
        responseContext: { platform: 'webhook' },
      };

      await this.relay.publish(this.config.inbound.subject, payload, {
        from: `relay.webhook.${this.id}`,
      });
      this.status.messageCount.inbound++;
      return { ok: true };
    } catch (err) {
      this.status.errorCount++;
      this.status.lastError = err instanceof Error ? err.message : String(err);
      this.status.lastErrorAt = new Date().toISOString();
      return { ok: false, error: 'Publish failed' };
    }
  }

  /** Deliver a Relay message to the outbound webhook URL. */
  async deliver(subject: string, envelope: RelayEnvelope): Promise<void> {
    const body = JSON.stringify(envelope.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const message = `${timestamp}.${body}`;
    const signature = crypto
      .createHmac('sha256', this.config.outbound.secret)
      .update(message)
      .digest('hex');

    const response = await fetch(this.config.outbound.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        ...this.config.outbound.headers,
      },
      body,
    });

    if (!response.ok) {
      this.status.errorCount++;
      this.status.lastError = `Outbound delivery failed: HTTP ${response.status}`;
      this.status.lastErrorAt = new Date().toISOString();
      throw new Error(`WebhookAdapter: outbound delivery failed with ${response.status}`);
    }

    this.status.messageCount.outbound++;
  }

  getStatus(): AdapterStatus {
    return { ...this.status };
  }
}

/**
 * Verify HMAC-SHA256 signature with timing-safe comparison.
 * Supports dual-secret rotation (tries current, then previous).
 */
export function verifySignature(
  rawBody: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  previousSecret?: string,
): boolean {
  const message = `${timestamp}.${rawBody.toString()}`;
  const expected = crypto.createHmac('sha256', secret).update(message).digest();
  const received = Buffer.from(signature, 'hex');

  if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) {
    return true;
  }

  // Try previous secret for rotation
  if (previousSecret) {
    const expectedPrev = crypto
      .createHmac('sha256', previousSecret)
      .update(message)
      .digest();
    return received.length === expectedPrev.length && crypto.timingSafeEqual(received, expectedPrev);
  }

  return false;
}
```

Export from `packages/relay/src/index.ts`:
```typescript
export { WebhookAdapter, verifySignature } from './adapters/webhook-adapter.js';
```

**Acceptance Criteria:**
- [ ] `WebhookAdapter` implements `RelayAdapter` interface
- [ ] handleInbound() verifies HMAC-SHA256 with `crypto.timingSafeEqual()`
- [ ] Timestamp window: ±300 seconds
- [ ] Nonce replay prevention with Map + TTL pruning
- [ ] Dual-secret rotation: tries current then previous secret
- [ ] Outbound deliver(): POST with X-Signature, X-Timestamp, X-Nonce headers
- [ ] start()/stop() are idempotent
- [ ] Nonce prune interval every 5 minutes
- [ ] `verifySignature()` exported as utility for testing
- [ ] `npm run typecheck` passes

---

### Task 12: [relay-external-adapters] [P3] Write unit tests for Telegram and Webhook adapters

**Files to create:**
- `packages/relay/src/adapters/__tests__/telegram-adapter.test.ts`
- `packages/relay/src/adapters/__tests__/webhook-adapter.test.ts`

**Add to test-utils** (`packages/test-utils/`):
```typescript
export function signPayload(
  body: string,
  secret: string,
  timestamp?: number,
): { signature: string; timestamp: string; nonce: string } {
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const message = `${ts}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return { signature, timestamp: ts, nonce };
}
```

**Telegram adapter tests:**
```typescript
describe('TelegramAdapter', () => {
  // Mock grammy: vi.mock('grammy', () => ({ Bot: MockBot }))
  // Mock auto-retry: vi.mock('@grammyjs/auto-retry', () => ({ autoRetry: vi.fn() }))

  it('start() creates bot, registers handlers, begins polling', async () => { ... });
  it('stop() calls bot.stop() and transitions to disconnected', async () => { ... });
  it('inbound DM message -> relay.publish() with relay.human.telegram.{chatId}', async () => { ... });
  it('inbound group message -> relay.human.telegram.group.{chatId}', async () => { ... });
  it('outbound deliver() -> bot.api.sendMessage() with correct chat ID', async () => { ... });
  it('per-chat rate limiting: second message within 1s is delayed', async () => { ... });
  it('getStatus() reflects connected state after start', async () => { ... });
  it('getStatus() reflects error state after bot error', async () => { ... });
  it('start() is idempotent (safe to call twice)', async () => { ... });
  it('stop() is idempotent (safe to call twice)', async () => { ... });
  it('typing signal -> sendChatAction called', async () => { ... });
});
```

**Webhook adapter tests:**
```typescript
describe('WebhookAdapter', () => {
  const secret = 'a-very-long-secret-at-least-16';

  it('valid HMAC + timestamp -> message published to Relay', async () => { ... });
  it('invalid HMAC -> rejected', async () => { ... });
  it('expired timestamp (> 300s) -> rejected', async () => { ... });
  it('replayed nonce -> rejected', async () => { ... });
  it('dual-secret rotation: old secret still accepted', async () => { ... });
  it('outbound deliver() -> HTTP POST with correct HMAC headers', async () => { ... });
  it('nonce map prunes expired entries', async () => { ... });
  it('start() is idempotent', async () => { ... });
  it('stop() is idempotent and clears nonce map', async () => { ... });
  it('outbound delivery failure sets error status', async () => { ... });
});
```

**Acceptance Criteria:**
- [ ] All Telegram adapter test cases pass
- [ ] All Webhook adapter test cases pass
- [ ] grammy is fully mocked (no real Telegram API calls)
- [ ] Webhook tests use `signPayload()` helper for HMAC generation
- [ ] fetch() is mocked for outbound webhook tests
- [ ] Rate limiting test verifies delay behavior
- [ ] Nonce pruning test uses `vi.useFakeTimers()`

---

## Phase 4: Server Integration

### Task 13: [relay-external-adapters] [P4] Create AdapterManager service

**Files to create:**
- `apps/server/src/services/relay/adapter-manager.ts`

**Implementation:**

```typescript
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import type { RelayCore, AdapterRegistry, RelayAdapter } from '@dorkos/relay';
import { TelegramAdapter } from '@dorkos/relay';
import { WebhookAdapter } from '@dorkos/relay';
import { AdaptersConfigFileSchema } from '@dorkos/shared/relay-schemas';
import type { AdapterConfig, AdapterStatus } from '@dorkos/relay';

/**
 * Server-side adapter lifecycle manager.
 * Loads adapter config from disk, instantiates adapters, watches for config changes.
 */
export class AdapterManager {
  private registry: AdapterRegistry;
  private configWatcher: FSWatcher | null = null;
  private configPath: string;
  private configs: AdapterConfig[] = [];

  constructor(
    private relay: RelayCore,
    registry: AdapterRegistry,
    configPath: string,
  ) {
    this.registry = registry;
    this.configPath = configPath;
  }

  /** Load config and start all enabled adapters. */
  async initialize(): Promise<void> {
    await this.loadConfig();
    await this.startEnabledAdapters();
    this.startConfigWatcher();
  }

  /** Reload config from disk and reconcile adapter state. */
  async reload(): Promise<void> {
    const oldConfigs = new Map(this.configs.map(c => [c.id, c]));
    await this.loadConfig();

    // Stop adapters that are no longer in config or disabled
    for (const [id] of oldConfigs) {
      const newConfig = this.configs.find(c => c.id === id);
      if (!newConfig || !newConfig.enabled) {
        await this.registry.unregister(id);
      }
    }

    // Start/update enabled adapters
    await this.startEnabledAdapters();
  }

  /** Enable a specific adapter by ID. Updates config file. */
  async enable(id: string): Promise<void> {
    const config = this.configs.find(c => c.id === id);
    if (!config) throw new Error(`Adapter not found: ${id}`);
    config.enabled = true;
    await this.saveConfig();
    const adapter = this.createAdapter(config);
    if (adapter) await this.registry.register(adapter);
  }

  /** Disable a specific adapter by ID. Updates config file. */
  async disable(id: string): Promise<void> {
    const config = this.configs.find(c => c.id === id);
    if (!config) throw new Error(`Adapter not found: ${id}`);
    config.enabled = false;
    await this.saveConfig();
    await this.registry.unregister(id);
  }

  /** Get all adapter statuses. */
  listAdapters(): Array<{ config: AdapterConfig; status: AdapterStatus }> {
    return this.configs.map(config => {
      const adapter = this.registry.get(config.id);
      const status: AdapterStatus = adapter?.getStatus() ?? {
        state: 'disconnected',
        messageCount: { inbound: 0, outbound: 0 },
        errorCount: 0,
      };
      return { config, status };
    });
  }

  /** Get single adapter status. */
  getAdapter(id: string): { config: AdapterConfig; status: AdapterStatus } | undefined {
    const config = this.configs.find(c => c.id === id);
    if (!config) return undefined;
    const adapter = this.registry.get(id);
    const status: AdapterStatus = adapter?.getStatus() ?? {
      state: 'disconnected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    };
    return { config, status };
  }

  /** Get the AdapterRegistry (for webhook route to call handleInbound). */
  getRegistry(): AdapterRegistry {
    return this.registry;
  }

  /** Stop all adapters and config watcher. */
  async shutdown(): Promise<void> {
    if (this.configWatcher) {
      await this.configWatcher.close();
      this.configWatcher = null;
    }
    await this.registry.shutdown();
  }

  private async loadConfig(): Promise<void> {
    try {
      const raw = await readFile(this.configPath, 'utf-8');
      const parsed = AdaptersConfigFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.configs = parsed.data.adapters;
      } else {
        console.warn('AdapterManager: malformed config, skipping invalid entries:', parsed.error.flatten());
        this.configs = [];
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.configs = []; // No config file = no adapters
      } else {
        console.warn('AdapterManager: failed to read config:', err);
        this.configs = [];
      }
    }
  }

  private async saveConfig(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(
      this.configPath,
      JSON.stringify({ adapters: this.configs }, null, 2),
      'utf-8',
    );
  }

  private async startEnabledAdapters(): Promise<void> {
    for (const config of this.configs) {
      if (!config.enabled) continue;
      if (this.registry.get(config.id)) continue; // Already running
      const adapter = this.createAdapter(config);
      if (adapter) {
        try {
          await this.registry.register(adapter);
        } catch (err) {
          console.warn(`AdapterManager: failed to start adapter ${config.id}:`, err);
        }
      }
    }
  }

  private createAdapter(config: AdapterConfig): RelayAdapter | null {
    switch (config.type) {
      case 'telegram':
        return new TelegramAdapter(config.id, config.config as TelegramAdapterConfig);
      case 'webhook':
        return new WebhookAdapter(config.id, config.config as WebhookAdapterConfig);
      default:
        console.warn(`AdapterManager: unknown adapter type: ${config.type}`);
        return null;
    }
  }

  private startConfigWatcher(): void {
    this.configWatcher = chokidar.watch(this.configPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.configWatcher.on('change', () => {
      this.reload().catch(err => {
        console.warn('AdapterManager: hot-reload failed:', err);
      });
    });
  }
}
```

**Acceptance Criteria:**
- [ ] `AdapterManager` reads config from `~/.dork/relay/adapters.json`
- [ ] initialize() loads config and starts enabled adapters
- [ ] reload() reconciles adapter state (stop removed, start new)
- [ ] enable()/disable() update config file and adapter lifecycle
- [ ] Missing config file -> empty adapter list, no crash
- [ ] Malformed config -> log warning, skip invalid entries
- [ ] chokidar watches config file for hot-reload
- [ ] shutdown() stops all adapters and config watcher
- [ ] `npm run typecheck` passes

---

### Task 14: [relay-external-adapters] [P4] Add adapter HTTP routes to relay router

**Files to modify:**
- `apps/server/src/routes/relay.ts`

**Implementation:**

Update the `createRelayRouter` signature:
```typescript
import type { AdapterManager } from '../services/relay/adapter-manager.js';
import express from 'express';

export function createRelayRouter(
  relayCore: RelayCore,
  adapterManager?: AdapterManager,
): Router {
```

Add the following routes inside the router (all under `/api/relay/` prefix):

```typescript
// --- Adapter Management Routes ---

if (adapterManager) {
  // GET /adapters — List all adapters with status
  router.get('/adapters', (_req, res) => {
    const adapters = adapterManager.listAdapters();
    return res.json(adapters);
  });

  // GET /adapters/:id — Get single adapter status
  router.get('/adapters/:id', (req, res) => {
    const adapter = adapterManager.getAdapter(req.params.id);
    if (!adapter) return res.status(404).json({ error: 'Adapter not found' });
    return res.json(adapter);
  });

  // POST /adapters/:id/enable — Enable adapter
  router.post('/adapters/:id/enable', async (req, res) => {
    try {
      await adapterManager.enable(req.params.id);
      return res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Enable failed';
      return res.status(400).json({ error: message });
    }
  });

  // POST /adapters/:id/disable — Disable adapter
  router.post('/adapters/:id/disable', async (req, res) => {
    try {
      await adapterManager.disable(req.params.id);
      return res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Disable failed';
      return res.status(400).json({ error: message });
    }
  });

  // POST /adapters/reload — Trigger config hot-reload
  router.post('/adapters/reload', async (_req, res) => {
    try {
      await adapterManager.reload();
      return res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reload failed';
      return res.status(500).json({ error: message });
    }
  });

  // POST /webhooks/:adapterId — Inbound webhook receiver
  router.post('/webhooks/:adapterId', express.raw({ type: '*/*' }), async (req, res) => {
    const adapterInfo = adapterManager.getAdapter(req.params.adapterId);
    if (!adapterInfo || adapterInfo.config.type !== 'webhook') {
      return res.status(404).json({ error: 'Webhook adapter not found' });
    }

    const registry = adapterManager.getRegistry();
    const adapter = registry.get(req.params.adapterId);
    if (!adapter) {
      return res.status(404).json({ error: 'Adapter not running' });
    }

    // WebhookAdapter has handleInbound method
    const webhookAdapter = adapter as import('@dorkos/relay').WebhookAdapter;
    const result = await webhookAdapter.handleInbound(req.body, req.headers as Record<string, string>);

    if (result.ok) {
      return res.status(200).json({ ok: true });
    }
    return res.status(401).json({ error: result.error });
  });
}
```

**Acceptance Criteria:**
- [ ] `createRelayRouter` accepts optional `AdapterManager` (backward compatible)
- [ ] GET `/adapters` returns list of adapter configs + statuses
- [ ] GET `/adapters/:id` returns single adapter or 404
- [ ] POST `/adapters/:id/enable` starts adapter, returns 200
- [ ] POST `/adapters/:id/disable` stops adapter, returns 200
- [ ] POST `/adapters/reload` triggers config hot-reload
- [ ] POST `/webhooks/:adapterId` receives raw body, verifies HMAC, publishes to Relay
- [ ] Webhook route uses `express.raw()` for HMAC verification
- [ ] Unknown adapter -> 404
- [ ] Invalid signature -> 401

---

### Task 15: [relay-external-adapters] [P4] Add adapter MCP tools to mcp-tool-server

**Files to modify:**
- `apps/server/src/services/core/mcp-tool-server.ts` (or `apps/server/src/services/mcp-tool-server.ts` pre-restructuring)

**Implementation:**

Update `McpToolDeps`:
```typescript
import type { AdapterManager } from '../relay/adapter-manager.js';

export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  defaultCwd: string;
  pulseStore?: PulseStore;
  relayCore?: RelayCore;
  adapterManager?: AdapterManager;  // NEW
}
```

Add tools inside `createDorkOsToolServer(deps)`:

```typescript
if (deps.adapterManager) {
  const adapterManager = deps.adapterManager;

  // relay_list_adapters
  tool(
    server,
    'relay_list_adapters',
    'List all Relay adapters with their status',
    {},
    async () => {
      const adapters = adapterManager.listAdapters();
      return {
        content: [{ type: 'text', text: JSON.stringify(adapters, null, 2) }],
      };
    },
  );

  // relay_enable_adapter
  tool(
    server,
    'relay_enable_adapter',
    'Enable a Relay adapter by ID',
    { id: z.string().describe('Adapter ID to enable') },
    async (args) => {
      await adapterManager.enable(args.id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, id: args.id, action: 'enabled' }) }],
      };
    },
  );

  // relay_disable_adapter
  tool(
    server,
    'relay_disable_adapter',
    'Disable a Relay adapter by ID',
    { id: z.string().describe('Adapter ID to disable') },
    async (args) => {
      await adapterManager.disable(args.id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, id: args.id, action: 'disabled' }) }],
      };
    },
  );

  // relay_reload_adapters
  tool(
    server,
    'relay_reload_adapters',
    'Reload Relay adapter configuration from disk',
    {},
    async () => {
      await adapterManager.reload();
      const adapters = adapterManager.listAdapters();
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, adapterCount: adapters.length }) }],
      };
    },
  );
}
```

**Acceptance Criteria:**
- [ ] `McpToolDeps` includes optional `adapterManager`
- [ ] `relay_list_adapters` returns JSON array of adapter configs + statuses
- [ ] `relay_enable_adapter` enables adapter by ID
- [ ] `relay_disable_adapter` disables adapter by ID
- [ ] `relay_reload_adapters` triggers config reload, returns adapter count
- [ ] Tools only registered when `adapterManager` is provided
- [ ] `npm run typecheck` passes

---

### Task 16: [relay-external-adapters] [P4] Wire AdapterManager into server startup

**Files to modify:**
- `apps/server/src/index.ts`

**Implementation:**

Import and initialize AdapterManager after RelayCore initialization:

```typescript
import { AdapterRegistry } from '@dorkos/relay';
import { AdapterManager } from './services/relay/adapter-manager.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

// After RelayCore is created:
let adapterManager: AdapterManager | undefined;
if (isRelayEnabled() && relayCore) {
  const adapterRegistry = new AdapterRegistry();
  const configPath = join(homedir(), '.dork', 'relay', 'adapters.json');
  adapterManager = new AdapterManager(relayCore, adapterRegistry, configPath);
  await adapterManager.initialize();
}

// Pass to relay router:
app.use('/api/relay', createRelayRouter(relayCore, adapterManager));

// Pass to MCP tool server:
const toolServer = createDorkOsToolServer({
  transcriptReader,
  defaultCwd,
  pulseStore,
  relayCore,
  adapterManager,  // NEW
});

// Update SIGTERM handler — shutdown adapters before relay:
process.on('SIGTERM', async () => {
  if (adapterManager) await adapterManager.shutdown();
  if (relayCore) await relayCore.shutdown();
  // ... existing shutdown ...
});
```

**Acceptance Criteria:**
- [ ] AdapterManager created when Relay is enabled
- [ ] Config path: `~/.dork/relay/adapters.json`
- [ ] AdapterManager.initialize() called before server starts listening
- [ ] AdapterManager passed to relay router and MCP tool server
- [ ] SIGTERM shuts down adapters before RelayCore
- [ ] Server still starts when Relay is disabled (adapterManager undefined)
- [ ] Server still starts when no adapters.json exists

---

### Task 17: [relay-external-adapters] [P4] Write tests for AdapterManager, routes, and MCP tools

**Files to create:**
- `apps/server/src/services/relay/__tests__/adapter-manager.test.ts`
- Route and MCP tool tests (can be inline or separate files)

**AdapterManager tests:**
```typescript
describe('AdapterManager', () => {
  it('initialize() reads config and starts enabled adapters', async () => { ... });
  it('initialize() skips disabled adapters', async () => { ... });
  it('reload() detects config changes and reconciles', async () => { ... });
  it('enable() updates config and starts adapter', async () => { ... });
  it('disable() updates config and stops adapter', async () => { ... });
  it('listAdapters() returns config + status for each adapter', async () => { ... });
  it('getAdapter() returns undefined for unknown ID', () => { ... });
  it('shutdown() stops all adapters and config watcher', async () => { ... });
  it('missing config file -> empty adapter list, no crash', async () => { ... });
  it('malformed config -> log warning, skip invalid entries', async () => { ... });
});
```

Mock `fs/promises` for config file reading/writing. Mock `chokidar` for config watcher. Mock `TelegramAdapter` and `WebhookAdapter` constructors.

**Adapter route integration tests** (supertest):
```typescript
describe('Adapter Routes', () => {
  it('GET /api/relay/adapters -> list of adapter statuses', async () => { ... });
  it('POST /api/relay/adapters/:id/enable -> adapter started', async () => { ... });
  it('POST /api/relay/adapters/:id/disable -> adapter stopped', async () => { ... });
  it('POST /api/relay/webhooks/:id with valid sig -> 200', async () => { ... });
  it('POST /api/relay/webhooks/:id with invalid sig -> 401', async () => { ... });
  it('POST /api/relay/webhooks/unknown -> 404', async () => { ... });
});
```

**Acceptance Criteria:**
- [ ] AdapterManager unit tests cover all public methods
- [ ] Edge cases tested: missing config, malformed config, unknown adapter type
- [ ] Route integration tests verify HTTP status codes and response shapes
- [ ] Webhook signature verification tested via supertest
- [ ] All tests pass: `npx vitest run`

---

## Phase 5: Client UI

### Task 18: [relay-external-adapters] [P5] Add useRelayAdapters and useToggleAdapter hooks

**Files to create:**
- `apps/client/src/layers/entities/relay/model/use-relay-adapters.ts`

**Modify:**
- `apps/client/src/layers/entities/relay/index.ts` (add exports)

**Implementation:**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { AdapterStatusZ, AdapterConfigZ } from '@dorkos/shared/relay-schemas';

interface AdapterListItem {
  config: AdapterConfigZ;
  status: AdapterStatusZ;
}

/**
 * Fetch all Relay adapter statuses with 10-second polling.
 */
export function useRelayAdapters() {
  const transport = useTransport();
  return useQuery({
    queryKey: ['relay/adapters'],
    queryFn: () => transport.get<AdapterListItem[]>('/api/relay/adapters'),
    refetchInterval: 10_000,
  });
}

/**
 * Mutation to enable or disable an adapter.
 * Invalidates adapter list on success.
 */
export function useToggleAdapter() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      transport.post(`/api/relay/adapters/${id}/${enabled ? 'enable' : 'disable'}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['relay/adapters'] }),
  });
}
```

Update barrel export:
```typescript
// In apps/client/src/layers/entities/relay/index.ts
export { useRelayAdapters, useToggleAdapter } from './model/use-relay-adapters';
```

**Acceptance Criteria:**
- [ ] `useRelayAdapters` hook fetches from `/api/relay/adapters` with 10s polling
- [ ] `useToggleAdapter` mutation calls enable/disable endpoint, invalidates query cache
- [ ] Hooks exported from entity barrel
- [ ] `npm run typecheck` passes

---

### Task 19: [relay-external-adapters] [P5] Add Adapters tab to RelayPanel

**Files to modify:**
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`

**Implementation:**

Add a third tab to the existing tab component:

```
Tabs: Activity | Endpoints | Adapters
```

The Adapters tab renders a list of `AdapterCard` components (Task 20). Uses `useRelayAdapters()` hook for data.

```tsx
// Inside RelayPanel.tsx tab content area
<TabsContent value="adapters">
  <AdapterList />
</TabsContent>
```

Create `AdapterList` as a simple wrapper that maps over `useRelayAdapters()` data:
```tsx
function AdapterList() {
  const { data: adapters, isLoading } = useRelayAdapters();
  const toggle = useToggleAdapter();

  if (isLoading) return <div className="p-4 text-muted-foreground">Loading adapters...</div>;
  if (!adapters?.length) return <div className="p-4 text-muted-foreground">No adapters configured</div>;

  return (
    <div className="space-y-2 p-2">
      {adapters.map(({ config, status }) => (
        <AdapterCard
          key={config.id}
          config={config}
          status={status}
          onToggle={(enabled) => toggle.mutate({ id: config.id, enabled })}
        />
      ))}
    </div>
  );
}
```

**Acceptance Criteria:**
- [ ] RelayPanel has three tabs: Activity, Endpoints, Adapters
- [ ] Adapters tab shows list of adapter cards
- [ ] Loading state shown while fetching
- [ ] Empty state shown when no adapters configured
- [ ] FSD layer rules respected (entities imported from barrel)

---

### Task 20: [relay-external-adapters] [P5] Create AdapterCard component

**Files to create:**
- `apps/client/src/layers/features/relay/ui/AdapterCard.tsx`

**Implementation:**

Each adapter card displays:
- Adapter name and type icon (use simple text labels: "TG" for Telegram, "WH" for webhook, or small SVG icons)
- Status badge: green dot = connected, gray = disconnected, red = error, yellow = starting/stopping
- Message counts (inbound / outbound)
- Enable/disable toggle (shadcn Switch component)
- Last error (if any, collapsed by default via Collapsible)

```tsx
import { Badge } from '@/layers/shared/ui';
import { Switch } from '@/layers/shared/ui';
import type { AdapterConfigZ, AdapterStatusZ } from '@dorkos/shared/relay-schemas';

interface AdapterCardProps {
  config: AdapterConfigZ;
  status: AdapterStatusZ;
  onToggle: (enabled: boolean) => void;
}

const STATUS_COLORS: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-gray-400',
  error: 'bg-red-500',
  starting: 'bg-yellow-500',
  stopping: 'bg-yellow-500',
};

export function AdapterCard({ config, status, onToggle }: AdapterCardProps) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <span className={`h-2 w-2 rounded-full ${STATUS_COLORS[status.state]}`} />
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">{config.id}</span>
            <Badge variant="outline">{config.type}</Badge>
          </div>
          <div className="text-xs text-muted-foreground">
            In: {status.messageCount.inbound} | Out: {status.messageCount.outbound}
            {status.errorCount > 0 && ` | Errors: ${status.errorCount}`}
          </div>
          {status.lastError && (
            <div className="mt-1 text-xs text-red-500">{status.lastError}</div>
          )}
        </div>
      </div>
      <Switch
        checked={config.enabled}
        onCheckedChange={(checked) => onToggle(checked)}
      />
    </div>
  );
}
```

**Acceptance Criteria:**
- [ ] Shows adapter name, type badge, status dot
- [ ] Status dot color: green=connected, gray=disconnected, red=error, yellow=starting/stopping
- [ ] Message counts displayed (inbound/outbound)
- [ ] Error count shown when > 0
- [ ] Last error displayed when present
- [ ] Enable/disable toggle via Switch component
- [ ] FSD layer rules respected (shared/ui imports only)

---

### Task 21: [relay-external-adapters] [P5] Enhance ActivityFeed with adapter event awareness

**Files to modify:**
- `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`

**Implementation:**

Enhance message rows with:
- Source indicator: Show a small badge or icon for adapter source (Telegram, webhook, system)
- Direction indicator: Inbound arrow (down) or outbound arrow (up) based on message `from` field
- Filter dropdown: All / Telegram / Webhook / System

The filter should be a Select component at the top of the activity feed:
```tsx
<Select value={filter} onValueChange={setFilter}>
  <SelectTrigger className="w-40">
    <SelectValue placeholder="Filter" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="all">All</SelectItem>
    <SelectItem value="telegram">Telegram</SelectItem>
    <SelectItem value="webhook">Webhook</SelectItem>
    <SelectItem value="system">System</SelectItem>
  </SelectContent>
</Select>
```

Filter logic: Check message subject prefix:
- `relay.human.telegram.*` -> telegram
- `relay.webhook.*` -> webhook
- Everything else -> system

**Acceptance Criteria:**
- [ ] Message rows show adapter source indicator
- [ ] Direction indicators for inbound/outbound
- [ ] Filter dropdown: All / Telegram / Webhook / System
- [ ] Filtering works correctly based on subject prefix
- [ ] Existing activity feed functionality preserved

---

### Task 22: [relay-external-adapters] [P5] Write tests for new client hooks and components

**Files to create:**
- `apps/client/src/layers/entities/relay/__tests__/use-relay-adapters.test.ts`
- `apps/client/src/layers/features/relay/__tests__/AdapterCard.test.tsx`

**Hook tests:**
```typescript
describe('useRelayAdapters', () => {
  it('fetches adapter list from transport', async () => { ... });
  it('polls every 10 seconds', async () => { ... });
});

describe('useToggleAdapter', () => {
  it('calls enable endpoint when enabled=true', async () => { ... });
  it('calls disable endpoint when enabled=false', async () => { ... });
  it('invalidates adapter query on success', async () => { ... });
});
```

**Component tests:**
```typescript
/**
 * @vitest-environment jsdom
 */
describe('AdapterCard', () => {
  it('renders adapter name and type', () => { ... });
  it('shows green dot for connected state', () => { ... });
  it('shows red dot for error state', () => { ... });
  it('displays message counts', () => { ... });
  it('shows last error when present', () => { ... });
  it('calls onToggle when switch is clicked', async () => { ... });
});
```

**Acceptance Criteria:**
- [ ] Hook tests verify fetch URL and polling interval
- [ ] Toggle mutation tests verify correct endpoint called
- [ ] Component tests verify rendering for all status states
- [ ] All tests pass

---

## Phase 6: Polish

### Task 23: [relay-external-adapters] [P6] Update ActivityFeedHero.tsx simulated data

**Files to modify:**
- `apps/web/src/layers/features/marketing/ui/ActivityFeedHero.tsx`

**Implementation:**

Replace the existing `ACTIVITY_POOL` with data shaped like real Relay events:

```typescript
const ACTIVITY_POOL: Array<Omit<FeedEntry, 'id' | 'secondsAgo'>> = [
  { module: 'relay', text: 'Delivered deployment notification to relay.human.telegram.ops' },
  { module: 'relay', text: 'Processed inbound webhook from relay.webhook.github' },
  { module: 'relay', text: 'Routed agent response to relay.human.telegram.group.support' },
  { module: 'relay', text: 'Sent order confirmation to relay.human.telegram.12345' },
  { module: 'relay', text: 'Adapter telegram-main connected — polling active' },
  // Keep existing non-relay entries from other modules (pulse, mesh, etc.)
];
```

Keep as static simulated data (no live server connection). The format now mirrors real subject hierarchy and event descriptions.

**Acceptance Criteria:**
- [ ] `ACTIVITY_POOL` relay entries updated to match real Relay subject format
- [ ] Non-relay entries preserved
- [ ] Still static simulated data (no server connection)
- [ ] `npm run build` passes for web app

---

### Task 24: [relay-external-adapters] [P6] Create contributing/relay-adapters.md developer guide

**Files to create:**
- `contributing/relay-adapters.md`

**Content outline:**
- How to implement the `RelayAdapter` interface
- Subject hierarchy conventions (`relay.human.{platform}.{id}`, `relay.webhook.{name}`)
- Adapter lifecycle (start, stop, hot-reload)
- Config file format (`~/.dork/relay/adapters.json`)
- Testing adapters (mock patterns, test helpers)
- Security: HMAC-SHA256 for webhooks, secret rotation
- Performance: rate limiting, per-chat limits, nonce pruning
- Example: creating a minimal adapter

**Acceptance Criteria:**
- [ ] Guide covers adapter interface implementation
- [ ] Config file format documented
- [ ] Testing patterns documented
- [ ] Security considerations documented

---

### Task 25: [relay-external-adapters] [P6] Update architecture docs with adapter registry section

**Files to modify:**
- `contributing/architecture.md`

**Implementation:**

Add a section under the existing Relay documentation:

```markdown
### Adapter Registry

The `AdapterRegistry` (in `packages/relay/`) manages external channel adapters that bridge
external communication platforms into the Relay subject hierarchy. The `AdapterManager`
(in `apps/server/src/services/relay/`) handles server-side lifecycle: config loading from
`~/.dork/relay/adapters.json`, chokidar hot-reload, and Express route integration.

Adapter flow: External message -> Adapter.handleInbound() -> RelayCore.publish()
             RelayCore.publish() -> AdapterRegistry.deliver() -> Adapter.deliver() -> External API

Built-in adapters: TelegramAdapter (grammY), WebhookAdapter (HMAC-SHA256).
```

**Acceptance Criteria:**
- [ ] Architecture doc updated with adapter registry section
- [ ] Data flow documented
- [ ] Adapter types listed
