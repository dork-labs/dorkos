---
title: 'SSE Resilience & Production Patterns — Reconnection, Heartbeats, Connection Health UI, and React Integration'
date: 2026-03-24
type: external-best-practices
status: active
tags:
  [
    sse,
    eventsource,
    reconnection,
    heartbeat,
    backoff,
    jitter,
    connection-health,
    react-hooks,
    last-event-id,
    fetch-event-source,
    eventsource-parser,
    webtransport,
  ]
searches_performed: 16
sources_count: 32
---

# SSE Resilience & Production Patterns

## Research Summary

Server-Sent Events have undergone a significant revival in 2024–2026, primarily driven by the AI/LLM streaming boom. This research synthesizes production-grade patterns from the WHATWG spec, world-class application teams, and battle-tested libraries across eight dimensions: browser spec behavior, modern library alternatives, heartbeat patterns, connection status UX, exponential backoff with jitter, emerging techniques, React-specific lifecycle management, and Last-Event-ID resume semantics. The overarching finding is that native EventSource is both more capable and more limited than most developers assume — the spec is precise about reconnection, but proxies can silently break it, and the API's inflexibility (GET only, no custom headers) pushes production teams toward fetch-based alternatives.

---

## Key Findings

1. **Browser EventSource auto-reconnects, but only on network errors — not HTTP errors**: Per the WHATWG spec, 4xx/5xx responses cause the connection to fail permanently. Only network-level disconnects trigger automatic retry. The `reconnecting-eventsource` library exists precisely to fix this gap.

2. **Proxy buffering is the #1 production gotcha**: Intermediate proxies can legally buffer all SSE packets until the stream closes, silently destroying the real-time guarantee. The fix is application-level keepalive comments every 15–30 seconds, combined with a canary-detection mechanism to fall back to long polling.

3. **`@microsoft/fetch-event-source` is the de-facto production replacement for native EventSource**: POST support, custom headers, Page Visibility integration, response validation hooks, and controllable retry strategy make it superior for authenticated APIs and LLM streaming.

4. **`eventsource-parser` is the right tool for fetch-based SSE parsing**: It decouples parsing from transport, works with any stream source, and exposes a TransformStream interface for Node 18+ / modern browsers.

5. **Exponential backoff with Full Jitter is the AWS-recommended standard**: `sleep = random_between(0, min(cap, base * 2^attempt))` — prevents thundering herd far better than fixed-delay or capped-linear approaches.

6. **React SSE lifecycle has two valid models**: per-session hooks (create/destroy with component lifecycle) and singleton connection managers (module-level, shared across components via Zustand or context). The right choice depends on whether the connection is scoped to a view or global to the app.

7. **Last-Event-ID is a best-effort mechanism, not a guarantee**: Servers must implement their own replay buffer. Ephemeral servers (serverless, edge functions) cannot support Last-Event-ID without an external store (Redis, DB).

8. **WebTransport is not production-ready in 2026**: Dependent on HTTP/3, limited server support, not suitable as an SSE replacement yet.

---

## Detailed Analysis

### 1. Browser EventSource Reconnection Behavior

#### What the WHATWG Spec Actually Says

The spec defines a precise reconnection algorithm that most developers misunderstand:

**Reconnection triggers:**

- Network-level disconnects → automatic retry after reconnection time
- HTTP 301/307 redirects → followed, then reconnects
- HTTP 200 with wrong `Content-Type` → **connection fails, no reconnect**
- HTTP 4xx/5xx → **connection fails, no reconnect** (this surprises most developers)
- HTTP 204 → **explicitly stops reconnection forever**
- Aborted network error (e.g., `close()` called) → **no reconnect**

**The retry time mechanism:**

- Default: "a few seconds", implementation-defined (Chrome uses ~3000ms)
- Server override: send `retry: <milliseconds>` in the event stream to set the client's reconnection delay
- After a failed attempt, browsers "optionally wait some more — in particular, if the previous attempt failed, then user agents might introduce an exponential backoff delay" — but this is optional, not required
- The spec does NOT mandate exponential backoff; it merely permits it

**Gotcha: `id:` field placement matters**

The `id:` field should appear after `data:` in the event stream. If it appears before `data:` and the connection drops mid-message, the `lastEventId` may be updated for an incomplete message. Per spec, `id:` sets `lastEventId` when the event is dispatched, not when the field is parsed — but some implementations differ.

**Resetting Last-Event-ID:**
A server can clear the `lastEventId` by sending an empty `id:` field: `id:\n`. This prevents stale IDs from being sent on the next reconnect.

**The readyState state machine:**

```
CONNECTING (0) → OPEN (1) → CONNECTING (0) [on disconnect]
                           → CLOSED (2)   [on close() / 204 / failure]
```

Once `CLOSED`, the connection is dead. A new `EventSource` instance must be created.

