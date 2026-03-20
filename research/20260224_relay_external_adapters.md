---
title: 'Relay External Adapters — Telegram, Webhook, Plugin Architecture'
date: 2026-02-24
type: internal-architecture
status: archived
tags: [relay, adapters, telegram, webhook, plugin, grammy]
feature_slug: relay-external-adapters
---

# Research: Relay External Adapters — Telegram, Webhook, Plugin Architecture

**Date:** 2026-02-24
**Feature:** relay-external-adapters
**Depth:** Deep Research (11 web searches + 1 web fetch)

---

## Research Summary

grammY is the definitive choice for the Telegram adapter: written TypeScript-first from scratch, actively tracks the latest Bot API, ships `@grammyjs/auto-retry` for automatic network reconnect and flood-limit handling, and lets you switch between long polling and webhook mode with a few lines of code. Long polling is the correct default for DorkOS — no public URL or SSL cert required, and grammY's `bot.stop()` drains in-flight updates gracefully. The adapter plugin system should use a registry pattern (`Map<id, RelayAdapter>`) with `Promise.allSettled()` for per-adapter error isolation, chokidar-driven hot-reload that starts the new adapter before stopping the old one, and exponential-backoff + nonce + HMAC-SHA256 for comprehensive webhook security.

---

## Key Findings

1. **grammY is the only viable TypeScript-first Telegram library**: Built with TS from day one, ships inline Bot API hints, comprehensive docs, modern plugin ecosystem. Telegraf's TS types were described as "so complex they were too hard to understand." `node-telegram-bot-api` has an architectural design that fails beyond simple scripts.

2. **Long polling is the correct default for Relay adapters**: No public URL, no SSL cert, no ngrok dependency for Telegram. grammY auto-handles reconnect via `@grammyjs/auto-retry`. Switching to webhooks later requires only a few lines of code.

3. **Four-layer webhook security stack**: HMAC-SHA256 signature verification (raw body, `crypto.timingSafeEqual`) + 5-minute timestamp window + nonce store (in-memory `Map` with 24h TTL) + idempotency key tracking. Idempotency is the safety net for the delivery window.

4. **Registry + `Promise.allSettled()` for adapter isolation**: A crash in one adapter must not affect others. `start()` failures during registration are isolated — they log an error but do not prevent other adapters from starting. Hot-reload inserts the new adapter into the registry before stopping the old instance.

5. **Outbound webhook delivery needs at-least-once semantics with exponential backoff**: Stable idempotency key per event (same UUID across all retry attempts), exponential backoff with ±20% jitter, dead-letter queue after max attempts.

6. **React Virtuoso with `followOutput` for the activity feed**: Purpose-built for variable-height auto-scrolling feeds. Handles thousands of items without DOM bloat. Smart auto-scroll: only follows to bottom if user is already at the bottom.

---

## Detailed Analysis

### 1. Telegram Bot Library Comparison

| Criterion              | grammY                                                                        | Telegraf                                       | node-telegram-bot-api  |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------- |
| **TypeScript Support** | Excellent — TS-first, clean types, inline Bot API hints                       | Poor in v4 — types "too complex to understand" | None (JS only)         |
| **Active Maintenance** | Active, tracks latest Bot API                                                 | Lags Bot API by several versions               | Effectively abandoned  |
| **Documentation**      | Comprehensive guides + auto-generated reference                               | Auto-generated only, guides sparse             | Minimal                |
| **Long Polling**       | `bot.start()` — built-in, zero config                                         | `bot.launch()`                                 | `bot.startPolling()`   |
| **Webhook Mode**       | First-class; adapters for Express, Koa, and more                              | Supported                                      | Supported but brittle  |
| **Auto-Reconnect**     | `@grammyjs/auto-retry` — handles 429, 500, `HttpError`                        | Manual                                         | Manual                 |
| **Error Handling**     | Typed `GrammyError` / `HttpError`; `bot.catch()`; middleware error boundaries | Basic                                          | Manual                 |
| **Group Chat**         | Full support; privacy mode documented                                         | Full support                                   | Supported              |
| **Bundle Size**        | Lightweight; ships ESM web bundle for edge runtimes                           | Heavier                                        | Small but unmaintained |
| **Serverless/Edge**    | Excellent; designed for Cloudflare Workers                                    | Possible but heavier                           | No                     |
| **Mode Switching**     | Trivial — same middleware, only `bot.start()` vs webhook handler changes      | Similar                                        | Hard                   |
| **Weekly Downloads**   | ~1.2M (npm)                                                                   | ~160K                                          | ~156K                  |

