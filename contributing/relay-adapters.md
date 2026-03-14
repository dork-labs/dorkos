# Relay Adapters

External channel adapters bridge communication platforms (Telegram, webhooks, etc.) into the Relay subject hierarchy. This guide covers the adapter architecture, lifecycle, and patterns for building and testing custom adapters.

## Overview

Adapters implement the `RelayAdapter` plugin interface, which defines a contract for:

- **Inbound**: Converting messages from external channels into Relay envelopes published to specific subjects
- **Outbound**: Converting Relay envelopes into external channel messages

The adapter is responsible for:

1. Connecting to and authenticating with the external service
2. Normalizing messages into a common format (e.g., `StandardPayload`)
3. Registering Relay endpoints so agents can receive notifications
4. Handling lifecycle transitions gracefully (startup, shutdown, hot-reload)
5. Recording status and error telemetry

## RelayAdapter Interface

The core contract that all adapters must implement:

```typescript
interface RelayAdapter {
  readonly id: string;                                          // Unique identifier
  readonly subjectPrefix: string | readonly string[];           // Subject prefix(es) (e.g. 'relay.human.telegram')
  readonly displayName: string;                                 // Human-readable name

  start(relay: RelayPublisher): Promise<void>;                  // Connect and register
  stop(): Promise<void>;                                        // Disconnect gracefully
  deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult>;  // Send outbound message
  getStatus(): AdapterStatus;                                   // Current runtime status
  testConnection?(): Promise<{ ok: boolean; error?: string }>; // Optional lightweight credential check
}
```

### Properties

| Property         | Type    | Purpose                                                   |
| ---------------- | ------- | --------------------------------------------------------- |
| `id`             | string  | Unique adapter ID (e.g., `'telegram'`, `'webhook-github'`) used for storage and lifecycle management. Multiple adapter instances can exist; the ID disambiguates them. |
| `subjectPrefix`  | string \| readonly string[]  | The Relay subject prefix(es) this adapter handles (e.g., `'relay.human.telegram'`). Can be an array for adapters that handle multiple prefixes. Used by AdapterRegistry to route outbound messages to the correct adapter. |
| `displayName`    | string  | Human-readable name shown in adapter status UI (e.g., `'Telegram'`, `'Webhook (GitHub)'`). Useful when multiple Telegram adapters exist. |

### Methods

#### `start(relay: RelayPublisher): Promise<void>`

Called on adapter startup or hot-reload. Connects to the external service, registers Relay endpoints, and subscribes to signals.

**Requirements:**

- Must be idempotent — safe to call if already started
- Should throw if configuration is invalid (e.g., missing token)
- Should update status to `'connected'` on successful connection

**Typical implementation:**

```typescript
async start(relay: RelayPublisher): Promise<void> {
  if (this.bot !== null) return; // Already started

  this.relay = relay;
  this.status.state = 'starting';

  // Connect to external service
  this.bot = new Bot(this.config.token);

  // Subscribe to relay signals (e.g., typing indicators)
  this.signalUnsub = relay.onSignal(`${SUBJECT_PREFIX}.>`, (subject, signal) => {
    this.handleSignal(subject, signal);
  });

  this.status.state = 'connected';
}
```

#### `stop(): Promise<void>`

Called on adapter shutdown or during hot-reload before the new adapter is registered. Must drain in-flight messages and clean up all resources.

**Requirements:**

- Must be idempotent — safe to call if already stopped
- Should NOT throw; errors are logged and isolated
- Should unsubscribe from relay signals
- Should close external service connections

**Typical implementation:**

```typescript
async stop(): Promise<void> {
  if (this.bot === null) return; // Already stopped

  this.status.state = 'stopping';

  if (this.signalUnsub) {
    this.signalUnsub();
    this.signalUnsub = null;
  }

  try {
    if (this.config.mode === 'polling') {
      await this.bot.stop();
    }
  } catch (err) {
    this.recordError(err);
  } finally {
    this.bot = null;
    this.relay = null;
    this.status.state = 'disconnected';
  }
}
```

#### `deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult>`

Called by RelayCore when a published message matches this adapter's `subjectPrefix`. Extracts the message content from the envelope and sends it via the external channel. The optional `AdapterContext` provides rich context about the delivery target (e.g., Mesh agent manifest, trace context).

**Requirements:**

- Should extract the chat/channel identifier from the subject
- Should handle outbound message formatting and size limits
- Should return `{ success: true, durationMs }` on success or `{ success: false, error, durationMs }` on failure

**Typical implementation:**

```typescript
async deliver(subject: string, envelope: RelayEnvelope, _context?: AdapterContext): Promise<DeliveryResult> {
  const start = Date.now();
  const chatId = extractChatIdFromSubject(subject);
  const content = extractContent(envelope.payload);

  try {
    await this.externalService.send(chatId, content);
    this.status.messageCount.outbound++;
    return { success: true, durationMs: Date.now() - start };
  } catch (err) {
    this.recordError(err);
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message, durationMs: Date.now() - start };
  }
}
```

#### `getStatus(): AdapterStatus`

Returns a snapshot of the adapter's current runtime state. Used by the client to display adapter health in the UI.

**Result type:**

```typescript
type AdapterStatus = Pick<
  SharedAdapterStatus,
  'state' | 'messageCount' | 'errorCount' | 'lastError' | 'lastErrorAt' | 'startedAt'
> & {
  queuedMessages?: number; // Agents with queued messages pending delivery
};
```

