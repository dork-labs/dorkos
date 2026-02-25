---
slug: relay-external-adapters
number: 53
created: 2026-02-24
status: specified
---

# Specification: Relay External Adapters

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-02-24
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## Overview

Build the external adapter system for Relay — a plugin interface that lets any external channel (Telegram, webhooks) become a set of endpoints on the Relay message bus. This is where Relay crosses the process boundary: Specs 1-2 built internal messaging (agent-to-agent, system-to-agent); this spec adds the ability for agents to communicate with the outside world through a normalized adapter interface.

The spec also restructures `apps/server/src/services/` into domain folders (relay/, pulse/, session/, core/) to address the 24-service threshold and accommodate the new adapter-related services cleanly.

## Background / Problem Statement

Relay currently operates as an internal-only message bus. Agents can send messages to other agents and system endpoints, but there is no mechanism to bridge external communication channels (Telegram, Slack, webhooks) into the subject hierarchy. This limits Relay's utility — agents cannot respond to Telegram messages, receive webhook notifications, or interact with humans on external platforms.

The `RelayAdapter` plugin interface was designed in the relay-litepaper and relay-design doc but has not been implemented. The marketing site's `ActivityFeedHero.tsx` uses a hardcoded `ACTIVITY_POOL` with simulated data that should be updated to match real Relay envelope shapes.

## Goals

- Define and implement the `RelayAdapter` plugin interface in `packages/relay/`
- Implement `AdapterRegistry` for adapter lifecycle management (register, unregister, hot-reload)
- Build a Telegram adapter using grammY as the reference implementation
- Build a webhook adapter for generic HTTP integrations with HMAC-SHA256 security
- Add adapter configuration at `~/.dork/relay/adapters.json` with chokidar hot-reload
- Add HTTP routes for adapter management (list, enable/disable, status)
- Add MCP tools for adapter management (agents can manage adapters programmatically)
- Update client Relay panel with adapter status display
- Update `ActivityFeedHero.tsx` simulated data to match Relay envelope format
- Restructure server services into domain folders

## Non-Goals

- Slack adapter (same interface, built in a future spec)
- Email adapter (SMTP complexity, built later)
- Voice/streaming adapter (OQ-7, separate design needed)
- Pulse/Console migration to Relay endpoints (Spec 5)
- `@grammyjs/runner` for high-load Telegram (simple polling is sufficient)
- Webhook mode for Telegram (long polling is the default; webhook is opt-in config only)
- Full Telegram Bot API features (inline keyboards, media groups, reactions) — text messages + standard attachments only in Phase 1

## Technical Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| `grammy` | `^1.x` | Telegram Bot API framework (TypeScript-first, 1.2M weekly downloads) |
| `@grammyjs/auto-retry` | `^2.x` | Automatic retry for 429 flood limits, 500 errors, network failures |
| `chokidar` | `^4.0.0` | Already in relay package — reuse for adapter config hot-reload |
| `@dorkos/relay` | workspace | RelayCore, types, existing infrastructure |
| `@dorkos/shared` | workspace | Zod schemas, types |

Both `grammy` and `@grammyjs/auto-retry` are added to `packages/relay/package.json` as dependencies (not peer deps) since the adapter implementations live in this package.

## Detailed Design

### 1. RelayAdapter Interface

Add to `packages/relay/src/types.ts`:

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

### 2. AdapterRegistry

New file: `packages/relay/src/adapter-registry.ts`