**Verdict:** grammY is unambiguously the correct choice for a TypeScript-first codebase in 2026.

---

### 2. Long Polling vs. Webhooks for the Relay Telegram Adapter

#### Long Polling (recommended default)

grammY's `bot.start()` enters a `getUpdates` loop. Telegram holds the connection open until an update arrives, then responds immediately. No public URL required.

Key behaviors:

- Works on `localhost` with no additional infrastructure
- `@grammyjs/auto-retry` handles network failures, 429 flood limits, and 500 server errors automatically
- `bot.stop()` performs a final `getUpdates` offset sync before shutdown — no updates lost on graceful restart
- Simple polling handles ~5K messages/hour; `@grammyjs/runner` scales to arbitrarily higher loads
- Resource cost: one persistent outbound HTTPS connection per bot instance

Graceful shutdown pattern:

```typescript
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start();
```

#### Webhooks (opt-in production mode)

Telegram sends HTTPS POST to a registered URL on every update. Requires:

- A public HTTPS URL (only ports 443, 80, 88, 8443 are allowed by Telegram)
- An SSL cert (Telegram enforces TLS)
- In development: ngrok or VS Code port forwarding

DorkOS already has ngrok tunnel support. Webhook mode could be an opt-in config flag (`"mode": "polling" | "webhook"`) that activates when the tunnel is active. The grammY adapter pattern means the same middleware code runs in both modes.

**Free-tier ngrok caveat**: Each restart generates a new public URL, requiring the Telegram webhook URL to be re-registered. DorkOS's ngrok integration already handles tunnel URL management — this is manageable but adds a lifecycle dependency.

**Recommendation**: Long polling as default. Webhook mode as an optional production upgrade. The switch is a few lines of code and does not require any middleware changes.

---

### 3. Webhook Security Patterns

#### Inbound HMAC-SHA256 Verification

The Stripe pattern — industry standard used by GitHub, Stripe, Shopify, Okta:

```typescript
import { createHmac, timingSafeEqual } from 'crypto';

function verifyWebhookSignature(
  rawBody: Buffer, // MUST be raw bytes — captured before JSON.parse
  signatureHeader: string, // format: "t=<timestamp>,v1=<hex-sig>"
  secret: string,
  toleranceSecs = 300
): boolean {
  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=')));
  const timestamp = parseInt(parts['t'] ?? '0', 10);
  const received = parts['v1'] ?? '';

  // Layer 1: Timestamp window (replay prevention — 5-minute tolerance)
  const age = Math.abs(Date.now() / 1000 - timestamp);
  if (age > toleranceSecs) return false;

  // Layer 2: HMAC — sign the timestamp + raw body together
  const payload = `${timestamp}.${rawBody.toString()}`;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');

  // Layer 3: Constant-time comparison — NEVER use === on signatures
  try {
    return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false; // Buffer length mismatch = invalid signature
  }
}
```

**Critical implementation note:** The raw body must be captured before `express.json()` parses it. Use Express's `verify` callback:

```typescript
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);
```

Or use `express.raw({ type: 'application/json' })` for webhook-specific routes.

#### Replay Attack Prevention

Three-layer defense:

1. **Timestamp window (5 minutes):** The signed payload includes a timestamp. Reject requests where `|now - t| > 300 seconds`. Invalidates captured replay packets after 5 minutes.

