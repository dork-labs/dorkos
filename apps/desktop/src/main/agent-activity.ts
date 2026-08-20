import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import {
  parseEventPayload,
  subscribeEventStream,
  type GetServerPort,
  type ServerEventFrame,
} from './event-stream';

/**
 * How many of your agents are mid-run, right now — and which of them are
 * producing versus waiting on you.
 *
 * The shell needs this in two places a renderer cannot help with: the tray has
 * to say something true while the window is closed, and the quit guard has to
 * know whether quitting would cut anything off. So this reads the server's own
 * global event stream (`GET /api/events`) — the same one the cockpit uses —
 * through the shared connection in `event-stream.ts` (which
 * `notifications/index.ts` also reads), no polling and no dependency on a
 * window being open.
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
  getPort: GetServerPort;
  /** Called whenever either count changes, never with the same pair twice in a row. */
  onChange: (counts: AgentActivityCounts) => void;
}

function countsNow(): AgentActivityCounts {
  let streaming = 0;
  let blocked = 0;
  for (const lifecycle of sessionLifecycles.values()) {
    if (lifecycle === 'streaming') streaming += 1;
    else blocked += 1;
  }
  return { streaming, blocked };
}

/**
 * Watch the server's global event stream and report how many agents are working.
 *
 * The underlying connection (`event-stream.ts`) reconnects on its own, with
 * backoff, for as long as anything is subscribed to it: the stream ends
 * whenever the server does, and the server can be restarted onto a **new
 * port** by the crash-recovery dialog, so the port is re-read on every attempt
 * rather than captured.
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
  let lastReported: AgentActivityCounts = { streaming: 0, blocked: 0 };

  const report = (): void => {
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

  const subscription = subscribeEventStream(
    { getPort },
    {
      onFrame: (frame) => {
        if (applyEvent(frame)) report();
      },
      onConnectionLost: clear,
    }
  );

  return {
    stop(): void {
      subscription.unsubscribe();
      sessionLifecycles.clear();
    },
  };
}

/**
 * Apply one parsed frame to the active-session map.
 *
 * @param frame - The event name and JSON payload, as `event-stream.ts` parsed it.
 * @returns Whether the map changed.
 */
function applyEvent(frame: ServerEventFrame): boolean {
  const { name, data } = frame;
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

/** Read the `sessionId` off a `session_removed` payload. */
function readSessionId(data: string): string | null {
  const payload = parseEventPayload(data);
  return typeof payload?.sessionId === 'string' ? payload.sessionId : null;
}

/** Read the two fields a `session_status` event contributes: which session, and what it is doing. */
function parseSessionStatus(
  data: string
): { sessionId: string; lifecycle: SessionLifecycle } | null {
  const payload = parseEventPayload(data);
  if (typeof payload?.sessionId !== 'string') return null;
  const status = payload.status;
  if (typeof status !== 'object' || status === null) return null;
  const lifecycle = (status as { lifecycle?: unknown }).lifecycle;
  if (typeof lifecycle !== 'string') return null;
  return { sessionId: payload.sessionId, lifecycle: lifecycle as SessionLifecycle };
}