`SharedAdapterStatus` is defined in `@dorkos/shared/relay-schemas`. The `id`, `type`, and `displayName` fields are added by `AdapterManager` when building catalog entries — adapters only track runtime state.

**Implementation:**

```typescript
getStatus(): AdapterStatus {
  return { ...this.status }; // Return a shallow copy to prevent mutation
}
```

#### `testConnection?(): Promise<{ ok: boolean; error?: string }>`

Optional method for lightweight credential validation without starting the full adapter lifecycle. When present, `AdapterManager.testConnection()` calls this instead of the heavier `start()`/`stop()` cycle. This avoids side effects like Telegram's 409 Conflict error when a polling session lingers.

If absent, `AdapterManager` falls back to creating a temporary adapter instance and calling `start()`/`stop()` to test connectivity.

## Subject Hierarchy

Adapters publish inbound messages to subjects following these conventions:

### Human Channels

- **Telegram DMs**: `relay.human.telegram.{chatId}`
- **Telegram Groups**: `relay.human.telegram.group.{chatId}`
- **Slack DMs**: `relay.human.slack.{userId}`
- **Slack Channels**: `relay.human.slack.channel.{channelId}`

### Webhooks

- **Generic Webhook**: `relay.webhook.{adapterId}` (subject is the inbound subject from config)
- **GitHub**: `relay.webhook.github`
- **Stripe**: `relay.webhook.stripe`

The subject prefix is configurable per adapter instance, allowing multiple webhook adapters to coexist.

## Adapter Lifecycle

The adapter follows a simple state machine managed by AdapterRegistry:

```
                    +
                    | register()
                    v
  +---------+    start()    +----------+
  |         |  <--------->  |          |
  | stopped |               | running  |
  |         |  <--------->  |          |
  +---------+    stop()     +----------+
                    ^
                    | unregister() or shutdown()
                    +
```

### Hot-Reload Sequence

When a configuration change requires restarting an adapter:

1. **New adapter is created** (different instance, same ID)
2. **`registry.register(newAdapter)`** is called
3. Inside `register()`:
   - `newAdapter.start(relay)` is called first
   - If successful, the new adapter is swapped into the registry
   - The old adapter's `stop()` is called (non-blocking)
   - If the new adapter fails to start, the old adapter stays active

This ensures zero-downtime restarts — the new adapter is already handling messages before the old one is shut down.

### Implementation Pattern

To support hot-reload, both `start()` and `stop()` must be idempotent. Common pattern:

```typescript
private isRunning = false;

async start(relay: RelayPublisher): Promise<void> {
  if (this.isRunning) return; // Already started

  this.isRunning = true;
  this.relay = relay;
  // ... connect and initialize
}

async stop(): Promise<void> {
  if (!this.isRunning) return; // Already stopped

  this.isRunning = false;
  // ... disconnect
}
```

## Config File Format

Adapter configurations are persisted in `~/.dork/relay/adapters.json`:

```json
{
  "adapters": [
    {
      "id": "my-telegram",
      "type": "telegram",
      "enabled": true,
      "config": {
        "token": "123456:ABC...",
        "mode": "polling"
      }
    },
    {
      "id": "github-webhook",
      "type": "webhook",
      "enabled": false,
      "config": {
        "inbound": {
          "subject": "relay.webhook.github",
          "secret": "webhook-secret-min-16-chars"
        },
        "outbound": {
          "url": "https://myserver.com/relay-out",
          "secret": "outbound-secret-min-16",
          "headers": { "Authorization": "Bearer token" }
        }
      }
    }
  ]
}
```

### Schema

```typescript
interface AdapterConfig {
  id: string;                           // Unique adapter ID
  type: 'telegram' | 'webhook' | 'claude-code' | 'plugin';  // Adapter type
  enabled: boolean;                     // Whether this adapter should be running
  plugin?: PluginSource;                // Required when type is 'plugin'
  config: TelegramAdapterConfig | WebhookAdapterConfig | Record<string, unknown>;  // Type-specific config
}

interface TelegramAdapterConfig {
  token: string;                        // Telegram bot token
  mode: 'polling' | 'webhook';          // Update delivery mode
  webhookUrl?: string;                  // Required if mode is 'webhook'
  webhookPort?: number;                 // Optional, defaults to 8443
}

interface WebhookAdapterConfig {
  inbound: {
    subject: string;                    // Relay subject to publish to
    secret: string;                     // HMAC-SHA256 secret (min 16 chars)
    previousSecret?: string;            // Previous secret for rotation (24h window)
  };
  outbound: {
    url: string;                        // URL to POST outbound messages to
    secret: string;                     // HMAC-SHA256 secret for signing
    headers?: Record<string, string>;    // Custom headers to include
  };
}
```

The config is loaded by `AdapterManager` and watched for changes. When modified, adapters are hot-reloaded via the registry.

## Built-in Adapters

### TelegramAdapter

Bridges Telegram chats into the Relay subject hierarchy using the Telegram Bot API via grammy.

**Subject Convention:**

- DMs: `relay.human.telegram.{chatId}`
- Groups: `relay.human.telegram.group.{chatId}`

**Inbound:**

Receives Telegram messages via polling or webhook. Normalizes them into `StandardPayload`:

```typescript
interface StandardPayload {
  content: string;
  senderName: string;
  channelName?: string;                 // Group/channel name
  channelType: 'dm' | 'group';
  responseContext: {
    platform: 'telegram';
    maxLength: number;                   // 4096 for Telegram
    supportedFormats: string[];
    instructions: string;
  };
  platformData: {
    chatId: number;
    messageId: number;
    chatType: string;
    fromId?: number;
    username?: string;
  };
}
```