2. **Nonce tracking:** Cover the remaining 5-minute window with a nonce store:

```typescript
const processedNonces = new Map<string, number>(); // nonce -> expiresAt

// Cleanup on 5-minute interval to prevent unbounded growth
setInterval(
  () => {
    const now = Date.now();
    for (const [nonce, exp] of processedNonces) {
      if (exp < now) processedNonces.delete(nonce);
    }
  },
  5 * 60 * 1000
);

function checkAndRecordNonce(nonce: string): boolean {
  if (processedNonces.has(nonce)) return false; // replay detected
  processedNonces.set(nonce, Date.now() + 24 * 60 * 60 * 1000); // 24h TTL
  return true;
}
```

Scope nonce keys by adapter ID (`${adapterId}:${nonce}`) to prevent cross-adapter collisions.

3. **Idempotency key tracking:** Stable event UUID (same per event, not per attempt). Track `(adapterId, eventId)` pairs in a Set. Even if timestamp + nonce fail, idempotency prevents duplicate processing.

**For DorkOS's single-process architecture**, an in-memory `Map` is correct — no Redis required. If DorkOS ever scales to multiple processes, switch to Redis `SETEX`.

#### Secret Rotation

Support dual secrets during rotation: verify against both old and new secret for a 24-hour transition window. Store as `"secrets": ["new-secret", "old-secret"]` in `adapters.json`. After 24 hours, drop the old secret.

Never log secrets. File permissions on `~/.dork/relay/adapters.json` should be 0600.

#### Outbound Webhook Signing

Sign outbound POST requests so receivers can verify origin:

```typescript
const sig = createHmac('sha256', deliverySecret)
  .update(`${timestamp}.${JSON.stringify(envelope)}`)
  .digest('hex');

headers['X-DorkOS-Signature'] = `t=${timestamp},v1=${sig}`;
headers['X-DorkOS-Delivery-Id'] = envelope.id; // stable per event, not per attempt
```

---

### 4. Outbound Webhook Delivery

At-least-once delivery with exponential backoff and jitter:

```typescript
interface OutboundDelivery {
  id: string; // stable across all retry attempts (same event = same id)
  url: string;
  payload: RelayEnvelope;
  attempt: number;
  status: 'pending' | 'success' | 'failed' | 'retrying' | 'dead';
  nextAttemptAt?: Date;
}
```

**Retry schedule with jitter (±20%):**

| Attempt | Base delay        | With jitter |
| ------- | ----------------- | ----------- |
| 1       | immediate         | immediate   |
| 2       | 1 minute          | 48s–72s     |
| 3       | 5 minutes         | 4m–6m       |
| 4       | 30 minutes        | 24m–36m     |
| 5       | 2 hours           | 1.6h–2.4h   |
| 6       | 24 hours          | 19.2h–28.8h |
| 7+      | Dead letter queue | —           |

Jitter formula: `delay * (0.8 + 0.4 * Math.random())`

Jitter prevents the thundering herd problem where all failed webhooks retry simultaneously after a receiving server recovers.

**Dead letter queue:** After 6 failures, emit a `relay.adapter.webhook.deadletter` subject event with the original envelope. This aligns with the existing `DeadLetterQueueConfigSchema` in `relay-schemas.ts`.

**For DorkOS's use case** (low-to-moderate volume), a lightweight in-memory retry queue using `setTimeout` chains is sufficient. BullMQ is the production upgrade path if needed.

---

### 5. Adapter Plugin Architecture

#### Registry Pattern (correct for this use case)

A registry (`Map<id, RelayAdapter>`) is correct over a Strategy pattern because:

- Multiple adapters coexist simultaneously (Telegram + webhook + future adapters)
- Adapters are individually addressable by ID for hot-reload targeting
- Strategy implies a single active implementation — not the case here

