import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import log from 'electron-log';

/**
 * The one connection to the server's global event stream (`GET /api/events`),
 * shared by every main-process consumer that needs to watch it.
 *
 * `agent-activity.ts` was the first reader — it needs `session_status` for the
 * tray — and this module is that reader's connection machinery, pulled out so
 * `notifications/index.ts` (DOR-1386) can watch the same stream for
 * `notification`, `notification_read`, `interaction_pending` and
 * `interaction_resolved`
 * without opening a second TCP connection and running a second reconnect loop
 * against the same endpoint. Two independent HTTP clients polling the same SSE
 * stream would double the server's fan-out work for every event, for no
 * benefit: both consumers want every frame, they just each care about
 * different event names.
 *
 * A subscriber gets every parsed frame on the stream, filters by `name`
 * itself, and decides what a lost connection means for its own state — this
 * module only owns the wire, never the meaning of what rides it, the same
 * split `agent-activity.ts` drew between "is JSON on the wire" and "does it
 * change the count".
 *
 * @module main/event-stream
 */

/** One parsed Server-Sent Event frame off the stream, before any consumer has interpreted it. */
export interface ServerEventFrame {
  /** The event name — the SSE `event:` line, or `'message'` if the frame omitted one. */
  name: string;
  /** The raw `data:` payload, still JSON text. */
  data: string;
}

/** Point-in-time accessor for the server's port; `null` while no server is running. */
export type GetServerPort = () => number | null;

/** What a subscriber wants to hear about the stream. */
export interface EventStreamHandlers {
  /** Called for every frame, of every event name, on the stream. */
  onFrame: (frame: ServerEventFrame) => void;
  /**
   * Called whenever the underlying connection is lost — a drop, a refusal, or
   * an idle timeout — before the shared module starts trying to reconnect.
   *
   * Optional: a subscriber with no notion of "currently connected" state (an
   * upsert-only consumer like the notifications pipeline) has nothing to do
   * here and can omit it.
   */
  onConnectionLost?: () => void;
}

/** A subscription to the shared event stream. */
export interface EventStreamSubscription {
  /**
   * Stop receiving frames. The underlying connection is torn down once the
   * last subscriber unsubscribes, and the retry backoff resets for whoever
   * subscribes next.
   */
  unsubscribe(): void;
}

/** First reconnect delay after the stream drops. */
const RECONNECT_BASE_MS = 1_000;

/** Ceiling on the exponential reconnect backoff. */
const RECONNECT_MAX_MS = 15_000;

/** The server's own SSE heartbeat is every 15s; a stream silent for much longer than that is gone. */
const STREAM_IDLE_TIMEOUT_MS = 45_000;

/** Everyone currently watching the stream. */
const subscribers = new Set<EventStreamHandlers>();

/** The `getPort` accessor the live connection (if any) was opened with. */
let activeGetPort: GetServerPort | null = null;

let request: ReturnType<typeof http.get> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = RECONNECT_BASE_MS;

/** Whether the last connection attempt already logged its failure — one line per outage, not per retry. */
let outageLogged = false;

/** Subscribe to the shared server event stream.
 *
 * Multiple subscribers share one HTTP connection: the first subscribe opens
 * it, the last unsubscribe closes it. `options.getPort` from whichever
 * subscriber is currently first in line is what a (re)connect attempt reads —
 * in practice every call site passes the same `getServerPort` accessor, so
 * this is never actually ambiguous.
 *
 * @param options - Where to find the server's port right now.
 * @param handlers - See {@link EventStreamHandlers}.
 */
export function subscribeEventStream(
  options: { getPort: GetServerPort },
  handlers: EventStreamHandlers
): EventStreamSubscription {
  activeGetPort = options.getPort;
  subscribers.add(handlers);
  if (subscribers.size === 1) connect();

  return {
    unsubscribe(): void {
      subscribers.delete(handlers);
      if (subscribers.size === 0) teardown();
    },
  };
}