**Outbound:**

Sends Relay envelopes as Telegram messages. Truncates content to Telegram's 4096-character limit.

**Typing Signals:**

Subscribes to `relay.human.telegram.>` signals and forwards typing actions to Telegram via `sendChatAction('typing')`.

**Modes:**

- **Polling** (non-blocking): grammy's long-polling runs in the background. Idempotent and simple; suitable for development and low-volume bots.
- **Webhook** (production): Opens a node:http server listening on a configured port. Requires ngrok or a public URL; more resource-efficient at scale.

**Example Configuration:**

```json
{
  "id": "telegram",
  "type": "telegram",
  "enabled": true,
  "config": {
    "token": "123456:ABC...",
    "mode": "polling"
  }
}
```

### WebhookAdapter

Bridges generic HTTP webhooks into the Relay subject hierarchy. Provides both inbound and outbound webhook support with HMAC-SHA256 security.

**Inbound:**

Receives HTTP POST requests at `POST /api/relay/webhooks/:adapterId`. Verifies HMAC-SHA256 signature and replay protection, then publishes to the configured subject.

**Security Pipeline:**

1. Timestamp window check (±300 seconds) — prevents replays from expired tokens
2. Nonce replay check (24h TTL) — prevents replays within the window
3. HMAC-SHA256 verification — tries current secret, then previous secret (for rotation)
4. Nonce registration — stores nonce with TTL

**Signature Format (Stripe-style):**

```
Message = {timestamp}.{rawBody}
Signature = HMAC-SHA256(Message, secret)
```

Request headers:

```
X-Timestamp: {unix_seconds}
X-Signature: {hex_encoded_signature}
X-Nonce: {uuid}
```

**Outbound:**

Sends HTTP POST to the configured outbound URL, signed with outbound secret. Same message and signature format.

**Secret Rotation:**

The adapter supports dual-secret rotation for zero-downtime secret changes:

1. Add the new secret to `config.inbound.previousSecret`
2. Wait for all in-flight requests with the old secret to be processed (within the 300-second timestamp window)
3. Update `config.inbound.secret` to the new secret
4. Wait 24 hours for nonce TTL to expire, then remove `previousSecret`

**Example Configuration:**

```json
{
  "id": "github",
  "type": "webhook",
  "enabled": true,
  "config": {
    "inbound": {
      "subject": "relay.webhook.github",
      "secret": "webhook-secret-from-github-settings"
    },
    "outbound": {
      "url": "https://myserver.com/relay/github",
      "secret": "outbound-webhook-secret",
      "headers": {}
    }
  }
}
```

## Testing Adapters

### Mock Adapter Factory

The `createMockAdapter()` factory from `@dorkos/test-utils` provides a fully stubbed adapter for testing:

```typescript
import { createMockAdapter } from '@dorkos/test-utils';
import { vi } from 'vitest';

const mockAdapter = createMockAdapter({
  id: 'test-telegram',
  subjectPrefix: 'relay.human.telegram',
  displayName: 'Test Telegram',
});

// All methods are vi.fn() stubs
expect(mockAdapter.start).toHaveBeenCalledWith(relay);
```

### Testing Adapter Lifecycle

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '@dorkos/relay';
import { createMockPublisher } from '@dorkos/test-utils';

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let relay: ReturnType<typeof createMockPublisher>;

  beforeEach(() => {
    relay = createMockPublisher();
    adapter = new TelegramAdapter('test-tg', {
      token: 'test-token',
      mode: 'polling',
    });
  });

  it('starts and connects successfully', async () => {
    await adapter.start(relay);

    const status = adapter.getStatus();
    expect(status.state).toBe('connected');
  });

  it('is idempotent on start', async () => {
    await adapter.start(relay);
    await adapter.start(relay); // Should return immediately

    const status = adapter.getStatus();
    expect(status.state).toBe('connected');
  });

  it('stops gracefully', async () => {
    await adapter.start(relay);
    await adapter.stop();

    const status = adapter.getStatus();
    expect(status.state).toBe('disconnected');
  });
});
```

### Testing Message Delivery

```typescript
it('delivers outbound messages', async () => {
  await adapter.start(relay);

  const envelope = {
    messageId: 'msg-1',
    subject: 'relay.human.telegram.123',
    payload: { content: 'Hello from Relay!' },
  };

  await adapter.deliver('relay.human.telegram.123', envelope);

  const status = adapter.getStatus();
  expect(status.messageCount.outbound).toBe(1);
});
```

## Security Considerations

### HMAC-SHA256 for Webhooks

Always use HMAC-SHA256 (not MD5 or SHA1) for webhook signature verification:

```typescript
const signature = crypto
  .createHmac('sha256', secret)
  .update(message)
  .digest('hex');
```

### Timing-Safe Comparison

**Never use string equality** for signature verification. Always use `crypto.timingSafeEqual`:

```typescript
// WRONG ❌
if (received === expected) return true;

// CORRECT ✅
if (crypto.timingSafeEqual(received, expected)) return true;
```

String equality is vulnerable to timing-based signature oracle attacks where an attacker can recover the signature byte-by-byte by measuring response times.

### Timestamp Windows

Webhook signatures should include a timestamp to prevent replay attacks:

```typescript
const now = Date.now() / 1000;
const ts = Number(headers['x-timestamp']);