```typescript
export class AdapterRegistry {
  private adapters = new Map<string, RelayAdapter>();
  private relay: RelayCore | null = null;

  /** Set the RelayCore instance. Called once during initialization. */
  setRelay(relay: RelayCore): void;

  /** Register and start an adapter. If an adapter with the same ID exists, hot-reload it. */
  async register(adapter: RelayAdapter): Promise<void>;

  /** Unregister and stop an adapter by ID. */
  async unregister(id: string): Promise<boolean>;

  /** Get adapter by ID. */
  get(id: string): RelayAdapter | undefined;

  /** Find adapter whose subjectPrefix matches a given subject. */
  getBySubject(subject: string): RelayAdapter | undefined;

  /** List all registered adapters. */
  list(): RelayAdapter[];

  /** Deliver a message to the matching adapter (called by RelayCore publish pipeline). */
  async deliver(subject: string, envelope: RelayEnvelope): Promise<boolean>;

  /** Stop all adapters gracefully. Uses Promise.allSettled for error isolation. */
  async shutdown(): Promise<void>;
}
```

**Hot-reload sequence** (no message gap):
1. Create new adapter instance with updated config
2. `await newAdapter.start(relay)` — if this throws, abort reload, old instance stays active
3. `registry.set(id, newAdapter)` — register new (now live)
4. `await oldAdapter.stop()` — stop old (drain in-flight)

**Error isolation**: All multi-adapter operations use `Promise.allSettled()`:
```typescript
async shutdown(): Promise<void> {
  const results = await Promise.allSettled(
    [...this.adapters.values()].map(a => a.stop())
  );
  // Log failures but don't throw — all adapters get a chance to stop
}
```

### 3. RelayCore Integration

Modify `packages/relay/src/relay-core.ts` to integrate the adapter registry:

**Constructor change**: Accept optional `adapterRegistry` in `RelayOptions`:
```typescript
export interface RelayOptions {
  dataDir?: string;
  maxHops?: number;
  defaultTtlMs?: number;
  defaultCallBudget?: number;
  reliability?: ReliabilityConfig;
  adapterRegistry?: AdapterRegistry;  // NEW
}
```

**Publish pipeline modification** (after endpoint delivery, before returning result):
```typescript
// After delivering to Maildir endpoints, also deliver to matching adapters
if (this.adapterRegistry) {
  const adapterDelivered = await this.adapterRegistry.deliver(subject, envelope);
  if (adapterDelivered) {
    result.deliveredTo.push({ type: 'adapter', subject });
  }
}
```

**No other changes to RelayCore** — the adapter registry is a composable addition, not a replacement of existing delivery.

### 4. Telegram Adapter

New file: `packages/relay/src/adapters/telegram-adapter.ts`

**Dependencies**: `grammy`, `@grammyjs/auto-retry`

**Subject mapping**:
- DM: `relay.human.telegram.{chatId}` (positive chat IDs)
- Group: `relay.human.telegram.group.{chatId}` (negative chat IDs)

**Inbound flow** (Telegram → Relay):
1. grammY `bot.on('message')` handler receives Telegram update
2. Extract chat ID, sender info, message text/attachments
3. Build `StandardPayload` with `responseContext: { platform: 'telegram', maxLength: 4096, supportedFormats: ['text', 'markdown'] }`
4. Call `relay.publish(subject, payload, { from: 'relay.human.telegram.{chatId}' })`

**Outbound flow** (Relay → Telegram):
1. `deliver(subject, envelope)` called by AdapterRegistry
2. Extract chat ID from subject: `relay.human.telegram.{chatId}` → chatId
3. Extract text from `envelope.payload` (as `StandardPayload`)
4. Call `bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' })`
5. Enforce per-chat rate limit: 1 msg/s with `lastSentAt` Map

