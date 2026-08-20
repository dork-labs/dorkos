import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import log from 'electron-log';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';

/**
 * How many of your agents are mid-run, right now — and which of them are
 * producing versus waiting on you.
 *
 * The shell needs this in two places a renderer cannot help with: the tray has
 * to say something true while the window is closed, and the quit guard has to
 * know whether quitting would cut anything off. So the main process subscribes
 * to the server's own global event stream (`GET /api/events`) directly, the
 * same one the cockpit uses — no polling, and no dependency on a window being
 * open.
 *
 * The wire contract is `SessionListEventSchema` in
 * `packages/shared/src/session-stream.ts`: the SSE event name *is* the event's
 * `type`, and `session_status` carries `status.lifecycle`. Only the two fields
 * read below are decoded here rather than importing the schema — pulling the
 * full session contract (and zod-to-openapi with it) into the main-process
 * bundle for one enum is not a trade worth making. The lifecycle union is
 * imported as a **type**, which costs nothing at runtime and turns a renamed
 * lifecycle into a compile error here.
 */

/**
 * Which of the two "still going" lifecycles a session is in, or `null` once it
 * has finished.
 *
 * `streaming` is an agent producing right now. `blocked` is one paused on you —
 * an approval, a question, an elicitation. Neither is a `SessionLifecycle` the
 * quit guard should let you walk away from, so {@link getActiveAgentCount}
 * still counts both together; but they are not the same thing to a person
 * glancing at the tray, so the two are tracked apart and reported apart.
 * `idle`, `error` and `interrupted` are all finished, one way or another, and
 * this returns `null` for all three.
 *
 * @param lifecycle - The lifecycle reported on a `session_status` event.
 */
function activeLifecycleOf(lifecycle: SessionLifecycle): 'streaming' | 'blocked' | null {
  return lifecycle === 'streaming' || lifecycle === 'blocked' ? lifecycle : null;
}

/** First reconnect delay after the stream drops. */
const RECONNECT_BASE_MS = 1_000;

/** Ceiling on the exponential reconnect backoff. */
const RECONNECT_MAX_MS = 15_000;

/** The server's own SSE heartbeat is every 15s; a stream silent for much longer than that is gone. */
const STREAM_IDLE_TIMEOUT_MS = 45_000;

/** Sessions currently mid-run, by id, holding which of the two active lifecycles they're in. */
const sessionLifecycles = new Map<string, 'streaming' | 'blocked'>();

/**
 * How many agents are mid-run right now, streaming and blocked combined.
 * `0` whenever the stream is not connected.
 */
export function getActiveAgentCount(): number {
  return sessionLifecycles.size;
}

/** A running subscription to the server's event stream. */
export interface AgentActivityWatch {
  /** Stop watching and drop the connection. */
  stop(): void;
}

/**
 * How many agents are producing right now, and how many are paused waiting on
 * you. The two numbers a person actually wants from a glance at the tray —
 * "is anything happening" is not the same question as "does anything need me".
 */
export interface AgentActivityCounts {
  /** Agents actively producing output right now. */
  streaming: number;
  /** Agents paused mid-turn on an approval, a question, or an elicitation. */
  blocked: number;
}

/** Options for {@link watchAgentActivity}. */
export interface AgentActivityOptions {
  /** Point-in-time accessor for the server's port; `null` while no server is running. */
  getPort: () => number | null;
  /** Called whenever either count changes, never with the same pair twice in a row. */
  onChange: (counts: AgentActivityCounts) => void;
}

/**
 * Watch the server's global event stream and report how many agents are working.
 *
 * Reconnects on its own, with backoff, for as long as the watch is running: the
 * stream ends whenever the server does, and the server can be restarted onto a
 * **new port** by the crash-recovery dialog, so the port is re-read on every
 * attempt rather than captured.
 *
 * The stream carries lifecycle *transitions* and has no snapshot on connect, so
 * a fresh connection starts from "nothing is running". That is exact in the
 * normal case — this subscribes as the server comes up, before any session can
 * start — and after a reconnect it deliberately under-reports rather than over-
 * reports: a stale count that never clears would nag about agents that finished
 * long ago and block quitting forever.
 *
 * @param options - See {@link AgentActivityOptions}.
 * @returns A handle that stops the watch.
 */