// Reject if older than ±300 seconds (5 minutes)
if (Math.abs(now - ts) > 300) {
  return { ok: false, error: 'Timestamp expired' };
}
```

### Nonce Tracking

Track and reject duplicate nonces within the timestamp window:

```typescript
const nonceKey = `${adapterId}:${nonce}`;
if (this.nonceMap.has(nonceKey)) {
  return { ok: false, error: 'Nonce already seen (replay)' };
}
this.nonceMap.set(nonceKey, Date.now() + 24 * 60 * 60 * 1000); // 24h TTL
```

### Secret Rotation

Support dual-secret rotation to allow zero-downtime secret updates:

```typescript
// Try current secret first
if (verifySignature(message, signature, currentSecret)) return true;

// Fall back to previous secret (during rotation window)
if (previousSecret && verifySignature(message, signature, previousSecret)) {
  return true;
}

return false;
```

### Never Log Secrets

Never include secrets in logs or error messages:

```typescript
// WRONG ❌
console.log('Token:', this.config.token);
logger.info(`Connected to Telegram: ${this.config.token}`);

// CORRECT ✅
logger.info('Connected to Telegram');
console.error(`Authentication failed (token length: ${this.config.token.length})`);
```

## Adapter Catalog

Every adapter type exposes an `AdapterManifest` that describes its metadata and configuration schema. The catalog is the authoritative source for the adapter setup UI and for API consumers that need to discover available adapter types.

### AdapterManifest Schema

```typescript
interface AdapterManifest {
  type: string;                        // Unique type key (e.g., 'telegram', 'webhook')
  displayName: string;                 // Human-readable name shown in UI
  description: string;                 // Short description of the adapter
  iconEmoji?: string;                  // Optional emoji for visual identification
  category: 'messaging' | 'automation' | 'internal' | 'custom';
  docsUrl?: string;                    // Link to external documentation
  builtin: boolean;                    // True for adapters shipped with @dorkos/relay
  configFields: ConfigField[];         // Ordered list of configuration fields
  setupSteps?: AdapterSetupStep[];     // Optional multi-step setup wizard definition
  setupInstructions?: string;          // Optional markdown instructions rendered before fields
  multiInstance: boolean;              // Whether multiple instances of this type can coexist
}
```

### ConfigField Schema

Each entry in `configFields` defines one configurable parameter for the adapter:

```typescript
interface ConfigField {
  key: string;           // Config object key (e.g., 'token', 'mode')
  label: string;         // Human-readable label shown in the UI
  type: ConfigFieldType; // Input type (see below)
  required: boolean;     // Whether the field must have a value
  default?: string | number | boolean;  // Default value
  placeholder?: string;  // Input placeholder text
  description?: string;  // Helper text shown below the field
  options?: ConfigFieldOption[];  // Required when type is 'select'
  section?: string;      // Optional grouping label
  showWhen?: {           // Conditional display rule
    field: string;       // Key of another field
    equals: string | boolean | number;  // Value that triggers visibility
  };
}

type ConfigFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea' | 'url';
```

`password` fields are treated as secrets: their values are masked in API responses (replaced with `'***'`) and are preserved when a partial config update is submitted with the field omitted or still masked.

### CatalogEntry

The catalog API returns one entry per known adapter type:

```typescript
interface CatalogEntry {
  manifest: AdapterManifest;     // Static metadata and config field definitions
  instances: CatalogInstance[];  // Zero or more configured instances of this type
}

interface CatalogInstance {
  id: string;
  enabled: boolean;
  status: AdapterStatus;
  config?: Record<string, unknown>;  // Masked config (secrets replaced with '***')
}
```

Built-in manifests are registered automatically on server startup. Plugin manifests are registered when the plugin is first loaded via dynamic import (see [Dynamic Plugin Loading](#dynamic-plugin-loading) below).

### Runtime Config Updates

The `AdapterManager.updateConfig(id, newConfig)` method merges a partial config patch into an existing adapter's stored configuration. Password fields (`type: 'password'`) that arrive with the value `'***'` are silently discarded, preserving the real secret on disk. After merging, the adapter is stopped and restarted in-place.

The `Transport` interface exposes `updateConfig(patch)` to allow client code (including the Obsidian plugin's `DirectTransport`) to persist user config changes without needing direct filesystem access:

```typescript
interface Transport {
  /** Partially update the persisted user config. */
  updateConfig(patch: Record<string, unknown>): Promise<void>;
  // ... other methods
}
```

## Dynamic Plugin Loading

Adapters can be loaded at runtime from npm packages or local files. The plugin loader (`packages/relay/src/adapter-plugin-loader.ts`) handles discovery and validation.

### Factory-Function Convention

A third-party adapter package must export a **default factory function** that accepts the adapter instance ID and a config object, and returns a `RelayAdapter` instance. It may also export a `getManifest()` function for catalog integration:

```typescript
// my-relay-adapter/index.ts (or main entry from package.json)
import type { RelayAdapter } from '@dorkos/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { RELAY_ADAPTER_API_VERSION } from '@dorkos/relay';

export default function createMyAdapter(
  id: string,
  config: Record<string, unknown>,
): RelayAdapter {
  return new MyAdapter(id, config);
}