**Typing signals**:
- Inbound: When Relay signal `typing` is published to a telegram subject, call `bot.api.sendChatAction(chatId, 'typing')`
- Outbound: Not implemented in Phase 1 (Telegram doesn't expose typing events for bots)

**Lifecycle**:
```typescript
async start(relay: RelayCore): Promise<void> {
  this.relay = relay;
  this.bot = new Bot(this.config.token);
  this.bot.api.config.use(autoRetry());
  this.bot.catch((err) => { /* log, increment errorCount */ });

  // Register message handlers
  this.bot.on('message', async (ctx) => { /* inbound flow */ });

  // Subscribe to Relay signals for typing
  this.signalUnsub = relay.onSignal(this.subjectPrefix + '.>', (subject, signal) => {
    if (signal.type === 'typing') { /* sendChatAction */ }
  });

  // Start long polling (non-blocking)
  this.bot.start({ onStart: () => { this.status.state = 'connected'; } });
}

async stop(): Promise<void> {
  this.status.state = 'stopping';
  if (this.signalUnsub) this.signalUnsub();
  await this.bot?.stop();  // Drains updates, async
  this.status.state = 'disconnected';
}
```

### 5. Webhook Adapter

New file: `packages/relay/src/adapters/webhook-adapter.ts`

**Inbound flow** (HTTP POST → Relay):
1. Express route at `/api/relay/webhooks/{adapterId}` receives POST
2. Raw body captured via Express `verify` callback
3. Verify HMAC-SHA256: `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`
4. Verify timestamp window: reject if `|now - timestamp| > 300s`
5. Check nonce: reject if already seen in nonce Map
6. Parse body, build `StandardPayload` with `responseContext: { platform: 'webhook' }`
7. Publish to configured subject

**Outbound flow** (Relay → HTTP POST):
1. `deliver(subject, envelope)` called by AdapterRegistry
2. Build request body from envelope payload
3. Generate timestamp + HMAC-SHA256 signature
4. POST to configured URL with headers: `X-Signature`, `X-Timestamp`, `X-Nonce`

**Security implementation**:
```typescript
function verifySignature(
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
    const expectedPrev = crypto.createHmac('sha256', previousSecret).update(message).digest();
    return received.length === expectedPrev.length && crypto.timingSafeEqual(received, expectedPrev);
  }

  return false;
}
```

**Nonce tracking**:
```typescript
private nonceMap = new Map<string, number>(); // nonce → expiresAt
private nonceInterval: NodeJS.Timeout;

// Prune every 5 minutes
this.nonceInterval = setInterval(() => {
  const now = Date.now();
  for (const [nonce, expires] of this.nonceMap) {
    if (now > expires) this.nonceMap.delete(nonce);
  }
}, 5 * 60 * 1000);
```

### 6. Adapter Lifecycle Management

New file: `apps/server/src/services/relay/adapter-manager.ts`

**Responsibilities**:
- Load adapter config from `~/.dork/relay/adapters.json`
- Instantiate and start adapters based on config
- Watch config file for changes (chokidar), hot-reload adapters
- Expose adapter list and status to routes and MCP tools
- Graceful shutdown

```typescript
export class AdapterManager {
  private registry: AdapterRegistry;
  private configWatcher: FSWatcher | null = null;
  private configPath: string;

  constructor(relay: RelayCore, configPath: string);

  /** Load config and start all enabled adapters. */
  async initialize(): Promise<void>;

  /** Reload config from disk and reconcile adapter state. */
  async reload(): Promise<void>;

  /** Enable a specific adapter by ID. */
  async enable(id: string): Promise<void>;

  /** Disable a specific adapter by ID. */
  async disable(id: string): Promise<void>;

  /** Get all adapter statuses. */
  listAdapters(): Array<{ config: AdapterConfig; status: AdapterStatus }>;

  /** Get single adapter status. */
  getAdapter(id: string): { config: AdapterConfig; status: AdapterStatus } | undefined;

  /** Stop all adapters and config watcher. */
  async shutdown(): Promise<void>;
}
```

**Config file format** (`~/.dork/relay/adapters.json`):
```json
{
  "adapters": [
    {
      "id": "telegram-main",
      "type": "telegram",
      "enabled": true,
      "config": {
        "token": "123456:ABC-DEF...",
        "mode": "polling"
      }
    },
    {
      "id": "webhook-github",
      "type": "webhook",
      "enabled": true,
      "config": {
        "inbound": {
          "subject": "relay.webhook.github",
          "secret": "whsec_..."
        },
        "outbound": {
          "url": "https://example.com/hook",
          "secret": "whsec_..."
        }
      }
    }
  ]
}
```

**Hot-reload via chokidar**:
```typescript
this.configWatcher = chokidar.watch(this.configPath, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
});
this.configWatcher.on('change', () => this.reload());
```

### 7. Webhook Inbound Route

The webhook adapter needs an Express route to receive inbound POSTs. This is mounted as part of the relay routes:

```typescript
// In routes/relay.ts (extended)
router.post('/webhooks/:adapterId', express.raw({ type: '*/*' }), (req, res) => {
  const adapter = adapterManager.getAdapter(req.params.adapterId);
  if (!adapter || adapter.config.type !== 'webhook') {
    return res.status(404).json({ error: 'Webhook adapter not found' });
  }
  // Adapter handles verification and publishing internally
  adapter.instance.handleInbound(req.body, req.headers);
  res.status(200).json({ ok: true });
});
```

**Raw body capture**: Use `express.raw()` middleware specifically for webhook routes to preserve the raw body for HMAC verification. This avoids needing the Express `verify` callback on the global body parser.

### 8. HTTP Routes for Adapter Management

Add to `apps/server/src/routes/relay.ts` (extended, not a separate file):

| Method | Path | Handler |
|--------|------|---------|
| GET | `/adapters` | List all adapters with status |
| GET | `/adapters/:id` | Get single adapter status |
| POST | `/adapters/:id/enable` | Enable adapter |
| POST | `/adapters/:id/disable` | Disable adapter |
| POST | `/adapters/reload` | Trigger config hot-reload |
| POST | `/webhooks/:adapterId` | Inbound webhook receiver |

All adapter routes are nested under the existing `/api/relay/` prefix. The router factory signature changes:

```typescript
export function createRelayRouter(
  relayCore: RelayCore,
  adapterManager?: AdapterManager,  // NEW — optional for backward compat
): Router;
```

### 9. MCP Tools for Adapter Management

Add to `apps/server/src/services/mcp-tool-server.ts`:

| Tool | Description |
|------|-------------|
| `relay_list_adapters` | List all adapters with status |
| `relay_enable_adapter(id)` | Enable an adapter |
| `relay_disable_adapter(id)` | Disable an adapter |
| `relay_reload_adapters` | Trigger config hot-reload |

**McpToolDeps extension**:
```typescript
export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  defaultCwd: string;
  pulseStore?: PulseStore;
  relayCore?: RelayCore;
  adapterManager?: AdapterManager;  // NEW
}
```

### 10. Zod Schemas

Add to `packages/shared/src/relay-schemas.ts`:

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

### 11. Client UI Updates

**RelayPanel.tsx** — Add Adapters tab:
```
Tabs: Activity | Endpoints | Adapters
```

The Adapters tab shows a list of adapter cards, each displaying:
- Adapter name and type icon (Telegram logo / webhook icon)
- Status badge: green dot = connected, gray = disconnected, red = error
- Message counts (inbound/outbound)
- Enable/disable toggle
- Last error (if any, collapsed by default)

**New entity hooks** (`apps/client/src/layers/entities/relay/`):

```typescript
// use-relay-adapters.ts
export function useRelayAdapters() {
  return useQuery({
    queryKey: ['relay/adapters'],
    queryFn: () => transport.get<AdapterStatus[]>('/api/relay/adapters'),
    refetchInterval: 10_000, // Poll every 10s for status updates
  });
}

export function useToggleAdapter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      transport.post(`/api/relay/adapters/${id}/${enabled ? 'enable' : 'disable'}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['relay/adapters'] }),
  });
}
```

**ActivityFeed.tsx** — Enhance with adapter event awareness:
- Show adapter source in message rows (Telegram icon, webhook icon)
- Direction indicator (inbound arrow, outbound arrow)
- Filter dropdown: All / Telegram / Webhook / System

### 12. ActivityFeedHero.tsx Update

Replace `ACTIVITY_POOL` in `apps/web/src/layers/features/marketing/ui/ActivityFeedHero.tsx` with data shaped like real Relay events:

```typescript
const ACTIVITY_POOL: Array<Omit<FeedEntry, 'id' | 'secondsAgo'>> = [
  { module: 'relay', text: 'Delivered deployment notification to relay.human.telegram.ops' },
  { module: 'relay', text: 'Processed inbound webhook from relay.webhook.github' },
  { module: 'relay', text: 'Routed agent response to relay.human.telegram.group.support' },
  { module: 'relay', text: 'Sent order confirmation to relay.human.telegram.12345' },
  { module: 'relay', text: 'Adapter telegram-main connected — polling active' },
];
```

Keep as static simulated data — no live server connection. The format now mirrors real subject hierarchy and event descriptions.

### 13. Server Service Restructuring

Reorganize `apps/server/src/services/` from flat to domain-grouped:

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
    ├── relay-state.ts
    └── adapter-manager.ts    # NEW
```