#### Cross-Browser Gotchas

- **Chrome**: Adds exponential backoff after repeated failures (not spec-mandated, but behavior in practice)
- **Firefox**: More aggressive retry, may retry 4xx responses (inconsistent with spec)
- **Safari**: Generally spec-compliant; no exponential backoff
- **Node.js `eventsource` package**: Until recently, did NOT automatically send `Last-Event-ID` on reconnect for cross-origin requests (see [GitHub issue #291](https://github.com/EventSource/eventsource/issues/291))

#### The HTTP 4xx/5xx Gap — Why `reconnecting-eventsource` Exists

The [reconnecting-eventsource](https://github.com/fanout/reconnecting-eventsource) library by Fanout wraps native `EventSource` to also reconnect on HTTP error responses. Configuration:

```typescript
import ReconnectingEventSource from 'reconnecting-eventsource';

const es = new ReconnectingEventSource('/api/stream', {
  max_retry_time: 3000, // max wait before reconnect in ms
  withCredentials: true,
});
```

Key difference: native `EventSource` stops reconnecting when the server returns a 500. `ReconnectingEventSource` retries. For production APIs that can return transient 5xx errors, this matters.

---

### 2. Modern Alternatives to Native EventSource

#### Library Taxonomy

| Library                         | Method Support    | Custom Headers | Retry Control                  | Page Visibility | Stream API            | Best For                     |
| ------------------------------- | ----------------- | -------------- | ------------------------------ | --------------- | --------------------- | ---------------------------- |
| Native `EventSource`            | GET only          | No             | None (server `retry:`)         | No              | No                    | Simple, public streams       |
| `reconnecting-eventsource`      | GET only          | No             | `max_retry_time`               | No              | No                    | Drop-in for 4xx/5xx handling |
| `sse.js` (mpetazzoni)           | GET + POST        | Yes            | `maxRetries`, `reconnectDelay` | No              | No                    | Auth-gated streams           |
| `@microsoft/fetch-event-source` | Any method        | Yes            | Full control                   | Yes (auto)      | No                    | LLM APIs, authenticated SSE  |
| `eventsource-parser`            | N/A (parser only) | N/A            | N/A                            | N/A             | Yes (TransformStream) | Custom fetch-based SSE       |
| `eventsource-client` (rexxars)  | Any method        | Yes            | Configurable                   | No              | Yes (async iterator)  | Modern Node/browser clients  |

#### `@microsoft/fetch-event-source` (Azure/Microsoft)

The production-grade choice for authenticated APIs. It wraps the Fetch API with full SSE semantics:

```typescript
import { fetchEventSource } from '@microsoft/fetch-event-source';

const ctrl = new AbortController();

await fetchEventSource('/api/stream', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ prompt }),
  signal: ctrl.signal,

  // Response validation hook — runs before event parsing starts
  async onopen(response) {
    if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
      return; // all good
    }
    if (response.status === 429) {
      throw new RetriableError(); // tell the library to retry
    }
    throw new FatalError(); // stop retrying
  },

  onmessage(ev) {
    const data = JSON.parse(ev.data);
    // handle event
  },

  onclose() {
    // server closed connection gracefully
  },

  onerror(err) {
    if (err instanceof FatalError) {
      throw err; // stop retrying by re-throwing
    }
    // return a number to set custom retry delay in ms
    return 2000;
  },
});
```

Key capabilities:

- **Page Visibility integration**: Closes connection when tab hidden, auto-reconnects with `Last-Event-ID` when tab becomes visible. This alone saves significant server resources.
- **`onerror` return value controls retry delay**: Return a number (ms) to set the retry interval. Return nothing for default. Throw to abort.
- **`onopen` allows response validation**: Inspect status code, headers, and body before committing to streaming. Distinguish 4xx user errors from 5xx server errors.
- **AbortController support**: Clean cancellation at any point.

#### `eventsource-parser` (Espen Hovlandsdal / rexxars)

The right tool when you're handling SSE on the parsing layer — decoupled from transport:

```typescript
import { createParser } from 'eventsource-parser';

// Manual chunk feeding
const parser = createParser({
  onEvent(event) {
    console.log(event.data, event.id, event.event, event.retry);
  },
  onRetry(retryInterval) {
    // server sent retry: <ms>
  },
  onComment(comment) {
    // keepalive comments reach here (e.g., ": heartbeat")
  },
});

const response = await fetch('/api/stream');
const reader = response.body!.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  parser.feed(decoder.decode(value));
}
```

TransformStream variant for Node 18+ / modern browsers:

```typescript
import { EventSourceParserStream } from 'eventsource-parser/stream';

const response = await fetch('/api/stream');
const eventStream = response
  .body!.pipeThrough(new TextDecoderStream())
  .pipeThrough(new EventSourceParserStream());

for await (const event of eventStream) {
  console.log(event.data);
}
```

This is the pattern DorkOS's `parseSSEStream` essentially implements — the TransformStream variant is the cleaner modern form.

#### `sse.js` (mpetazzoni)

An older but widely-used polyfill that supports POST and custom headers. The `autoReconnect` option provides `maxRetries` and `reconnectDelay` control. Less active than `fetch-event-source` but available as a drop-in for legacy codebases.

---

### 3. Heartbeat / Keepalive Patterns

#### Why Heartbeats Are Necessary

SSE connections cross infrastructure that applies idle timeouts:

- **Nginx default proxy timeout**: 60 seconds
- **AWS Application Load Balancer**: 60-second idle timeout (configurable to 4000s)
- **Azure Application Gateway**: 4-minute idle timeout
- **Cloudflare**: 100-second connection timeout
- **Corporate proxies**: Various; often 30–90 seconds; some buffer everything until close

Without keepalive, long-running AI response streams (which may take 30+ seconds of "thinking" before the first token) will be silently killed by proxies before the first byte reaches the client.

#### The SSE Comment Keepalive

The spec defines comment lines (starting with `:`) as no-ops for event processing but they flush through the TCP stack as actual bytes. This is the universal keepalive mechanism:

```
: keepalive\n\n
```

or simply:

```
:\n\n
```

Production standard intervals:

- **15 seconds**: Recommended by WHATWG spec editors and by Mercure, handles most proxy timeouts
- **30 seconds**: More conservative, acceptable for most infrastructure
- **45 seconds**: Minimum safe value for Cloudflare

Server-side implementation (Node.js/Express):

```typescript
// Keepalive timer — send comment every 15s
const keepalive = setInterval(() => {
  if (!res.writableEnded) {
    res.write(': keepalive\n\n');
  }
}, 15_000);

req.on('close', () => {
  clearInterval(keepalive);
});
```

#### Detecting Stale Connections (Client-Side)

The browser's `EventSource` does not expose an idle timer. Options for detecting a stale connection:

**Option A: Server-sent heartbeat events with timestamps**

```typescript
// Server sends typed heartbeat events
res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);

// Client detects staleness
let lastHeartbeat = Date.now();
es.addEventListener('heartbeat', () => {
  lastHeartbeat = Date.now();
});

// Watchdog: if no heartbeat in 45s, reconnect
const watchdog = setInterval(() => {
  if (Date.now() - lastHeartbeat > 45_000) {
    es.close();
    reconnect(); // manual reconnect
  }
}, 5_000);
```

**Option B: Canary detection on open**
Send a `connection_established` event immediately when the SSE connection opens. If the client doesn't receive it within 3–5 seconds, it means the connection is being buffered by a proxy. Fall back to long polling:

```typescript
const connectionTimeout = setTimeout(() => {
  es.close();
  switchToLongPolling();
}, 5_000);

es.addEventListener('connection_established', () => {
  clearTimeout(connectionTimeout);
});
```

This is the Mike Talbot pattern — battle-tested on enterprise networks where proxy buffering silently breaks SSE.

---

### 4. Connection Status UI Patterns

#### The Design Hierarchy

Production apps use a three-tier system for connection health communication:

**Tier 1: Passive indicator** — always visible, never intrusive

- Small dot or icon in the app chrome (header, status bar)
- States: connected (green/none), reconnecting (amber/animated), offline (red/static)
- Principle from Google's offline UX guidelines: don't use color alone; pair with icon or text

**Tier 2: Contextual banner** — appears when state degrades

- Slides in from top or bottom when disconnected/reconnecting
- Contains: status text + optional manual retry button + time since last connection
- Dismissable or auto-dismisses on reconnect
- Material Design / Google's recommendation: use toasts for transient states, banners for persistent degraded states

**Tier 3: Content-level degradation** — stale data indicators

- Timestamp "last updated X minutes ago" on data panels
- Grayed-out / opacity-reduced data that may be stale
- Skeleton loaders for pending refreshes

#### Language Patterns

Google's offline UX research explicitly recommends against the word "offline" for non-technical audiences. Production patterns:

| Avoid               | Use Instead                                        |
| ------------------- | -------------------------------------------------- |
| "Offline"           | "Can't connect", "Not connected"                   |
| "Reconnecting"      | "Trying to reconnect…", "Reconnecting (attempt 3)" |
| "Connection error"  | "Something went wrong. Retrying in Xs."            |
| No text, color only | Always pair color with label or icon               |

**Slack's pattern** (documented): Displays a yellow banner with "Slack is trying to reconnect" with no dismiss button (because it auto-dismisses when reconnection succeeds). Also shows previously-loaded messages with "Viewing older messages" to maintain usability.

**Linear's pattern**: Minimal — a small status dot in the sidebar, no banner unless offline for >30 seconds. Reflects their developer-focused audience who prefers low noise.

**VS Code Live Share**: Uses a status bar item that pulses when reconnecting. Provides a `Try to reconnect` command. Shows "Offline" state with a clock icon indicating last sync time.

#### React State Machine for Connection Status

```typescript
type ConnectionStatus =
  | 'connecting' // initial connection attempt
  | 'connected' // healthy, receiving events
  | 'reconnecting' // lost connection, attempting retry
  | 'degraded' // connected but slow/stale (no heartbeat recently)
  | 'failed' // max retries exhausted
  | 'offline'; // navigator.onLine is false

// Transitions:
// connecting → connected (onopen)
// connected → reconnecting (onerror + will retry)
// connected → offline (navigator.onLine = false)
// reconnecting → connected (onopen after retry)
// reconnecting → failed (max retries reached)
// offline → connecting (navigator.onLine = true)
// any → connected (successful heartbeat received)
```

For DorkOS's developer persona (Kai), Tier 1 passive indicators are preferred. Banners should be reserved for states lasting >5 seconds. The language should be technical and honest: "SSE connection lost — reconnecting (attempt 2/5)" rather than "Having trouble connecting."

#### Reconnect Attempt Counter

Displaying the attempt count ("Reconnecting… attempt 3 of 5") serves the developer persona: it communicates that the system is working and sets expectations for when to escalate. Consumer apps typically hide this; developer tools expose it.

---

### 5. Exponential Backoff with Jitter

#### The AWS Algorithm (Industry Standard)

The AWS Architecture Blog defines four variants. The **Full Jitter** variant is recommended for SSE reconnection:

```
// Full Jitter (AWS recommended)
sleep = random_between(0, min(cap, base * 2^attempt))
```

Where:

- `base`: initial delay in ms (e.g., `500`)
- `cap`: maximum delay in ms (e.g., `30_000`)
- `attempt`: zero-indexed attempt number

**Why Full Jitter beats fixed delays**: With N clients simultaneously disconnected (thundering herd scenario), full jitter spreads reconnection across the entire interval, minimizing server congestion. A fixed 3-second delay causes all N clients to hit the server simultaneously.

**Why Full Jitter beats Equal Jitter**: Equal Jitter (`random_between(cap/2, min(cap, base * 2^attempt))`) keeps a minimum floor, which can still create bursts at low attempt counts.

**Decorrelated Jitter** (AWS alternative):

```
sleep = random_between(base, sleep_prev * 3)
sleep = min(cap, sleep)
```

This increases the maximum jitter based on the previous sleep value, providing more uniform distribution over time. Slightly more complex to implement.

#### Production TypeScript Implementation

```typescript
interface BackoffConfig {
  base?: number; // initial delay ms (default: 500)
  cap?: number; // max delay ms (default: 30_000)
  maxAttempts?: number; // 0 = infinite (default: 10)
}

function calculateBackoffDelay(attempt: number, config: BackoffConfig = {}): number {
  const { base = 500, cap = 30_000 } = config;
  // Full Jitter: random between 0 and min(cap, base * 2^attempt)
  const exponential = Math.min(cap, base * Math.pow(2, attempt));
  return Math.floor(Math.random() * exponential);
}

// Usage in SSE reconnection loop
class SSEConnection {
  private attempt = 0;
  private abortController: AbortController | null = null;

  async connect(url: string, config: BackoffConfig = {}): Promise<void> {
    const { maxAttempts = 10 } = config;

    while (maxAttempts === 0 || this.attempt <= maxAttempts) {
      try {
        this.abortController = new AbortController();
        await fetchEventSource(url, {
          signal: this.abortController.signal,
          onopen: async () => {
            this.attempt = 0;
          }, // reset on success
          onerror: (err) => {
            if (this.attempt >= maxAttempts && maxAttempts !== 0) {
              throw new Error('Max reconnection attempts reached');
            }
            const delay = calculateBackoffDelay(this.attempt++, config);
            return delay; // fetch-event-source uses this as retry delay
          },
        });
      } catch (err) {
        if (this.abortController.signal.aborted) break; // intentional close
        const delay = calculateBackoffDelay(this.attempt++, config);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  close(): void {
    this.abortController?.abort();
    this.attempt = 0;
  }
}
```

#### When to Reset the Attempt Counter

Reset `attempt = 0` when:

1. The connection successfully opens and stays open for N seconds (e.g., >5s — not just a flash of connectivity)
2. The user explicitly clicks "Reconnect"
3. `navigator.onLine` transitions from `false` to `true`

Do NOT reset immediately on `onopen` if the server might send an immediate error. Wait for the first successful event or a short stability window.

#### SSE-Specific Nuance: Server `retry:` Field

The server can override the client's backoff by sending `retry: <ms>`. Production practice: send `retry: 1000` at stream open to communicate the minimum acceptable reconnect interval. Clients that implement `onRetry` (like `eventsource-parser`) will honor this.

For a server that's under load, sending `retry: 30000` tells all clients to wait at least 30 seconds, preventing thundering herd on server restart.

---

### 6. Emerging Patterns (2025–2026)

#### Fetch + ReadableStream as Direct EventSource Replacement

Native `fetch` with `ReadableStream` is increasingly used instead of `EventSource`, particularly for:

- POST-based SSE (LLM APIs)
- Custom header requirements (auth tokens)
- Fine-grained control over reconnection

Pattern:

```typescript
async function* streamSSE(url: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const parser = new EventSourceParserStream();
  const eventStream = response.body!.pipeThrough(new TextDecoderStream()).pipeThrough(parser);

  for await (const event of eventStream) {
    yield event;
  }
}
```

This is what the Vercel AI SDK, OpenAI TypeScript SDK, and Anthropic TypeScript SDK all use internally. The pattern is now the industry standard for LLM streaming.

#### HTTP/2 Multiplexing and Multiple SSE Streams

Under HTTP/1.1, browsers limit 6 connections per domain. Under HTTP/2, all SSE connections are multiplexed over a single TCP connection. This eliminates the classic "too many tabs" problem.

Production implication: if you're serving over HTTP/2 (which any modern CDN or reverse proxy does by default), the concern about connection limits is largely academic. The bottleneck shifts to server-side connection handling capacity.

#### WebTransport — Not Yet

WebTransport (built on HTTP/3 + QUIC) promises lower latency, bidirectional streams, and unreliable datagrams. As of early 2026:

- Chrome and Edge support it; Firefox is in progress; Safari has not shipped
- Server-side support is limited (Node.js via experimental APIs, nginx pending)
- No major production framework uses it for SSE replacement yet

Verdict: monitor, do not adopt. SSE over HTTP/2 handles the current workload.

#### Service Workers as SSE Proxies

An emerging pattern for Progressive Web Apps:

```
Browser tab → Service Worker → SSE server connection
```

The Service Worker maintains a single SSE connection even when all tabs are closed (background sync). Tabs register listeners with the Service Worker. Benefits:

- One connection per user (not per tab)
- Background event processing
- Offline queue management

Limitations: Service Workers cannot make SSE requests directly; they use `fetch` to manage the stream. Implementation complexity is high. Only recommended for apps with strict background sync requirements.

#### Mercure as a Managed SSE Hub

[Mercure](https://mercure.rocks/) (by Kévin Dunglas) is a production-grade SSE hub that handles:

- Authorization via JWT in URL
- History replay with configurable buffer
- Subscription negotiation
- Scalable fan-out

For DorkOS's architecture (single-user, single-server), Mercure is overkill. But its dual-buffer pattern (history buffer drained before live events) is worth emulating in-process (already documented in `20260306_sse_relay_delivery_race_conditions.md`).

---

### 7. React-Specific Patterns

#### Model 1: Per-Session Hook (Standard Pattern)

Scoped to a component or feature. Connection created when the view mounts, destroyed on unmount.

```typescript
interface UseSSEOptions {
  url: string | null;
  onEvent: (event: MessageEvent) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  backoff?: BackoffConfig;
}

function useSSE({ url, onEvent, onStatusChange, backoff }: UseSSEOptions) {
  const esRef = useRef<EventSource | null>(null);
  const attemptsRef = useRef(0);
  const statusRef = useRef<ConnectionStatus>('connecting');
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!url || esRef.current) return;

    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      attemptsRef.current = 0;
      statusRef.current = 'connected';
      onStatusChange?.('connected');
    };

    es.onmessage = onEvent;

    es.onerror = () => {
      es.close();
      esRef.current = null;
      statusRef.current = 'reconnecting';
      onStatusChange?.('reconnecting');

      const delay = calculateBackoffDelay(attemptsRef.current++, backoff);
      retryTimerRef.current = setTimeout(connect, delay);
    };
  }, [url, onEvent, onStatusChange, backoff]);

  useEffect(() => {
    connect();
    return () => {
      retryTimerRef.current && clearTimeout(retryTimerRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [connect]);
}
```

**Key conventions:**

- `useRef` for the `EventSource` instance — never `useState`. Storing it in state causes re-renders on every connection event.
- `useRef` for the attempt counter — avoids stale closures in the error handler.
- Cleanup function MUST clear both the timer and the EventSource.
- The `onEvent` callback should be stable (`useCallback` or `useRef`-wrapped) to avoid the effect re-running on every render.

#### Stable Callback Pattern (Critical)

```typescript
// WRONG: onEvent changes on every render → effect re-runs → connection thrash
function MyComponent({ sessionId }) {
  useSSE({
    url: `/api/sessions/${sessionId}/stream`,
    onEvent: (e) => setData(JSON.parse(e.data)), // new reference every render
  });
}

// RIGHT: stable reference via useRef
function MyComponent({ sessionId }) {
  const onEventRef = useRef<(e: MessageEvent) => void>();
  onEventRef.current = (e) => setData(JSON.parse(e.data));

  useSSE({
    url: `/api/sessions/${sessionId}/stream`,
    onEvent: useCallback((e) => onEventRef.current?.(e), []), // stable
  });
}
```

#### Model 2: Singleton Connection Manager (App-Wide Connections)

For connections that should persist across route changes (notification streams, system health streams), a module-level singleton pattern avoids thrashing connections on navigation.

```typescript
// connection-manager.ts (module level — not inside a component)
type Listener = (event: ParsedEvent) => void;

class SSEConnectionManager {
  private connections = new Map<
    string,
    {
      es: EventSource;
      listeners: Set<Listener>;
      attempt: number;
    }
  >();

  subscribe(url: string, listener: Listener): () => void {
    if (!this.connections.has(url)) {
      this.open(url);
    }
    this.connections.get(url)!.listeners.add(listener);

    // Return unsubscribe function
    return () => {
      const conn = this.connections.get(url);
      if (!conn) return;
      conn.listeners.delete(listener);
      if (conn.listeners.size === 0) {
        conn.es.close();
        this.connections.delete(url);
      }
    };
  }

  private open(url: string): void {
    const es = new EventSource(url);
    const entry = { es, listeners: new Set<Listener>(), attempt: 0 };
    this.connections.set(url, entry);

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      entry.listeners.forEach((l) => l(event));
    };

    es.onerror = () => {
      es.close();
      this.connections.delete(url);
      const delay = calculateBackoffDelay(entry.attempt++);
      setTimeout(() => {
        if (entry.listeners.size > 0) this.open(url);
      }, delay);
    };
  }
}

export const connectionManager = new SSEConnectionManager();

// React hook wrapping the manager
function useConnectionManager(url: string | null, onEvent: Listener) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!url) return;
    const stable: Listener = (e) => onEventRef.current(e);
    return connectionManager.subscribe(url, stable);
  }, [url]);
}
```

**Zustand integration**: Store the `ConnectionStatus` in a Zustand slice. The connection manager calls `useConnectionStore.getState().setStatus()` on state transitions. Components subscribe to the store for reactive UI updates.

```typescript
// connection-store.ts
interface ConnectionState {
  statuses: Record<string, ConnectionStatus>;
  setStatus: (url: string, status: ConnectionStatus) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  statuses: {},
  setStatus: (url, status) => set((s) => ({ statuses: { ...s.statuses, [url]: status } })),
}));
```

#### Cleanup on Unmount vs. Keeping Connections Alive

**Close on unmount** is correct for:

- Per-session chat connections (the session IS the component)
- Any connection that is logically scoped to the current view
- Connections that consume significant server resources

**Keep alive across unmounts** is correct for:

- Global notification streams
- System health streams displayed in a persistent sidebar
- Any connection where the data accumulated while "away" is needed on return

The keep-alive pattern requires the singleton manager approach. Never achieve it by fighting React's lifecycle — extract the connection to module scope.

#### Page Visibility Optimization

Close connections when the tab is hidden, reconnect when visible:

```typescript
useEffect(() => {
  const handleVisibility = () => {
    if (document.hidden) {
      esRef.current?.close();
      esRef.current = null;
    } else {
      connect(); // will pick up Last-Event-ID if implemented
    }
  };

  document.addEventListener('visibilitychange', handleVisibility);
  return () => document.removeEventListener('visibilitychange', handleVisibility);
}, [connect]);
```

`@microsoft/fetch-event-source` does this automatically when `openWhenHidden: false` (the default). For native EventSource you implement it manually.

---

### 8. Resume from Last Event — Last-Event-ID vs. Custom Offset Tracking

#### How Last-Event-ID Works (Precisely)

1. Server sends events with `id:` fields
2. Browser stores the most recent `id` as `eventSource.lastEventId`
3. On reconnect, browser sends `Last-Event-ID: <value>` request header
4. Server receives the header and replays missed events from that point

#### Server-Side Replay Buffer Requirements

For Last-Event-ID to be meaningful, the server must:

1. Maintain a buffer of recent events keyed by their IDs
2. On reconnect, find the event matching the `Last-Event-ID` in its buffer
3. Replay all events after that point before resuming live streaming

**Minimum viable replay buffer (in-process)**:

```typescript
class ReplayBuffer {
  private buffer: Array<{ id: string; event: string }> = [];
  private readonly maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  add(id: string, event: string): void {
    this.buffer.push({ id, event });
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift(); // evict oldest
    }
  }

  since(lastEventId: string | undefined): Array<{ id: string; event: string }> {
    if (!lastEventId) return [];
    const idx = this.buffer.findIndex((e) => e.id === lastEventId);
    if (idx === -1) return this.buffer; // ID not found, send everything
    return this.buffer.slice(idx + 1);
  }
}

// In SSE handler:
const lastEventId = req.headers['last-event-id'];
const missed = replayBuffer.since(lastEventId);
for (const { id, event } of missed) {
  res.write(`id: ${id}\n${event}\n\n`);
}
```

#### Limitations of Native Last-Event-ID

**Ephemeral servers**: Serverless functions (AWS Lambda, Vercel Edge Functions) have no in-memory state between invocations. Last-Event-ID is useless without an external store (Redis, DynamoDB, Upstash). This is a fundamental architectural constraint.

**ID design**: Sequential integers work but reveal event counts. Use prefixed IDs: `{sessionId}-{sequence}` to namespace events per session. Enables efficient range queries.

**The gap problem**: If the client was disconnected during a high-volume burst and the buffer overflowed, `since()` will return all buffered events — but earlier events are gone. This is the "best-effort" aspect of the spec. Production mitigations:

- Larger buffers (trade memory for reliability)
- Persistent replay (database-backed buffer)
- Event compaction (deliver only the latest state, not every delta)

#### Custom Offset Tracking (Higher Reliability)

For systems where every event matters (financial data, audit logs, agent output), custom cursor-based tracking is more reliable than Last-Event-ID:

```typescript
// Client sends explicit cursor on reconnect
const cursor = localStorage.getItem('stream_cursor');
const url = cursor ? `/api/sessions/${id}/stream?after=${cursor}` : `/api/sessions/${id}/stream`;

// Server handles ?after= parameter:
const after = req.query.after as string | undefined;
const events = after
  ? await eventStore.getEventsSince(sessionId, after)
  : await eventStore.getLatestEvents(sessionId);
```

This is the pattern used by:

- Kafka consumer offsets (not SSE, but the concept)
- GitHub event polling (using `X-GitHub-Last-Event-ID`)
- Pusher's channel history with event cursor

The key advantage: the cursor is persisted by the client (localStorage, IndexedDB), survives page reloads, tab closures, and even browser restarts.

#### DorkOS Context: What's Already Correct

The DorkOS direct SSE path (`HttpTransport.sendMessage()`) uses a POST-response-as-stream pattern, meaning the stream is per-message, not per-session. This means:

- Last-Event-ID is largely irrelevant for the streaming response (each message is a fresh stream)
- The persistent `EventSource` for `sync_update` events is a separate connection where Last-Event-ID could be implemented for reconnect recovery
- The replay buffer from `20260306_sse_relay_delivery_race_conditions.md` remains valid for the relay-adjacent case

---

## Production Gotchas Summary

| Gotcha                                             | Risk Level         | Mitigation                                               |
| -------------------------------------------------- | ------------------ | -------------------------------------------------------- |
| HTTP 4xx/5xx stops native EventSource reconnection | High               | Use `reconnecting-eventsource` or `fetch-event-source`   |
| Proxy buffering silently swallows events           | High               | Canary detection + 15s keepalive comments                |
| Native EventSource GET-only, no auth headers       | High               | Use `fetch-event-source` or `eventsource-parser` + fetch |
| `id:` before `data:` causes stale lastEventId      | Medium             | Always put `id:` after `data:`                           |
| EventSource CLOSED state requires new instance     | Medium             | Instantiate new EventSource on reconnect                 |
| No heartbeat → ALB/Nginx kills connection          | Medium             | 15–30s server-side comment keepalive                     |
| HTTP/1.1 6-connection browser limit                | Low (HTTP/2 fixes) | Serve over HTTP/2                                        |
| onEvent callback instability thrashes useEffect    | Medium             | Stable ref pattern for callbacks                         |
| Max retries reached with no UI indicator           | Medium             | Expose attempt counter and "failed" state                |
| Last-Event-ID fails on ephemeral serverless        | High               | External event store or custom cursor                    |

---

## Research Gaps & Limitations

- No direct inspection of how Slack or Linear implement their specific reconnection logic (both are closed-source). Descriptions are based on observable behavior.
- Service Worker as SSE proxy is theoretically sound but no production case study was found. Experimental pattern only.
- `eventsource-client` (rexxars) has configurable reconnection policy listed as a TODO — this may have landed between research and production use; check the changelog.
- The proxy buffering problem (Mike Talbot) applies primarily to HTTP/1.1 paths. HTTP/2 and HTTP/3 have different framing that may reduce this risk — not yet confirmed.

---

## Contradictions & Disputes

**"SSE auto-reconnects vs. SSE doesn't auto-reconnect on 5xx"**: Both are true, depending on context. The browser auto-reconnects on network errors. It does NOT reconnect on HTTP errors (4xx, 5xx). Many tutorials omit this distinction. The reconnecting-eventsource library exists precisely to bridge this gap.

**"WebTransport is the future vs. SSE is sufficient"**: WebTransport advocates emphasize lower latency and bidirectional streams. SSE advocates note that HTTP/2 multiplexing has eliminated most of SSE's scalability concerns, and HTTP/3-dependent WebTransport has no mature production server support. For the DorkOS use case (server-to-client streaming, developer audience, single-user server), SSE is the correct choice through at least 2027.

**"Heartbeats should be 15s vs. 30s"**: Both values appear in authoritative sources. 15s is safer (matches the most aggressive proxy timeouts). 30s is common in practice. The WHATWG spec example uses "15 seconds or so."

---

## Sources & Evidence

- WHATWG HTML Living Standard — Server-Sent Events spec: [html.spec.whatwg.org](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- MDN: Using server-sent events: [developer.mozilla.org](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- javascript.info: Server-Sent Events deep dive: [javascript.info](https://javascript.info/server-sent-events)
- Microsoft Azure/fetch-event-source GitHub: [github.com/Azure/fetch-event-source](https://github.com/Azure/fetch-event-source)
- npm: @microsoft/fetch-event-source: [npmjs.com](https://www.npmjs.com/package/@microsoft/fetch-event-source)
- eventsource-parser (rexxars) GitHub: [github.com/rexxars/eventsource-parser](https://github.com/rexxars/eventsource-parser)
- eventsource-client (rexxars) GitHub: [github.com/rexxars/eventsource-client](https://github.com/rexxars/eventsource-client)
- reconnecting-eventsource (Fanout) GitHub: [github.com/fanout/reconnecting-eventsource](https://github.com/fanout/reconnecting-eventsource)
- sse.js (mpetazzoni) GitHub: [github.com/mpetazzoni/sse.js](https://github.com/mpetazzoni/sse.js)
- AWS Architecture Blog: Exponential Backoff and Jitter: [aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- "How I stopped 503 spam in SSE: fetch-event-source + exponential backoff + jitter": [Medium/Andersen IT Community](https://medium.com/andersen-it-community/how-i-stopped-503-spam-in-sse-fetch-event-source-exponential-backoff-jitter-14f36b357e6d)
- "Server-Sent Events are still not production ready after a decade" (Mike Talbot): [dev.to](https://dev.to/miketalbot/server-sent-events-are-still-not-production-ready-after-a-decade-a-lesson-for-me-a-warning-for-you-2gie)
- "How to Implement Server-Sent Events (SSE) in React" (OneUptime): [oneuptime.com](https://oneuptime.com/blog/post/2026-01-15-server-sent-events-sse-react/view)
- Google Offline UX Design Guidelines: [web.dev](https://web.dev/offline-ux-design-guidelines/)
- RxDB: WebSockets vs SSE vs Long-Polling vs WebTransport: [rxdb.info](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html)
- "SSE's Glorious Comeback: Why 2025 is the Year of SSE": [portalzine.de](https://portalzine.de/sses-glorious-comeback-why-2025-is-the-year-of-server-sent-events/)
- WHATWG HTML issue: SSE Keep-Alive Messages: [github.com/whatwg/html/issues/7571](https://github.com/whatwg/html/issues/7571)
- EventSource Node.js issue: Last-Event-ID not sent on cross-origin reconnect: [github.com/EventSource/eventsource/issues/291](https://github.com/EventSource/eventsource/issues/291)
- Datto Engineering: Powering a live UI with SSE: [datto.engineering](https://datto.engineering/post/powering-a-live-ui-with-server-sent-events)
- MCP Transports spec (Last-Event-ID in Streamable HTTP): [modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- "Beyond EventSource: Streaming fetch with ReadableStream": [Medium](https://rob-blackbourn.medium.com/beyond-eventsource-streaming-fetch-with-readablestream-5765c7de21a1)
- WebSockets vs SSE vs WebTransport 2025: [aptuz.com](https://www.aptuz.com/blog/websockets-vs-sse-vs-webtransports/)

---

## Search Methodology

- Searches performed: 16
- Most productive search terms: "fetch-event-source microsoft SSE library vs native EventSource production 2025", "exponential backoff jitter SSE reconnection algorithm production implementation", "SSE heartbeat keepalive interval production apps", "eventsource-parser library SSE streaming TypeScript LLM production 2025", "SSE thundering herd reconnect server-side connection limit backpressure", "connection status UI indicator banner reconnecting offline web app UX patterns 2025"
- Primary information sources: WHATWG spec, MDN, GitHub READMEs (Azure/fetch-event-source, rexxars/eventsource-parser, fanout/reconnecting-eventsource), AWS Architecture Blog, dev.to (Mike Talbot article), web.dev (Google offline UX), javascript.info, rxdb.info
- Fetch failures (403/429): 4 URLs blocked; information was reconstructed from alternative sources and search snippets