export function getManifest(): AdapterManifest {
  return {
    type: 'my-adapter',
    displayName: 'My Adapter',
    description: 'Bridges My Platform into Relay',
    category: 'messaging',
    builtin: false,
    apiVersion: RELAY_ADAPTER_API_VERSION,
    multiInstance: true,
    configFields: [
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
      { key: 'region', label: 'Region', type: 'select', required: true,
        options: [{ label: 'US', value: 'us' }, { label: 'EU', value: 'eu' }] },
    ],
  };
}
```

The `id` parameter is the adapter instance ID from the user's `adapters.json` configuration. The plugin loader passes `entry.id` and `entry.config` to the factory function.

If `getManifest()` is absent or fails validation, a minimal fallback manifest is generated automatically and the adapter still loads.

### Plugin Config Entry

Add the adapter to `~/.dork/relay/adapters.json` with `"type": "plugin"` and a `plugin` source:

```json
{
  "adapters": [
    {
      "id": "my-adapter-1",
      "type": "plugin",
      "enabled": true,
      "plugin": { "package": "my-relay-adapter" },
      "config": { "apiKey": "sk-...", "region": "us" }
    },
    {
      "id": "local-dev",
      "type": "plugin",
      "enabled": true,
      "plugin": { "path": "./adapters/my-local-adapter.js" },
      "config": {}
    }
  ]
}
```

`plugin.package` is resolved via Node's module resolution relative to the process CWD. `plugin.path` is resolved relative to the directory containing `adapters.json` when the path is not absolute.

Loading errors are non-fatal: the failing adapter is skipped with a warning and remaining adapters continue to load.

## Adapter-Agent Bindings

The binding subsystem routes inbound adapter messages to specific Claude Code sessions. It consists of two services: `BindingStore` (persistence) and `BindingRouter` (runtime routing).

### BindingStore

Bindings are persisted in `~/.dork/relay/bindings.json` and hot-reloaded via chokidar when the file changes externally. The store is the source of truth for all routing decisions.

Each binding links one adapter instance to one agent working directory:

```typescript
interface AdapterBinding {
  id: string;             // UUID, assigned on creation
  adapterId: string;      // Matches an adapter config id (e.g., 'my-telegram')
  agentId: string;        // Agent identity ID for display purposes
  projectPath: string;    // Working directory passed to runtime.createSession()
  chatId?: string;        // Optional: restrict to a specific chat/user ID
  channelType?: 'dm' | 'group';  // Optional: restrict to a channel type
  sessionStrategy: 'per-chat' | 'per-user' | 'stateless';
  label: string;          // Human-readable label shown in the UI
  createdAt: string;      // ISO 8601 timestamp
  updatedAt: string;      // ISO 8601 timestamp
}
```

### Resolution Scoring (Most-Specific-First)

When an inbound message arrives from an adapter, `BindingStore.resolve()` picks the best matching binding using a scoring algorithm:

| Criteria matched                            | Score |
| ------------------------------------------- | ----- |
| adapterId + chatId + channelType            | 7     |
| adapterId + chatId                          | 5     |
| adapterId + channelType                     | 3     |
| adapterId only (wildcard / catch-all)        | 1     |
| explicit mismatch on chatId or channelType  | 0 (excluded) |

The binding with the highest score is selected. If no binding matches, the message is dropped (no dead-letter — the adapter is simply not bound to any agent).

**Example:** Two bindings for the same Telegram adapter — one catch-all and one for a specific group — will correctly route group messages to the specific binding and DMs to the catch-all:

```json
[
  { "adapterId": "my-telegram", "sessionStrategy": "per-chat", "label": "default" },
  { "adapterId": "my-telegram", "chatId": "-1001234567890", "channelType": "group",
    "sessionStrategy": "per-user", "label": "project-team-group" }
]
```

### Session Strategies

The `sessionStrategy` field on each binding controls how Claude Code sessions are created for incoming messages:

| Strategy    | Behavior                                                                              |
| ----------- | ------------------------------------------------------------------------------------- |
| `per-chat`  | One persistent session per chat ID. All messages in the same chat reuse the same session. This is the default. |
| `per-user`  | One persistent session per user (extracted from envelope metadata, falling back to chatId). Useful when the same user can message from multiple chats. |
| `stateless` | A fresh session is created for every inbound message. No session history is carried across messages. |

Session mappings for `per-chat` and `per-user` strategies are persisted to `~/.dork/relay/sessions.json` and restored on server restart. The map is capped at 10,000 entries with LRU eviction. Orphaned session entries (whose binding no longer exists) are removed on startup.

### BindingRouter

`BindingRouter` subscribes to `relay.human.>` and handles the routing pipeline:

1. Parse the inbound subject to extract `platformType` and `chatId` (e.g., `relay.human.telegram.123456` → `telegram`, `123456`)
2. Resolve platform type to an adapter instance ID via `resolveAdapterInstanceId()`
3. Call `BindingStore.resolve()` to find the best binding
4. Resolve or create a session ID based on the binding's `sessionStrategy`
5. Republish the payload to `relay.agent.{sessionId}` for `ClaudeCodeAdapter` to handle

Agent responses published back to `relay.human.*` subjects are detected by checking `envelope.from.startsWith('agent:')` and are skipped to prevent routing loops.

## AdapterManager Dependency Injection

`AdapterManager` (`apps/server/src/services/relay/adapter-manager.ts`) accepts `AdapterManagerDeps` at construction time:

```typescript
interface AdapterManagerDeps {
  agentManager: ClaudeCodeAgentRuntimeLike; // Required — wraps the active AgentRuntime
  traceStore: TraceStoreLike;               // Required — records delivery spans
  pulseStore?: PulseStoreLike;              // Optional — needed for ClaudeCodeAdapter schedule dispatching
  relayCore?: RelayCoreLike;               // Optional — enables binding subsystem (BindingStore + BindingRouter)
  meshCore?: AdapterMeshCoreLike;          // Optional — resolves agent CWD via getProjectPath(agentId)
  eventRecorder?: AdapterEventRecorder;    // Optional — records adapter lifecycle events for the UI
}
```

When `relayCore` is omitted, `initialize()` skips binding subsystem setup and the binding API endpoints return 503. When `meshCore` is omitted, `AdapterContext` passed to `deliver()` contains no agent info.

## Using BaseRelayAdapter (Optional)

`BaseRelayAdapter` is an optional abstract base class that eliminates ~30 lines of boilerplate per adapter. Direct `RelayAdapter` implementation remains fully supported.

The base class handles:

- **Status initialization** -- `state: 'disconnected'`, message counts, error count
- **Start/stop idempotency** -- skip `start()` if already connected, skip `stop()` if already disconnected
- **Error recording** -- `recordError(err)` updates state, error count, and timestamps
- **Relay ref lifecycle** -- stores the `RelayPublisher` on start, clears it on stop
- **Status snapshots** -- `getStatus()` returns a shallow copy to prevent external mutation

Subclasses implement three methods:

| Method | Purpose |
|---|---|
| `protected _start(relay: RelayPublisher): Promise<void>` | Connect to the external service |
| `protected _stop(): Promise<void>` | Disconnect and drain in-flight messages |
| `deliver(subject, envelope, context?): Promise<DeliveryResult>` | Deliver a message to the external channel |

### Example

```typescript
import { BaseRelayAdapter } from '@dorkos/relay';
import type {
  RelayPublisher,
  DeliveryResult,
  AdapterContext,
} from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