**Import path update strategy**: All imports within `apps/server/` that reference `../services/foo.ts` must be updated to `../services/{domain}/foo.ts`. This is a mechanical find-and-replace per file. Route files, `index.ts`, and `lib/` are the primary consumers.

Each domain folder gets a barrel `index.ts` for cleaner imports:
```typescript
// services/session/index.ts
export { SessionBroadcaster } from './session-broadcaster';
export { SessionLock } from './session-lock';
// etc.
```

## User Experience

### Adapter Setup Flow
1. User creates a Telegram bot via @BotFather, receives a token
2. User creates/edits `~/.dork/relay/adapters.json` with Telegram config
3. Server detects config change, starts Telegram adapter
4. Client Relay panel shows "telegram-main: Connected" with green badge
5. Telegram messages appear in ActivityFeed as inbound events
6. Agents can send messages back to Telegram via `relay.publish('relay.human.telegram.{chatId}', ...)`

### Webhook Setup Flow
1. User configures a webhook adapter in `adapters.json` with secret and subject
2. External service sends POST to `http://localhost:4242/api/relay/webhooks/{adapterId}`
3. Server verifies HMAC signature, publishes to configured Relay subject
4. Agent receives message via subscription, can respond via outbound webhook

### Adapter Management
- View adapter status in Relay panel Adapters tab
- Enable/disable adapters via toggle (persists to config file)
- Agents can manage adapters via MCP tools (list, enable, disable, reload)