/** Tear down the live connection and reset backoff state for the next subscriber. */
function teardown(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  request?.destroy();
  request = null;
  activeGetPort = null;
  retryDelayMs = RECONNECT_BASE_MS;
  outageLogged = false;
}

/**
 * Run one subscriber callback, isolating whatever it throws.
 *
 * Without this, one subscriber's bug takes down every other subscriber on the
 * same frame (the loop below it never runs) AND escapes as an uncaught
 * exception in the main process — a crash caused by, say, a malformed
 * `notification` payload the notifications pipeline mishandled, taking the
 * tray's activity count down with it for no reason connected to the tray at
 * all.
 *
 * @param run - The subscriber call to make.
 */
function safelyNotify(run: () => void): void {
  try {
    run();
  } catch (err) {
    log.warn('[event-stream] A subscriber threw on a frame; the stream continues.', err);
  }
}

function notifyConnectionLost(): void {
  for (const handlers of [...subscribers]) safelyNotify(() => handlers.onConnectionLost?.());
}

function notifyFrame(frame: ServerEventFrame): void {
  for (const handlers of [...subscribers]) safelyNotify(() => handlers.onFrame(frame));
}

function scheduleReconnect(): void {
  if (subscribers.size === 0 || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelayMs);
  // Never let the retry timer be the reason the process stays alive.
  retryTimer.unref();
  retryDelayMs = Math.min(retryDelayMs * 2, RECONNECT_MAX_MS);
}

function dropConnection(): void {
  request?.destroy();
  request = null;
  notifyConnectionLost();
}

function connect(): void {
  if (subscribers.size === 0 || request || !activeGetPort) return;
  const port = activeGetPort();
  if (!port) {
    scheduleReconnect();
    return;
  }

  // 127.0.0.1 rather than `localhost` so this never depends on how the
  // machine resolves that name; the server's Host guard (DOR-532) allows
  // both, and Node sets the Host header from the URL for us.
  request = http.get(
    {
      host: '127.0.0.1',
      port,
      path: '/api/events',
      headers: { accept: 'text/event-stream' },
    },
    (response) => handleResponse(response)
  );
  request.setTimeout(STREAM_IDLE_TIMEOUT_MS, () => {
    // A stream that has gone quiet past the server's heartbeat is a stream
    // that is not coming back; drop it so the reconnect loop can take over.
    dropConnection();
    scheduleReconnect();
  });
  request.on('error', (err: Error) => {
    if (!outageLogged) {
      outageLogged = true;
      log.warn('[event-stream] Lost the connection to the server event stream.', err.message);
    }
    dropConnection();
    scheduleReconnect();
  });
}

function handleResponse(response: IncomingMessage): void {
  if (response.statusCode !== 200) {
    if (!outageLogged) {
      outageLogged = true;
      // The one real case: the person turned sign-in on, so `/api` now wants
      // credentials the shell does not hold. Every subscriber degrades
      // together — there is one stream, so one outage.
      log.warn(
        `[event-stream] The server event stream answered ${response.statusCode}; ` +
          'agent activity and notifications will not be shown.'
      );
    }
    response.resume();
    dropConnection();
    scheduleReconnect();
    return;
  }

  outageLogged = false;
  retryDelayMs = RECONNECT_BASE_MS;
  response.setEncoding('utf-8');

  let buffer = '';
  response.on('data', (chunk: string) => {
    buffer += chunk;
    // SSE frames are separated by a blank line; anything after the last one
    // is a partial frame and is carried over to the next chunk.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) notifyFrame(parseFrame(frame));
  });
  response.on('end', () => {
    dropConnection();
    scheduleReconnect();
  });
}

/** Split an SSE frame into its event name and its `data:` payload. */
function parseFrame(frame: string): ServerEventFrame {
  let name = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  return { name, data: data.join('\n') };
}

/** Parse a JSON payload, or `null` if it isn't an object. */
export function parseEventPayload(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