class SlackAdapter extends BaseRelayAdapter {
  private client: SlackClient | null = null;

  constructor(id: string, private readonly token: string) {
    super(id, 'relay.human.slack', 'Slack');
  }

  protected async _start(relay: RelayPublisher): Promise<void> {
    this.client = new SlackClient(this.token);
    await this.client.connect();

    this.client.on('message', async (msg) => {
      this.trackInbound();
      await relay.publish(`relay.human.slack.${msg.userId}`, msg.payload, {
        from: `relay.human.slack.${this.id}`,
      });
    });
  }

  protected async _stop(): Promise<void> {
    await this.client?.disconnect();
    this.client = null;
  }

  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    _context?: AdapterContext,
  ): Promise<DeliveryResult> {
    if (!this.client) return { success: false, error: 'Not connected' };

    const userId = subject.slice('relay.human.slack.'.length);
    await this.client.send(userId, envelope.payload);
    this.trackOutbound();
    return { success: true };
  }
}
```

### Protected helpers

| Helper | Purpose |
|---|---|
| `trackOutbound()` | Increment outbound message count. Call after successful delivery. |
| `trackInbound()` | Increment inbound message count. Call when receiving from external channel. |
| `recordError(err)` | Set state to `'error'`, increment `errorCount`, set `lastError` and `lastErrorAt`. Does not catch/swallow -- the host handles isolation. |
| `this.relay` | Reference to the `RelayPublisher`, set by `start()`, cleared by `stop()`. |

### Design notes

- **Errors re-throw from `start()`.** The base class records the error in status, then re-throws so the host (`AdapterRegistry`) can handle isolation.
- **`deliver()` is not wrapped.** `AdapterRegistry` already wraps delivery with try/catch, timeout, and circuit breaker. Adding another layer would hide errors.
- **`_start()` / `_stop()` naming.** Prefixed with `_` to distinguish from the public lifecycle methods. Follows Node.js convention (`Writable._write()`, Winston `TransportStream._write()`).

## Compliance Test Suite

The compliance suite (`@dorkos/relay/testing`) validates that an adapter correctly implements the `RelayAdapter` contract. Run it against any adapter -- whether it extends `BaseRelayAdapter` or implements the interface directly.

### Usage

```typescript
import { runAdapterComplianceSuite } from '@dorkos/relay/testing';
import { SlackAdapter } from '../slack-adapter.js';

runAdapterComplianceSuite({
  name: 'SlackAdapter',
  createAdapter: () => new SlackAdapter('test-slack', 'xoxb-test-token'),
  deliverSubject: 'relay.human.slack.test',
});
```

### What it validates

| Category | Tests |
|---|---|
| **Shape compliance** | `id` is a non-empty string, `subjectPrefix` is string or string[], `displayName` is a non-empty string, required methods exist |
| **Status lifecycle** | Initial state is `'disconnected'`, `getStatus()` returns a valid `AdapterStatus` shape, `getStatus()` returns a copy (not a reference) |
| **Start/stop idempotency** | `start()` twice does not throw, `stop()` twice does not throw, `stop()` without `start()` does not throw |
| **Delivery** | `deliver()` returns a defined `DeliveryResult` |
| **testConnection** | If present, returns `{ ok: boolean; error?: string }` |

### Mock utilities

The `@dorkos/relay/testing` subpath also exports mock factories for adapter tests:

```typescript
import {
  createMockRelayPublisher,
  createMockRelayEnvelope,
} from '@dorkos/relay/testing';

const relay = createMockRelayPublisher();  // All methods are vi.fn() stubs
const envelope = createMockRelayEnvelope({ subject: 'relay.test.foo' });
```

## API Versioning

Adapters declare which relay API version they target via the `apiVersion` field in their `AdapterManifest`. The plugin loader checks this at load time and emits a warning-level log on mismatch. Version mismatches never block loading.

### Declaring a version

Import `RELAY_ADAPTER_API_VERSION` from `@dorkos/relay` and set it in your manifest:

```typescript
import { RELAY_ADAPTER_API_VERSION } from '@dorkos/relay';