## Testing Strategy

### Unit Tests

**AdapterRegistry** (`packages/relay/src/__tests__/adapter-registry.test.ts`):
- Register adapter → appears in list
- Unregister adapter → removed, stop() called
- deliver() routes to correct adapter by subject prefix
- deliver() returns false when no adapter matches
- shutdown() calls stop() on all adapters via Promise.allSettled
- Hot-reload: new adapter starts before old stops
- Hot-reload: if new start() throws, old adapter stays active
- Error isolation: one adapter stop() rejection doesn't prevent others

**TelegramAdapter** (`packages/relay/src/adapters/__tests__/telegram-adapter.test.ts`):
- Mock `grammy` Bot class: `vi.mock('grammy')`
- start() creates bot, registers handlers, begins polling
- stop() calls bot.stop() (async)
- Inbound message → relay.publish() called with correct subject and StandardPayload
- Outbound deliver() → bot.api.sendMessage() called with correct chat ID
- Per-chat rate limiting: second message within 1s is delayed
- getStatus() reflects connected/disconnected/error states
- Group messages map to relay.human.telegram.group.{chatId}

**WebhookAdapter** (`packages/relay/src/adapters/__tests__/webhook-adapter.test.ts`):
- Valid HMAC + timestamp → message published to Relay
- Invalid HMAC → rejected with 401
- Expired timestamp (> 300s) → rejected
- Replayed nonce → rejected
- Dual-secret rotation: old secret still accepted during transition
- Outbound deliver() → HTTP POST with correct HMAC headers
- Nonce map prunes expired entries