```typescript
class AdapterRegistry {
  private readonly adapters = new Map<string, RelayAdapter>();

  async register(adapter: RelayAdapter, relay: RelayCore): Promise<void> {
    try {
      await adapter.start(relay);
      this.adapters.set(adapter.id, adapter);
    } catch (err) {
      // Isolation: one adapter failing to start NEVER blocks others
      console.error(`[relay-adapter] Failed to start ${adapter.id}:`, err);
      this.emitAdapterError(adapter.id, err);
      // Do NOT add to registry — broken adapter is not registered
    }
  }

  async unregister(adapterId: string): Promise<void> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return;
    this.adapters.delete(adapterId); // remove FIRST — stop accepting new delivers
    try {
      await adapter.stop(); // then drain + close
    } catch (err) {
      console.error(`[relay-adapter] Error stopping ${adapterId}:`, err);
    }
  }

  async broadcast(subject: string, envelope: RelayEnvelope): Promise<void> {
    // Promise.allSettled — one failing adapter NEVER blocks others
    const results = await Promise.allSettled(
      [...this.adapters.values()]
        .filter((a) => subject.startsWith(a.subjectPrefix))
        .map((a) => a.deliver(subject, envelope))
    );

    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        const adapter = [...this.adapters.values()][i];
        console.error(`[relay-adapter] ${adapter?.id} deliver error:`, result.reason);
        this.emitAdapterError(adapter?.id ?? 'unknown', result.reason);
      }
    }
  }

  async stopAll(): Promise<void> {
    // Shutdown all adapters in parallel regardless of individual failures
    await Promise.allSettled([...this.adapters.keys()].map((id) => this.unregister(id)));
  }
}
```

#### Hot-Reload Without Message Loss

The chokidar watcher fires when `~/.dork/relay/adapters.json` changes.

```typescript
const watcher = chokidar.watch(configPath, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 150 }, // wait for write to fully settle
});

watcher.on('change', async () => {
  const newConfig = await loadAdaptersConfig(configPath);

  for (const adapterConfig of newConfig.adapters) {
    const oldAdapter = registry.get(adapterConfig.id);

    // Start new adapter FIRST
    const newAdapter = createAdapter(adapterConfig);
    try {
      await newAdapter.start(relay);
    } catch (err) {
      console.error(
        `[hot-reload] New adapter ${adapterConfig.id} failed to start — keeping old:`,
        err
      );
      continue; // Abort reload for this adapter; old instance stays active
    }

    // Register new instance — now handling incoming delivers
    registry.set(adapterConfig.id, newAdapter);

    // Stop old instance AFTER new is live
    if (oldAdapter) {
      await oldAdapter
        .stop()
        .catch((err) => console.error(`[hot-reload] Error stopping old ${adapterConfig.id}:`, err));
    }

    emit('adapter.reloaded', { id: adapterConfig.id });
  }
});
```

**Key principle:** The new adapter is registered (step: `registry.set`) BEFORE the old adapter is stopped. During the brief overlap, both exist but only the new one handles new delivers. The old adapter drains in-flight work, then closes. RelayCore's mailbox buffers any messages arriving during `newAdapter.start()` — no message loss.

If `newAdapter.start()` throws, the old adapter continues uninterrupted. This is safe rollback behavior.

---

### 6. Testing Strategies

#### Telegram Adapter (MSW for network-level mocking)

MSW 2.x for Node.js intercepts at the `http`/`https` module layer — no changes to production code needed:

```typescript
// __tests__/telegram-adapter.test.ts
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const BOT_TOKEN = 'test-token';
const TG_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

const server = setupServer(
  // Simulate idle long polling (empty updates)
  http.post(`${TG_BASE}/getUpdates`, () => HttpResponse.json({ ok: true, result: [] })),
  // Simulate an incoming message
  http.post(
    `${TG_BASE}/getUpdates`,
    () =>
      HttpResponse.json({
        ok: true,
        result: [
          {
            update_id: 1,
            message: { message_id: 1, chat: { id: 123, type: 'private' }, text: 'hello', date: 0 },
          },
        ],
      }),
    { once: true } // return update only once, then idle
  ),
  // Mock sendMessage
  http.post(`${TG_BASE}/sendMessage`, () =>
    HttpResponse.json({ ok: true, result: { message_id: 2 } })
  )
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

For lifecycle tests (start/stop), mock the entire `grammy` module:

```typescript
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn().mockReturnThis(),
    catch: vi.fn().mockReturnThis(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
  })),
}));
```

#### Webhook Adapter (signature helper + supertest)

```typescript
function signPayload(body: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

it('accepts valid signed webhook', async () => {
  const body = JSON.stringify({ event: 'message', id: 'evt-1' });
  const signature = signPayload(body, TEST_SECRET);

  await request(app)
    .post('/relay/webhook/inbound')
    .set('X-Webhook-Signature', signature)
    .set('Content-Type', 'application/json')
    .send(body)
    .expect(200);
});

it('rejects expired timestamp', async () => {
  const ts = Math.floor(Date.now() / 1000) - 400; // 400s ago > 300s tolerance
  const sig = createHmac('sha256', TEST_SECRET).update(`${ts}.${body}`).digest('hex');

  await request(app)
    .post('/relay/webhook/inbound')
    .set('X-Webhook-Signature', `t=${ts},v1=${sig}`)
    .send(body)
    .expect(401);
});

it('rejects replayed nonce', async () => {
  const signature = signPayload(body, TEST_SECRET);
  await request(app)
    .post('/relay/webhook/inbound')
    .set('X-Webhook-Signature', signature)
    .send(body)
    .expect(200);
  await request(app)
    .post('/relay/webhook/inbound')
    .set('X-Webhook-Signature', signature)
    .send(body)
    .expect(409);
});
```

#### Adapter Lifecycle Tests

```typescript
describe('AdapterRegistry', () => {
  it('isolates start failure — other adapters still start', async () => {
    const failing = {
      id: 'bad',
      subjectPrefix: 'bad.',
      start: vi.fn().mockRejectedValue(new Error('connection refused')),
      stop: vi.fn(),
      deliver: vi.fn(),
    };
    const good = {
      id: 'good',
      subjectPrefix: 'good.',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      deliver: vi.fn(),
    };

    await registry.register(failing, relay);
    await registry.register(good, relay);

    expect(registry.get('bad')).toBeUndefined(); // not registered
    expect(registry.get('good')).toBeDefined(); // registered successfully
  });

  it('broadcast isolates deliver failures', async () => {
    const crashingDeliver = {
      ...mockAdapter,
      id: 'crash',
      deliver: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const workingDeliver = {
      ...mockAdapter,
      id: 'work',
      deliver: vi.fn().mockResolvedValue(undefined),
    };

    await registry.register(crashingDeliver, relay);
    await registry.register(workingDeliver, relay);

    // Must not throw even though one adapter fails
    await expect(registry.broadcast('test.subject', mockEnvelope)).resolves.not.toThrow();
    expect(workingDeliver.deliver).toHaveBeenCalled();
  });

  it('hot-reload starts new before stopping old', async () => {
    const callOrder: string[] = [];
    const oldAdapter = {
      ...mockAdapter,
      id: 'tg',
      stop: vi.fn().mockImplementation(async () => {
        callOrder.push('old.stop');
      }),
    };
    const newAdapter = {
      ...mockAdapter,
      id: 'tg',
      start: vi.fn().mockImplementation(async () => {
        callOrder.push('new.start');
      }),
    };

    await registry.register(oldAdapter, relay);
    await registry.hotReload(newAdapter, relay);

    expect(callOrder).toEqual(['new.start', 'old.stop']);
  });
});
```

---

### 7. Activity Feed Design

#### Component Choice

**React Virtuoso** with `followOutput` is the correct component for the Relay activity feed:

```tsx
<Virtuoso
  data={events}
  followOutput="smooth" // auto-scroll when user is at bottom; pause if scrolled up
  itemContent={(_, event) => <ActivityRow key={event.id} event={event} />}
  style={{ height: '100%' }}
  components={{ Footer: ScrollToLatestButton }} // appears when user has scrolled up
/>
```

`followOutput="smooth"` implements the correct UX: auto-scroll when at bottom, preserve position when user has scrolled up. The "scroll to latest" button component appears automatically when scrolled away from bottom.

#### Event Data Model

```typescript
type ActivityEventLevel = 'info' | 'success' | 'warning' | 'error';

interface ActivityEvent {
  id: string;
  timestamp: Date;
  level: ActivityEventLevel;
  adapterId?: string; // 'telegram' | 'webhook' | 'relay'
  direction?: 'inbound' | 'outbound';
  subject?: string;
  message: string;
  detail?: string; // expandable; stack traces, payload preview
}

// Event type to severity mapping
const EVENT_SEVERITY: Record<string, ActivityEventLevel> = {
  message_in: 'info',
  message_out: 'info',
  adapter_start: 'success',
  adapter_stop: 'warning',
  adapter_error: 'error',
  relay_error: 'error',
  config_reload: 'info',
  dead_letter: 'error',
};
```

#### Timestamp Display Conventions

Hybrid relative + absolute display — optimized for live monitoring:

```typescript
function formatEventTimestamp(ts: Date): string {
  const delta = (Date.now() - ts.getTime()) / 1000;
  if (delta < 10) return 'just now';
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  // Older: show wall clock time (no date — feed is a session view)
  return ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
// Always show full ISO 8601 in a tooltip on hover
```

#### Buffer Management and Performance

- Cap the in-memory event buffer at **1000 items** — truncate oldest when exceeded
- Debounce React state updates when events arrive in bursts: maintain a local queue, flush to state every 50ms via `setInterval`
- Do not render `detail` content until row is expanded (conditional render inside `ActivityRow`)
- `React.memo` on `ActivityRow` — event objects are immutable once created
- Three filter axes using `useMemo` + `useTransition` (non-blocking): adapter / direction / severity

For DorkOS's expected traffic profile, React Virtuoso with a 1000-item cap is sufficient without any additional windowing complexity. At 5000+ items, the virtual DOM overhead is handled by Virtuoso automatically.

---

## Recommendation Summary

### Telegram Library

**grammY** — `npm install grammy @grammyjs/auto-retry`

TypeScript-first, active maintenance tracking latest Bot API, superior error types (`GrammyError` / `HttpError`), `@grammyjs/auto-retry` for transparent reconnect and flood-limit handling, middleware error boundaries, graceful `bot.stop()`.

### Inbound Update Mode

**Long polling as default, webhook as opt-in config flag.** Long polling works on `localhost` with no infrastructure changes. Add `"mode": "polling" | "webhook"` to the adapter config; webhook mode activates when the DorkOS ngrok tunnel is live.

### Webhook Security

**HMAC-SHA256 + 5-minute timestamp window + nonce `Map` with 24h TTL + idempotency key tracking.** Always use `crypto.timingSafeEqual`. Verify on the raw request body buffer — capture via Express `verify` callback before `bodyParser.json()` runs. Scope nonce keys by adapter ID.

### Plugin Registration

**Registry pattern (`Map<id, RelayAdapter>`) with `Promise.allSettled()` for broadcast and shutdown.** Hot-reload sequence: `newAdapter.start()` → `registry.set(newAdapter)` → `oldAdapter.stop()`. Never stop old before new is confirmed started. Each adapter's lifecycle wrapped in `try/catch` to prevent cascade failures.

### Testing

**MSW 2.x (`msw/node`) + `vi.mock('grammy')`** for Telegram adapter. `signPayload()` helper + `supertest` for webhook receiver. `Promise.allSettled` result inspection for isolation guarantees.

### Activity Feed

**React Virtuoso** with `followOutput="smooth"`, 1000-item ring buffer, relative timestamps under 1h / wall-clock over 1h, filter by adapter / direction / severity.

---

## Security Considerations

- Never use `===` for signature comparison — use `crypto.timingSafeEqual` always
- Capture raw body bytes before any JSON parsing — signature verification fails on re-serialized JSON
- 5-minute timestamp window balances replay protection vs. acceptable clock skew
- Scope nonce keys by adapter ID to prevent cross-adapter collisions
- Store Telegram bot tokens in `~/.dork/config.json` under existing `UserConfig` pattern, never hardcoded
- Set `~/.dork/relay/adapters.json` file permissions to 0600
- Support dual-secret rotation window (24h overlap) to enable zero-downtime secret rotation

---

## Performance Considerations

- grammY simple polling handles ~5K msgs/hour; add `@grammyjs/runner` beyond that threshold
- Telegram per-chat rate limit: 1 msg/s — enforce with per-chat `lastSentAt` Map + `@grammyjs/auto-retry` on 429
- Nonce `Map` pruning: run on 5-minute `setInterval` to prevent unbounded memory growth
- `awaitWriteFinish: { stabilityThreshold: 150 }` in chokidar prevents partial-write restarts on config save
- Activity feed: 50ms debounce flush + 1000-item cap keeps React renders infrequent and DOM bounded

---

## Caveats

- **Telegram privacy mode for groups**: By default the bot does not receive all group messages — only commands and replies. This must be documented in adapter config and surfaced in the DorkOS UI. To receive all messages, privacy mode must be disabled via BotFather.
- **grammY `bot.stop()` is async**: The adapter's `stop()` method MUST `await bot.stop()` before resolving to ensure graceful shutdown ordering (adapter fully stopped before SIGTERM handling completes).
- **ngrok port whitelist**: Telegram webhooks only support ports 443, 80, 88, 8443. DorkOS defaults to port 4242. Webhook mode will require a port mapping or nginx proxy layer.
- **nonce store durability**: In-memory `Map` loses nonce history on server restart, creating a brief replay window. Acceptable for DorkOS single-process architecture; use Redis `SETEX` if multi-process.
- **`@grammyjs/parse-mode` dependency**: Adding this for agent response formatting adds one dependency. It can be avoided by implementing entity-based rendering manually with the `fmt` builder.
- **Outbound delivery is best-effort without a job queue**: The `setTimeout`-chain retry implementation works for DorkOS's volume but is not durable across server restarts. Events queued for retry are lost on restart. A later iteration could persist the delivery queue to `~/.dork/pulse.db` (already available).

---

## Research Gaps and Limitations

- grammY's `@grammyjs/runner` concurrency model for high-throughput polling was not investigated in depth — only the simple `bot.start()` threshold (~5K msgs/hr) was surfaced.
- The `telegram-test-api` npm package's compatibility with grammY was not hands-on verified.
- Telegram webhook behavior during `bot.stop()` / `bot.start()` transitions (whether Telegram server-side buffers are preserved) was asserted based on documentation, not empirical testing.
- Webhook outbound retry behavior against real endpoints that return 429 (Too Many Requests) was not tested.

---

## Contradictions and Disputes

- **Long polling vs. webhooks**: The grammY docs explicitly state "there are no major drawbacks to long polling" and it is "the recommended default." Broader webhook literature frames long polling as resource-intensive. For Relay's use case (infrequent agent messages, not a broadcast service), long polling is genuinely the simpler and more portable choice with no practical downside.
- **grammY runner vs. `bot.start()`**: grammY warns that `bot.start()` should not exceed ~5K messages/hour. For a DorkOS AI agent relay, this limit will not be reached in practice. The runner adds meaningful complexity for no benefit at this scale.
- **Redis vs. in-memory Map for nonce store**: Redis is objectively better for multi-process architectures. For DorkOS's single-process Express server, an in-memory Map is the correct pragmatic choice — Redis would add an unneeded runtime dependency.

---

## Search Methodology

- Searches performed: 11 web searches + 1 web fetch (grammy.dev/resources/comparison)
- Most productive search terms: `grammy vs telegraf typescript 2025 comparison`, `grammy error handling auto-retry long polling`, `webhook HMAC SHA256 typescript replay attack prevention`, `adapter plugin registry hot reload graceful shutdown typescript`, `react virtuoso auto-scroll activity feed 2025`
- Primary information sources: grammy.dev (official docs), hookdeck.com (webhook security guides), webhooks.fyi, npmtrends.com, virtuoso.dev, mswjs.io

---

## Sources

- [How grammY Compares to Other Bot Frameworks](https://grammy.dev/resources/comparison)
- [grammY Official Site](https://grammy.dev/)
- [Long Polling vs. Webhooks — grammY Guide](https://grammy.dev/guide/deployment-types)
- [Error Handling — grammY](https://grammy.dev/guide/errors)
- [Retry API Requests (auto-retry) — grammY Plugin](https://grammy.dev/plugins/auto-retry)
- [Scaling Up III: Reliability — grammY](https://grammy.dev/advanced/reliability)
- [grammY GitHub Repository](https://github.com/grammyjs/grammY)
- [grammy vs node-telegram-bot-api vs telegraf — npm trends](https://npmtrends.com/grammy-vs-node-telegram-bot-api-vs-telegraf-vs-telegram-bot-api)
- [Migration to grammY from Telegraf](https://medium.com/@dimpurr/migration-to-grammy-from-telegraf-a-guide-f68de99bc8b8)
- [grammY npm package](https://www.npmjs.com/package/grammy)
- [How to Implement SHA256 Webhook Signature Verification — Hookdeck](https://hookdeck.com/webhooks/guides/how-to-implement-sha256-webhook-signature-verification)
- [Webhook Security Vulnerabilities Guide — Hookdeck](https://hookdeck.com/webhooks/guides/webhook-security-vulnerabilities-guide)
- [Replay Prevention — webhooks.fyi](https://webhooks.fyi/security/replay-prevention)
- [HMAC Security — webhooks.fyi](https://webhooks.fyi/security/hmac)
- [Validating Webhook Deliveries — GitHub Docs](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [webhook-hmac-kit — Stripe-style toolkit](https://github.com/JosephDoUrden/webhook-hmac-kit)
- [Implementing Webhook Retries — Hookdeck](https://hookdeck.com/webhooks/guides/webhook-retry-best-practices)
- [Implementing Webhook Idempotency — Hookdeck](https://hookdeck.com/webhooks/guides/implement-webhook-idempotency)
- [Webhooks at Scale — DEV Community](https://dev.to/art_light/webhooks-at-scale-designing-an-idempotent-replay-safe-and-observable-webhook-system-7lk)
- [Testing Telegram Bots Locally](https://www.bafonins.xyz/articles/telegram-bot-local-testing/)
- [Node.js Integration — Mock Service Worker](https://mswjs.io/docs/integrations/node/)
- [Node.js Advanced Patterns: Plugin Manager](https://v-checha.medium.com/node-js-advanced-patterns-plugin-manager-44adb72aa6bb)
- [React Virtuoso Official Site](https://virtuoso.dev/)
- [React Virtuoso — npm](https://www.npmjs.com/package/react-virtuoso)
- [Virtuoso Message List — Scroll to Bottom Button Tutorial](https://virtuoso.dev/virtuoso-message-list/tutorial/scroll-to-bottom-button/)
- [Telegram Webhook Developer Guide — SES](https://softwareengineeringstandard.com/2025/08/26/telegram-webhook/)
- [Choosing between polling and webhook for Telegram bot development](https://community.latenode.com/t/choosing-between-polling-and-webhook-methods-for-telegram-bot-development/23989)
- [Handling Payment Webhooks Reliably — Medium](https://medium.com/@sohail_saifii/handling-payment-webhooks-reliably-idempotency-retries-validation-69b762720bf5)