export function getManifest(): AdapterManifest {
  return {
    type: 'my-adapter',
    displayName: 'My Adapter',
    description: 'A custom relay adapter.',
    category: 'custom',
    builtin: false,
    apiVersion: RELAY_ADAPTER_API_VERSION,
    configFields: [/* ... */],
    multiInstance: false,
  };
}
```

### Version check behavior

The plugin loader performs a simple `major.minor` comparison:

- **Major version mismatch** -- warning logged (e.g., adapter targets v1.x but host is v0.x)
- **Adapter minor > host minor** -- warning logged (adapter expects features the host doesn't have)
- **No `apiVersion` declared** -- no check performed, no warning

The comparison uses a manual `major.minor` split (no `semver` dependency).

### Versioning policy

- **Pre-1.0** (`0.x.y`): No stability guarantees. The `RelayAdapter` interface may change between minor versions.
- **Post-1.0**: Follow SemVer. Major bumps for breaking changes to required interface members, minor bumps for new optional members or behavioral changes.

## Adapter Template

A working starter template lives at `templates/relay-adapter/`. It provides a complete project structure with `BaseRelayAdapter`, the factory export, manifest with API versioning, and a pre-wired compliance test suite.

### Quick start

1. **Copy the template:**

   ```bash
   cp -r templates/relay-adapter my-org/dorkos-relay-my-adapter
   cd my-org/dorkos-relay-my-adapter
   ```

2. **Rename and customize:** Update the class name, `subjectPrefix`, manifest `type` / `displayName`, and `package.json` name.

3. **Implement three methods:** `_start()`, `_stop()`, and `deliver()` in your adapter class.

4. **Run the compliance suite:**

   ```bash
   pnpm test
   ```

5. **Configure in DorkOS:** Add an entry to `~/.dork/relay/adapters.json`:

   ```json
   {
     "adapters": [
       {
         "id": "my-adapter-1",
         "type": "plugin",
         "plugin": { "package": "dorkos-relay-my-adapter" },
         "config": { "apiKey": "your-api-key" }
       }
     ]
   }
   ```

### Template structure

```
templates/relay-adapter/
├── package.json              # ESM package with @dorkos/relay peer dep
├── tsconfig.json
├── README.md                 # Detailed setup instructions
└── src/
    ├── index.ts              # Factory default export + getManifest()
    ├── my-adapter.ts         # Working no-op adapter extending BaseRelayAdapter
    └── __tests__/
        └── my-adapter.test.ts  # Pre-wired compliance suite
```

Package naming convention: `dorkos-relay-{channel}` (e.g., `dorkos-relay-slack`, `dorkos-relay-discord`).

## Creating a Custom Adapter

Here's a minimal example implementing a hypothetical Slack adapter:

```typescript
import type { RelayAdapter, RelayPublisher, AdapterStatus, AdapterContext, DeliveryResult } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

interface SlackAdapterConfig {
  token: string;
  signingSecret: string;
}

export class SlackAdapter implements RelayAdapter {
  readonly id: string;
  readonly subjectPrefix = 'relay.human.slack';
  readonly displayName = 'Slack';

  private readonly config: SlackAdapterConfig;
  private relay: RelayPublisher | null = null;
  private client: any = null; // Slack SDK client
  private status: AdapterStatus = {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  constructor(id: string, config: SlackAdapterConfig) {
    this.id = id;
    this.config = config;
  }

  async start(relay: RelayPublisher): Promise<void> {
    if (this.client !== null) return; // Already started

    this.relay = relay;
    this.status.state = 'starting';

    // Initialize Slack client
    const { App } = await import('@slack/bolt');
    this.client = new App({
      token: this.config.token,
      signingSecret: this.config.signingSecret,
    });

    // Register message handler
    this.client.message(async (args: any) => {
      await this.handleInboundMessage(args);
    });

    // Start the client
    await this.client.start();

    this.status = { ...this.status, state: 'connected', startedAt: new Date().toISOString() };
  }

  async stop(): Promise<void> {
    if (this.client === null) return; // Already stopped

    this.status = { ...this.status, state: 'stopping' };

    try {
      await this.client.stop();
    } catch (err) {
      this.recordError(err);
    } finally {
      this.client = null;
      this.relay = null;
      this.status = { ...this.status, state: 'disconnected' };
    }
  }

  async deliver(subject: string, envelope: RelayEnvelope, _context?: AdapterContext): Promise<DeliveryResult> {
    if (!this.client) return { success: false, error: 'SlackAdapter: not started' };

    const start = Date.now();
    const userId = this.extractUserIdFromSubject(subject);
    if (!userId) return { success: false, error: `Cannot extract user ID from subject: ${subject}` };

    const content = this.extractContent(envelope.payload);

    try {
      await this.client.client.chat.postMessage({
        channel: userId,
        text: content,
      });
      this.status.messageCount.outbound++;
      return { success: true, durationMs: Date.now() - start };
    } catch (err) {
      this.recordError(err);
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message, durationMs: Date.now() - start };
    }
  }

  getStatus(): AdapterStatus {
    return { ...this.status };
  }