**AdapterManager** (`apps/server/src/services/relay/__tests__/adapter-manager.test.ts`):
- initialize() reads config, starts enabled adapters
- reload() detects config changes, reconciles adapter state
- enable()/disable() update config and adapter lifecycle
- shutdown() stops all adapters and config watcher
- Missing config file → empty adapter list, no crash
- Malformed config → log warning, skip invalid entries

### Integration Tests

**Webhook receiver** (supertest):
- POST to `/api/relay/webhooks/{id}` with valid signature → 200
- POST with invalid signature → 401
- POST to nonexistent adapter → 404

**Adapter routes** (supertest):
- GET `/api/relay/adapters` → list of adapter statuses
- POST `/api/relay/adapters/:id/enable` → adapter started
- POST `/api/relay/adapters/:id/disable` → adapter stopped

### Test Helpers

```typescript
// test-utils: createMockAdapter()
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

// test-utils: signPayload() for webhook tests
export function signPayload(body: string, secret: string, timestamp?: number): {
  signature: string;
  timestamp: string;
  nonce: string;
};
```

## Performance Considerations

- **grammY simple polling**: Sufficient for ~5K messages/hour. If load grows beyond this, upgrade to `@grammyjs/runner` (separate spec)
- **Per-chat Telegram rate limit**: 1 msg/s per chat enforced with `lastSentAt` Map + exponential backoff on 429
- **Nonce Map memory**: Pruned every 5 minutes. At 1000 webhooks/hour, the map holds ~24K entries max (24h TTL) — negligible memory
- **chokidar config watching**: `awaitWriteFinish: { stabilityThreshold: 150 }` prevents partial-write reloads
- **Adapter deliver() isolation**: Promise.allSettled() ensures one slow adapter doesn't block others
- **SSE activity feed**: 50ms debounce on incoming events batches React renders; existing pattern from useRelayEventStream

## Security Considerations

- **Secret storage**: Adapter tokens and webhook secrets stored in `~/.dork/relay/adapters.json`. File permissions should be 0600. Never logged — use HMAC of secret as stable debug identifier
- **HMAC verification**: Always use `crypto.timingSafeEqual()` — string `===` is vulnerable to timing attacks
- **Timestamp window**: ±300 seconds (Stripe standard) prevents replay of old requests
- **Nonce tracking**: In-memory Map with 24h TTL prevents replay within the timestamp window. Scoped by adapter ID: `${adapterId}:${nonce}`
- **Dual-secret rotation**: Verify against both current and previous secret during 24h transition window
- **Budget enforcement**: Relay budget envelopes still apply to external messages — prevents agents from spamming external channels via adapters
- **Raw body capture**: Webhook routes use `express.raw()` middleware to preserve raw body for HMAC verification (before JSON parsing)
- **Telegram privacy mode**: Bot only receives commands and replies in groups by default. Must be documented — users need to disable privacy mode via @BotFather for full group access
- **Nonce persistence caveat**: In-memory Map loses history on server restart — brief replay window. Acceptable for single-process DorkOS; Redis is the upgrade path if needed

## Documentation

- Add `contributing/relay-adapters.md` — adapter development guide (how to implement RelayAdapter interface)
- Update `contributing/architecture.md` — add adapter registry to Relay section
- Update `docs/plans/relay-specs/04-relay-external-adapters.md` — mark as in-progress
- Add inline TSDoc to all public adapter APIs

## Implementation Phases