export function watchAgentActivity(options: AgentActivityOptions): AgentActivityWatch {
  const { getPort, onChange } = options;
  let stopped = false;
  let request: ReturnType<typeof http.get> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = RECONNECT_BASE_MS;
  let lastReported: AgentActivityCounts = { streaming: 0, blocked: 0 };
  /** Whether the last connection attempt already logged its failure — one line per outage, not per retry. */
  let outageLogged = false;

  const countsNow = (): AgentActivityCounts => {
    let streaming = 0;
    let blocked = 0;
    for (const lifecycle of sessionLifecycles.values()) {
      if (lifecycle === 'streaming') streaming += 1;
      else blocked += 1;
    }
    return { streaming, blocked };
  };

  const report = (): void => {
    if (stopped) return;
    const counts = countsNow();
    if (counts.streaming === lastReported.streaming && counts.blocked === lastReported.blocked) {
      return;
    }
    lastReported = counts;
    onChange(lastReported);
  };

  const clear = (): void => {
    if (sessionLifecycles.size === 0) return;
    sessionLifecycles.clear();
    report();
  };

  const scheduleReconnect = (): void => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryDelayMs);
    // Never let the retry timer be the reason the process stays alive.
    retryTimer.unref();
    retryDelayMs = Math.min(retryDelayMs * 2, RECONNECT_MAX_MS);
  };

  const dropConnection = (): void => {
    request?.destroy();
    request = null;
    clear();
  };

  const connect = (): void => {
    if (stopped || request) return;
    const port = getPort();
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
        log.warn('[activity] Lost the connection to the server event stream.', err.message);
      }
      dropConnection();
      scheduleReconnect();
    });
  };

  const handleResponse = (response: IncomingMessage): void => {
    if (response.statusCode !== 200) {
      if (!outageLogged) {
        outageLogged = true;
        // The one real case: the person turned sign-in on, so `/api` now wants
        // credentials the shell does not hold. The tray keeps working, it just
        // stops claiming to know what the agents are doing.
        log.warn(
          `[activity] The server event stream answered ${response.statusCode}; ` +
            'agent activity will not be shown in the tray.'
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
      for (const frame of frames) {
        if (applyEvent(frame)) report();
      }
    });
    response.on('end', () => {
      dropConnection();
      scheduleReconnect();
    });
  };

  connect();

  return {
    stop(): void {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      request?.destroy();
      request = null;
      sessionLifecycles.clear();
    },
  };
}

/**
 * Apply one SSE frame to the active-session map.
 *
 * @param frame - One frame's raw text, without its trailing blank line.
 * @returns Whether the map changed.
 */
function applyEvent(frame: string): boolean {
  const { name, data } = parseFrame(frame);
  if (name === 'session_removed') {
    const sessionId = readSessionId(data);
    return sessionId !== null && sessionLifecycles.delete(sessionId);
  }
  if (name !== 'session_status') return false;

  const parsed = parseSessionStatus(data);
  if (!parsed) return false;
  const wasLifecycle = sessionLifecycles.get(parsed.sessionId);
  const nextLifecycle = activeLifecycleOf(parsed.lifecycle);
  if (nextLifecycle === null) {
    if (wasLifecycle === undefined) return false;
    sessionLifecycles.delete(parsed.sessionId);
    return true;
  }
  if (wasLifecycle === nextLifecycle) return false;
  sessionLifecycles.set(parsed.sessionId, nextLifecycle);
  return true;
}

/** Split an SSE frame into its event name and its `data:` payload. */
function parseFrame(frame: string): { name: string; data: string } {
  let name = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  return { name, data: data.join('\n') };
}

/** Parse a JSON payload, or `null` if it isn't an object. */
function parsePayload(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read the `sessionId` off a `session_removed` payload. */
function readSessionId(data: string): string | null {
  const payload = parsePayload(data);
  return typeof payload?.sessionId === 'string' ? payload.sessionId : null;
}

/** Read the two fields a `session_status` event contributes: which session, and what it is doing. */
function parseSessionStatus(
  data: string
): { sessionId: string; lifecycle: SessionLifecycle } | null {
  const payload = parsePayload(data);
  if (typeof payload?.sessionId !== 'string') return null;
  const status = payload.status;
  if (typeof status !== 'object' || status === null) return null;
  const lifecycle = (status as { lifecycle?: unknown }).lifecycle;
  if (typeof lifecycle !== 'string') return null;
  return { sessionId: payload.sessionId, lifecycle: lifecycle as SessionLifecycle };
}
