/**
 * Session stream Transport methods factory — the HTTP implementations of the
 * snapshot + resumable-event-stream contract (spec chat-stream-reconnection).
 *
 * These are the CONTRACT-LEVEL primitives: a single socket per call, no
 * reconnection. Resilience for the app's own path (backoff, silence watchdog,
 * cursor resume, visibility release) lives in {@link StreamManager}/
 * `WSConnection`. These methods exist so the Transport seam is honest and
 * complete — embedded mode (DirectTransport) routes the SAME contract to
 * in-process iteration, and cross-client/integration tests can consume the
 * streams without the manager.
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
import { streamSocketFrames } from './stream-socket-iterator';

/**
 * The {@link SessionListEvent} discriminants. The unified `/events` stream also
 * carries other event families (sync updates, relay messages, heartbeats); only
 * these are part of the session-list contract.
 *
 * The single source of truth: `stream-manager.ts` imports this rather than
 * declaring its own copy (DOR-576 — the two used to drift independently). A
 * name missing here is a frame dropped in silence on both the HTTP-path
 * consumer here and the managed-path consumer in `stream-manager.ts`, so this
 * set is pinned against `SessionListEventSchema` by tests (DOR-548) and
 * exported for the reverse half of that pin: proving no name here has
 * outlived its discriminant needs the set itself, not a guess at which stale
 * names to probe for.
 */
export const SESSION_LIST_EVENT_TYPES = new Set([
  'session_upserted',
  'session_removed',
  'session_status',
]);

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
     * stream just long enough to capture that frame, then closes it.
     *
     * App code should not call this: the StreamManager's cold connect already
     * delivers the snapshot as the leading frame of the durable stream itself.
     * It exists for the embedded pump (in-process, no sockets) and for tests.
     */
    async getSessionSnapshot(sessionId: string, cwd?: string): Promise<SessionSnapshot> {
      const qs = buildQueryString({ cwd });
      const controller = new AbortController();
      try {
        for await (const frame of streamSocketFrames(
          `${baseUrl}/sessions/${sessionId}/events${qs}`,
          { signal: controller.signal }
        )) {
          // The server emits the snapshot as the FIRST frame on a cold connect;
          // any other leading frame is a protocol violation.
          if (frame.event !== 'snapshot') {
            throw new Error(`expected leading snapshot frame, got "${frame.event}"`);
          }
          return SessionSnapshotSchema.parse(frame.data);
        }
        throw new Error('stream ended before a snapshot frame arrived');
      } finally {
        controller.abort();
      }
    },

    /**
     * Subscribe to a session's resumable event stream
     * (`GET /sessions/:id/events`, over a WebSocket).
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
      for await (const frame of streamSocketFrames(`${baseUrl}/sessions/${sessionId}/events${qs}`, {
        signal,
      })) {
        if (frame.event === 'snapshot') {
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
    },

    /**
     * Subscribe to the global session-list stream (`GET /events`, over a
     * WebSocket).
     *
     * The unified `/events` fan-out carries other event families too — only the
     * {@link SESSION_LIST_EVENT_TYPES} discriminants are forwarded; everything
     * else is ignored.
     */
    async *subscribeSessionList(): AsyncIterable<SessionListEvent> {
      for await (const frame of streamSocketFrames(`${baseUrl}/events`)) {
        if (!SESSION_LIST_EVENT_TYPES.has(frame.event)) continue;
        const parsed = SessionListEventSchema.safeParse(frame.data);
        if (!parsed.success) {
          console.warn('[Transport] dropping malformed session-list frame', {
            issues: parsed.error.issues,
          });
          continue;
        }
        yield parsed.data;
      }
    },
  };
}