### Phase 1: Core Infrastructure
1. Add `RelayAdapter` interface and `AdapterConfig` types to `packages/relay/src/types.ts`
2. Create `AdapterRegistry` class in `packages/relay/src/adapter-registry.ts`
3. Integrate `AdapterRegistry` into `RelayCore` publish pipeline
4. Add adapter Zod schemas to `packages/shared/src/relay-schemas.ts`
5. Export new types from `packages/relay/src/index.ts`
6. Tests for AdapterRegistry

### Phase 2: Server Service Restructuring
7. Create domain folders under `apps/server/src/services/` (core/, session/, pulse/, relay/)
8. Move services into appropriate domain folders
9. Update all import paths across `apps/server/`
10. Add barrel exports for each domain folder
11. Verify all existing tests still pass

### Phase 3: Adapter Implementations
12. Install `grammy` and `@grammyjs/auto-retry` in `packages/relay/`
13. Implement Telegram adapter in `packages/relay/src/adapters/telegram-adapter.ts`
14. Implement webhook adapter in `packages/relay/src/adapters/webhook-adapter.ts`
15. Tests for both adapters (mocked external APIs)

### Phase 4: Server Integration
16. Create `AdapterManager` in `apps/server/src/services/relay/adapter-manager.ts`
17. Add adapter routes to `apps/server/src/routes/relay.ts`
18. Add adapter MCP tools to `apps/server/src/services/core/mcp-tool-server.ts`
19. Update `apps/server/src/index.ts` — initialize AdapterManager, update SIGTERM ordering
20. Tests for AdapterManager, routes, MCP tools

### Phase 5: Client UI
21. Add `useRelayAdapters` and `useToggleAdapter` hooks to `apps/client/src/layers/entities/relay/`
22. Add Adapters tab to `RelayPanel.tsx`
23. Create adapter status card component
24. Enhance `ActivityFeed.tsx` with adapter event awareness and filtering
25. Tests for new hooks and components

### Phase 6: Polish
26. Update `ActivityFeedHero.tsx` simulated data to match Relay envelope format
27. Add `contributing/relay-adapters.md` developer guide
28. Update `contributing/architecture.md` with adapter registry docs
29. Final integration testing

## Open Questions

*No open questions — all decisions resolved during ideation.*

## Related ADRs

- **ADR-0010**: Use Maildir for Relay Message Storage — adapters sit on top of Maildir delivery
- **ADR-0011**: Use NATS-style Subject Matching — adapters use subject prefixes for routing
- **ADR-0012**: Use ULID for Message IDs — adapter messages get ULIDs like all Relay messages
- **ADR-0013**: Use Hybrid Maildir + SQLite for Relay Storage — adapters don't bypass this
- **ADR-0017**: Standardize Subsystem Integration Pattern — AdapterManager follows this pattern
- **ADR-0018**: Server-side SSE Subject Filtering — activity feed uses this for adapter events

## References

- [Ideation document](./01-ideation.md) — full research, codebase map, resolved decisions
- [Relay litepaper](../../meta/modules/relay-litepaper.md) — "External Channels: The Adapter Model" section
- [Relay design doc](../../docs/plans/2026-02-24-relay-design.md) — RelayAdapter interface (lines 239-262), group messages (lines 389-405), Console activity feed (lines 458-476)
- [Relay spec plan](../../docs/plans/relay-specs/04-relay-external-adapters.md) — spec metadata and verification criteria
- [grammY documentation](https://grammy.dev/) — Telegram bot framework
- [grammY auto-retry plugin](https://grammy.dev/plugins/auto-retry) — rate limit and error recovery
- [grammY error handling](https://grammy.dev/guide/errors) — GrammyError, HttpError types
- [grammY long polling vs webhooks](https://grammy.dev/guide/deployment-types) — deployment mode comparison
- [Webhook signature verification (Hookdeck)](https://hookdeck.com/webhooks/guides/how-to-implement-sha256-webhook-signature-verification) — HMAC-SHA256 patterns
- [Webhook replay prevention (webhooks.fyi)](https://webhooks.fyi/security/replay-prevention) — timestamp + nonce approach
