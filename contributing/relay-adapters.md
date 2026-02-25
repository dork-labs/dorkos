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
  readonly subjectPrefix: string;                               // Subject prefix (e.g. 'relay.human.telegram')
  readonly displayName: string;                                 // Human-readable name

  start(relay: RelayPublisher): Promise<void>;                  // Connect and register
  stop(): Promise<void>;                                        // Disconnect gracefully
  deliver(subject: string, envelope: RelayEnvelope): Promise<void>;  // Send outbound message
  getStatus(): AdapterStatus;                                   // Current runtime status
}
```

### Properties

| Property         | Type    | Purpose                                                   |
| ---------------- | ------- | --------------------------------------------------------- |
| `id`             | string  | Unique adapter ID (e.g., `'telegram'`, `'webhook-github'`) used for storage and lifecycle management. Multiple adapter instances can exist; the ID disambiguates them. |
| `subjectPrefix`  | string  | The Relay subject prefix this adapter handles (e.g., `'relay.human.telegram'`). Used by AdapterRegistry to route outbound messages to the correct adapter. |
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

#### `deliver(subject: string, envelope: RelayEnvelope): Promise<void>`

Called by RelayCore when a published message matches this adapter's `subjectPrefix`. Extracts the message content from the envelope and sends it via the external channel.

**Requirements:**

- Should extract the chat/channel identifier from the subject
- Should handle outbound message formatting and size limits
- Should throw on delivery failure; the error is recorded in status

**Typical implementation:**

```typescript
async deliver(subject: string, envelope: RelayEnvelope): Promise<void> {
  const chatId = extractChatIdFromSubject(subject);
  const content = extractContent(envelope.payload);

  try {
    await this.externalService.send(chatId, content);
    this.status.messageCount.outbound++;
  } catch (err) {
    this.recordError(err);
    throw err;
  }
}
```

#### `getStatus(): AdapterStatus`

Returns a snapshot of the adapter's current runtime state. Used by the client to display adapter health in the UI.

**Result type:**

```typescript
interface AdapterStatus {
  state: 'connected' | 'disconnected' | 'error' | 'starting' | 'stopping';
  messageCount: { inbound: number; outbound: number };
  errorCount: number;
  lastError?: string;
  lastErrorAt?: string;
  startedAt?: string;
}
```

**Implementation:**

```typescript
getStatus(): AdapterStatus {
  return { ...this.status }; // Return a shallow copy to prevent mutation
}
```

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
  type: 'telegram' | 'webhook';         // Adapter type (extensible)
  enabled: boolean;                     // Whether this adapter should be running
  config: TelegramAdapterConfig | WebhookAdapterConfig;  // Type-specific config
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

## Creating a Custom Adapter

Here's a minimal example implementing a hypothetical Slack adapter:

```typescript
import type { RelayAdapter, RelayPublisher, AdapterStatus } from '@dorkos/relay';
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

  async deliver(subject: string, envelope: RelayEnvelope): Promise<void> {
    if (!this.client) throw new Error('SlackAdapter: not started');

    const userId = this.extractUserIdFromSubject(subject);
    if (!userId) throw new Error(`Cannot extract user ID from subject: ${subject}`);

    const content = this.extractContent(envelope.payload);

    try {
      await this.client.client.chat.postMessage({
        channel: userId,
        text: content,
      });
      this.status.messageCount.outbound++;
    } catch (err) {
      this.recordError(err);
      throw err;
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
4. **deliver()**: Extract recipient from subject, send message, update status
5. **getStatus()**: Return a shallow copy of status
6. **Error handling**: Always use `recordError()` to update status, never throw during stop

## Related

- `packages/relay/src/adapter-registry.ts` — AdapterRegistry lifecycle management
- `packages/relay/src/types.ts` — RelayAdapter interface and config types
- `apps/server/src/services/relay/adapter-manager.ts` — Server-side hot-reload and persistence
- `packages/shared/relay-schemas.ts` — StandardPayload and RelayEnvelope schemas