  private async handleInboundMessage(args: any): Promise<void> {
    if (!this.relay || !args.message.text) return;

    const subject = `relay.human.slack.${args.message.user}`;
    const payload = {
      content: args.message.text,
      senderName: args.message.user,
      platform: 'slack',
    };

    try {
      await this.relay.publish(subject, payload, {
        from: 'relay.human.slack.bot',
      });
      this.status.messageCount.inbound++;
    } catch (err) {
      this.recordError(err);
    }
  }

  private extractUserIdFromSubject(subject: string): string | null {
    if (!subject.startsWith(this.subjectPrefix)) return null;
    return subject.slice(this.subjectPrefix.length + 1);
  }

  private extractContent(payload: unknown): string {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object' && 'content' in payload) {
      const obj = payload as any;
      if (typeof obj.content === 'string') return obj.content;
    }
    return JSON.stringify(payload);
  }

  private recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.status = {
      ...this.status,
      state: 'error',
      errorCount: this.status.errorCount + 1,
      lastError: message,
      lastErrorAt: new Date().toISOString(),
    };
  }
}
```

**Key patterns:**

1. **Constructor**: Store config, initialize ID and subject prefix
2. **start()**: Connect to external service, set status to 'connected', return early if already started
3. **stop()**: Gracefully shut down, set status to 'disconnected', catch errors locally
4. **deliver()**: Extract recipient from subject, send message, return DeliveryResult
5. **getStatus()**: Return a shallow copy of status
6. **Error handling**: Always use `recordError()` to update status, never throw during stop

## Adapter Documentation

Each built-in adapter can ship a `docs/setup.md` file containing a full setup guide rendered in the client's side-panel Sheet. Plugin adapters can provide equivalent content inline via their `getManifest()` return value.

### File Convention

Place a `setup.md` file under `src/adapters/<type>/docs/`:

```
packages/relay/src/adapters/
├── telegram/
│   ├── docs/
│   │   └── setup.md        # Full markdown setup guide
│   └── telegram-adapter.ts
├── slack/
│   ├── docs/
│   │   └── setup.md
│   └── slack-adapter.ts
└── webhook/
    ├── docs/
    │   └── setup.md
    └── webhook-adapter.ts
```

The guide is standard Markdown. It typically covers prerequisites, step-by-step configuration instructions, and troubleshooting tips.

### Build Step

The `packages/relay` build script copies `.md` files from source adapter docs directories into `dist/`:

```json
{
  "build": "tsc && for d in src/adapters/*/docs; do [ -d \"$d\" ] && mkdir -p \"${d/src/dist}\" && cp \"$d\"/*.md \"${d/src/dist}/\"; done"
}
```

After building, the compiled package contains `dist/adapters/<type>/docs/setup.md` alongside the compiled adapter code.

### Server-Side Loading

On startup, `AdapterManager.initialize()` calls `enrichManifestsWithDocs()` after populating built-in manifests. This method:

1. Iterates over all registered manifests
2. Skips any manifest that already has a `setupGuide` value (e.g., plugin adapters with inline guides)
3. Resolves the adapter's `docs/setup.md` path using `createRequire` to locate the `@dorkos/relay` package dist directory
4. Reads the file and sets its contents as the `setupGuide` field on the manifest
5. Silently skips adapters without a docs file (no error)

### Plugin Adapters

Plugin adapters can provide a `setupGuide` string directly in their `getManifest()` return value:

```typescript
export function getManifest(): AdapterManifest {
  return {
    type: 'my-adapter',
    displayName: 'My Adapter',
    // ... other fields
    setupGuide: '# Setup\n\nFollow these steps to configure My Adapter...',
  };
}
```

When `setupGuide` is already present, `enrichManifestsWithDocs()` does not attempt to load a file.

### `helpMarkdown` on Config Fields

Individual config fields can include a `helpMarkdown` property containing Markdown content displayed in a collapsible disclosure below the field input. Use this for field-specific instructions that would be too verbose for the `description` property:

```typescript
{
  key: 'token',
  label: 'Bot Token',
  type: 'password',
  required: true,
  description: 'Token from @BotFather on Telegram.',
  helpMarkdown: '1. Open Telegram and search for **@BotFather**\n2. Send `/newbot`\n3. Copy the token provided',
}
```

## Related

- `packages/relay/src/types.ts` — RelayAdapter interface and config types
- `packages/relay/src/base-adapter.ts` — Optional BaseRelayAdapter abstract class
- `packages/relay/src/version.ts` — RELAY_ADAPTER_API_VERSION constant
- `packages/relay/src/adapter-plugin-loader.ts` — Dynamic plugin loading from npm and local paths
- `packages/relay/src/testing/` — Compliance test suite and mock utilities
- `packages/relay/src/adapter-registry.ts` — AdapterRegistry lifecycle management
- `apps/server/src/services/relay/adapter-manager.ts` — Server-side hot-reload, catalog, and updateConfig
- `apps/server/src/services/relay/adapter-factory.ts` — Adapter instantiation per config type
- `apps/server/src/services/relay/binding-store.ts` — Binding persistence and resolution scoring
- `apps/server/src/services/relay/binding-router.ts` — Runtime routing from relay.human.> to relay.agent.*
- `packages/shared/src/relay-schemas.ts` — AdapterManifest, ConfigField, AdapterBinding, and all Relay Zod schemas
- `packages/shared/src/transport.ts` — Transport interface including updateConfig()
- `templates/relay-adapter/` — Starter template for new adapters
- `decisions/0030-dynamic-import-for-adapter-plugins.md` — ADR for plugin loading and factory export pattern
