/**
 * Session stream Transport methods factory — the HTTP implementations of the
 * snapshot + resumable-event-stream contract (spec chat-stream-reconnection).
 *
 * These are the CONTRACT-LEVEL primitives: single-shot `fetch` + SSE parsing
 * with no reconnection. Resilience for the app's HTTP path (backoff, heartbeat
 * watchdog, `Last-Event-ID` resume, visibility optimization) lives in
 * {@link StreamManager}/`SSEConnection`, which speak SSE directly. These
 * methods exist so the Transport seam is honest and complete — embedded mode
 * (DirectTransport) routes the SAME contract to in-process iteration, and
 * cross-client/integration tests can consume the streams without the manager.
 *
 * @module shared/lib/transport/session-stream-methods
 */
import {
  SessionSnapshotSchema,
  SessionEventSchema,
  SessionListEventSchema,
  StaleResumeCursorError,
  type SessionSnapshot,
  type SessionEvent,
  type SessionListEvent,
} from '@dorkos/shared/session-stream';
import { buildQueryString } from './http-client';
import { parseSSEStream } from './sse-parser';

/**
 * The 3 {@link SessionListEvent} discriminants. The unified `/events` stream
 * also carries other event families (sync updates, relay messages, heartbeats);
 * only these are part of the session-list contract.
 */
const SESSION_LIST_EVENT_TYPES = new Set(['session_upserted', 'session_removed', 'session_status']);

/**
 * Open an SSE response for `path`, aborting via a local controller chained to
 * an optional external signal so generator teardown (`finally`) always cancels
 * the underlying connection — a bare reader release would leak the socket.
 */
async function openSSE(
  baseUrl: string,
  path: string,
  externalSignal?: AbortSignal
): Promise<{ response: Response; controller: AbortController }> {
  const controller = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    controller.abort();
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return { response, controller };
}

/**
 * Create the session stream methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (e.g. `/api` or `http://localhost:4242/api`)
 */
export function createSessionStreamMethods(baseUrl: string) {
  return {
    /**
     * Fetch the authoritative session snapshot for hydration.
     *
     * There is no REST snapshot endpoint — the snapshot is the leading frame of
     * a cold `GET /sessions/:id/events` connect (Design B.3). This opens the
     * stream just long enough to capture that frame, then aborts.
     */
    async getSessionSnapshot(sessionId: string, cwd?: string): Promise<SessionSnapshot> {
      const qs = buildQueryString({ cwd });
      const { response, controller } = await openSSE(baseUrl, `/sessions/${sessionId}/events${qs}`);
      try {
        for await (const frame of parseSSEStream(response.body!.getReader())) {
          if (frame.comment) continue;
          // The server emits the snapshot as the FIRST data frame on a cold
          // connect; any other leading frame is a protocol violation.
          if (frame.type !== 'snapshot') {
            throw new Error(`expected leading snapshot frame, got "${frame.type}"`);
          }
          return SessionSnapshotSchema.parse(frame.data);
        }
        throw new Error('stream ended before a snapshot frame arrived');
      } finally {
        controller.abort();
      }
    },

    /**
     * Subscribe to a session's resumable event stream via SSE
     * (`GET /sessions/:id/events`).
     *
     * With `sinceCursor` the server replays only events with `seq` greater than
     * the cursor (`?after=`); without it the connect is cold — the server emits
     * a snapshot frame first (skipped here; use {@link getSessionSnapshot}) and
     * goes live from the snapshot's cursor, so the cold iteration is gap-free.
     * A snapshot frame arriving on a RESUME connect means the server could not
     * serve the cursor gap-free and fell back cold — surfaced as
     * {@link StaleResumeCursorError} (mirroring `AgentRuntime.subscribeSession`,
     * which DirectTransport delegates to) so callers re-hydrate instead of
     * silently missing the events between the stale cursor and the fallback.
     * Malformed frames are dropped with a warning, matching the
     * StreamManager's validation semantics.
     */
    async *subscribeSession(
      sessionId: string,
      sinceCursor?: number,
      cwd?: string,
      signal?: AbortSignal
    ): AsyncIterable<SessionEvent> {
      const qs = buildQueryString({ cwd, after: sinceCursor });
      const { response, controller } = await openSSE(
        baseUrl,
        `/sessions/${sessionId}/events${qs}`,
        signal
      );
      try {
        for await (const frame of parseSSEStream(response.body!.getReader())) {
          if (frame.comment) continue;
          if (frame.type === 'snapshot') {
            if (sinceCursor !== undefined) {
              throw new StaleResumeCursorError(sessionId, sinceCursor);
            }
            continue;
          }
          const parsed = SessionEventSchema.safeParse(frame.data);
          if (!parsed.success) {
            console.warn('[Transport] dropping malformed session-event frame', {
              sessionId,
              issues: parsed.error.issues,
            });
            continue;
          }
          yield parsed.data;
        }
      } finally {
        controller.abort();
      }
    },

    /**
     * Subscribe to the global session-list stream via SSE (`GET /events`).
     *
     * The unified `/events` fan-out carries other event families too — only the
     * 3 session-list discriminants are forwarded; everything else is ignored.
     */
    async *subscribeSessionList(): AsyncIterable<SessionListEvent> {
      const { response, controller } = await openSSE(baseUrl, `/events`);
      try {
        for await (const frame of parseSSEStream(response.body!.getReader())) {
          if (frame.comment || !SESSION_LIST_EVENT_TYPES.has(frame.type)) continue;
          const parsed = SessionListEventSchema.safeParse(frame.data);
          if (!parsed.success) {
            console.warn('[Transport] dropping malformed session-list frame', {
              issues: parsed.error.issues,
            });
            continue;
          }
          yield parsed.data;
        }
      } finally {
        controller.abort();
      }
    },
  };
}
