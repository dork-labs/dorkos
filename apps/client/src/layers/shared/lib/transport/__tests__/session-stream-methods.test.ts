import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SessionListEventSchema,
  StaleResumeCursorError,
  type SessionEvent,
  type SessionSnapshot,
  type SessionStatus,
  type SessionListEvent,
} from '@dorkos/shared/session-stream';

import { createSessionStreamMethods, SESSION_LIST_EVENT_TYPES } from '../session-stream-methods';
import { FakeStreamSocket, installFakeStreamSocket, nthSocket } from './fake-stream-socket';

const STATUS: SessionStatus = {
  contextUsage: null,
  cost: null,
  usage: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle',
  lastError: null,
};

const SNAPSHOT: SessionSnapshot = {
  messages: [],
  inProgressTurn: null,
  status: STATUS,
  pendingInteractions: [],
  queuedMessages: [],
  cursor: 7,
};

const TURN_START: SessionEvent = { type: 'turn_start', seq: 8 };
const LIST_EVENT: SessionListEvent = { type: 'session_removed', sessionId: 'sess-x' };

/** One frame the server would send, for {@link script}. */
type Frame = [event: string, data?: unknown];

/**
 * Run `consume` against a stream the server drives with `frames`, then ends.
 *
 * The consumer starts first and parks on the socket; the script runs once the
 * socket exists. That is the real ordering — a subscriber is listening before
 * the server writes — and it is what makes these tests independent of how many
 * microtasks the iterator happens to take.
 *
 * @param frames - What the server sends before closing.
 * @param consume - The iteration under test.
 */
async function script<T>(frames: Frame[], consume: () => Promise<T>): Promise<T> {
  const running = consume();
  const socket = await nthSocket();
  for (const [event, data] of frames) socket.push(event, data);
  socket.finish();
  return running;
}

/**
 * The `type` discriminants `SessionListEventSchema` declares, read off the schema.
 *
 * Zod v4 discriminated unions expose their members via `.options`, each a ZodObject
 * whose `type` shape is a ZodLiteral carrying the discriminant in `.value`. Read
 * rather than hardcoded so a fourth member cannot ship past the pins below.
 */
function listDiscriminants(): string[] {
  return SessionListEventSchema.options.map(
    (option) => (option.shape.type as { value: string }).value
  );
}

/**
 * A schema-valid payload per discriminant, keyed by name.
 *
 * Kept as a lookup rather than an array so the pins can assert the sample set is
 * exactly the discriminant set — a new member with no sample fails by NAME
 * instead of quietly narrowing what gets exercised.
 */
function listEventSamples(): Record<string, SessionListEvent> {
  return {
    session_upserted: {
      type: 'session_upserted',
      session: {
        id: '00000000-0000-4000-8000-00000000dead',
        title: 'Drift pin',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        permissionMode: 'default',
        runtime: 'claude-code',
      },
    },
    session_removed: { type: 'session_removed', sessionId: 'sess-x' },
    session_status: { type: 'session_status', sessionId: 'sess-x', status: STATUS },
  };
}

describe('createSessionStreamMethods', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installFakeStreamSocket();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  /** The URL of the Nth socket opened, with the ws: scheme stripped for clarity. */
  const openedPath = (index = 0): string =>
    FakeStreamSocket.instances[index]!.url.replace(/^ws:\/\/[^/]+/, '');

  describe('getSessionSnapshot', () => {
    it('captures the leading snapshot frame from a cold /events connect', async () => {
      // Real failure mode: hydration callers get nothing without this — there
      // is no REST snapshot endpoint; the leading frame IS the snapshot.
      const methods = createSessionStreamMethods('/api');

      const snapshot = await script([['snapshot', SNAPSHOT]], () =>
        methods.getSessionSnapshot('sess-a', '/proj')
      );

      expect(snapshot).toEqual(SNAPSHOT);
      expect(openedPath()).toBe('/api/sessions/sess-a/events?cwd=%2Fproj');
    });

    it('throws when the leading frame is not a snapshot (protocol violation)', async () => {
      const methods = createSessionStreamMethods('/api');

      await expect(
        script([['turn_start', TURN_START]], () => methods.getSessionSnapshot('sess-a'))
      ).rejects.toThrow(/expected leading snapshot frame/);
    });

    it('throws when the stream ends before a snapshot arrives', async () => {
      const methods = createSessionStreamMethods('/api');

      await expect(script([], () => methods.getSessionSnapshot('sess-a'))).rejects.toThrow(
        /ended before a snapshot/
      );
    });
  });

  describe('subscribeSession', () => {
    it('yields validated events, skipping the snapshot frame', async () => {
      // Real failure mode: a cold connect leads with a snapshot frame — leaking
      // it into the event iteration would corrupt seq-based consumers.
      const methods = createSessionStreamMethods('/api');

      const events: SessionEvent[] = [];
      await script(
        [
          ['snapshot', SNAPSHOT],
          ['turn_start', TURN_START],
        ],
        async () => {
          for await (const event of methods.subscribeSession('sess-a')) events.push(event);
        }
      );

      expect(events).toEqual([TURN_START]);
    });

    it('passes the resume cursor as ?after= alongside cwd', async () => {
      const methods = createSessionStreamMethods('/api');

      await script([], async () => {
        for await (const _ of methods.subscribeSession('sess-a', 42, '/proj')) void _;
      });

      expect(openedPath()).toBe('/api/sessions/sess-a/events?cwd=%2Fproj&after=42');
    });

    it('throws StaleResumeCursorError when a resume connect falls back to a cold snapshot', async () => {
      // Real failure mode (review finding): the server emits a snapshot on a
      // RESUME connect only when the cursor is unservable — silently skipping
      // it would hide every event between the stale cursor and the fallback.
      const methods = createSessionStreamMethods('/api');

      await expect(
        script([['snapshot', SNAPSHOT]], async () => {
          for await (const _ of methods.subscribeSession('sess-a', 42)) void _;
        })
      ).rejects.toThrow(StaleResumeCursorError);
    });

    it('closes the socket when the consumer aborts', async () => {
      // Real failure mode: a consumer aborting its signal must close the socket,
      // or the connection (and its server-side subscription) leaks.
      const methods = createSessionStreamMethods('/api');
      const external = new AbortController();

      const iterator = methods
        .subscribeSession('sess-a', undefined, undefined, external.signal)
        [Symbol.asyncIterator]();
      void iterator.next(); // opens the socket; parks on it
      const socket = await nthSocket();

      expect(socket.readyState).not.toBe(3);
      external.abort();
      await vi.waitFor(() => expect(socket.readyState).toBe(3));
    });

    it('drops a malformed frame with a warning instead of corrupting the stream', async () => {
      const methods = createSessionStreamMethods('/api');

      const events: SessionEvent[] = [];
      await script(
        [
          ['text_delta', { bogus: true }],
          ['turn_start', TURN_START],
        ],
        async () => {
          for await (const event of methods.subscribeSession('sess-a')) events.push(event);
        }
      );

      expect(events).toEqual([TURN_START]);
      expect(warnSpy).toHaveBeenCalledWith(
        '[Transport] dropping malformed session-event frame',
        expect.anything()
      );
    });
  });

  describe('subscribeSessionList', () => {
    it('does not leak other event families from the unified stream', async () => {
      // Real failure mode: /events is the unified fan-out — sync updates and
      // relay frames must not leak into the session-list contract.
      const methods = createSessionStreamMethods('/api');

      const events: SessionListEvent[] = [];
      await script(
        [
          ['sync_update', { anything: 1 }],
          ['session_removed', LIST_EVENT],
        ],
        async () => {
          for await (const event of methods.subscribeSessionList()) events.push(event);
        }
      );

      expect(events).toEqual([LIST_EVENT]);
      expect(openedPath()).toBe('/api/events');
    });

    it('forwards EVERY SessionListEventSchema discriminant (schema-drift pin)', async () => {
      // Real failure mode: `SESSION_LIST_EVENT_TYPES`, declared here and imported
      // by `stream-manager.ts` (DOR-576, single source of truth) — a `Set`,
      // consulted at `subscribeSessionList`'s `frame.type` check. A discriminant
      // missing from it is `continue`d before validation: dropped in silence,
      // exactly like the StreamManager consumer that shares this same set. This
      // path is not wired into the live HTTP flow today (only DirectTransport
      // reaches it), but it is an exported implementation of the Transport
      // contract and one rewiring away from being as live as the other.
      //
      // The previous version of this test hardcoded "the 3 session-list event
      // types" and passed exactly one frame, so it would have gone on passing the
      // day a 4th discriminant shipped unlisted. Driving the schema instead is the
      // whole point.
      const samples = listEventSamples();
      const discriminants = listDiscriminants();

      // Forward, part one: a sample exists for every discriminant, so a new one
      // fails HERE with a name rather than silently narrowing the sweep below.
      expect(Object.keys(samples).sort()).toEqual([...discriminants].sort());

      const methods = createSessionStreamMethods('/api');

      const events: SessionListEvent[] = [];
      await script(
        discriminants.map((type): Frame => [type, samples[type]]),
        async () => {
          for await (const event of methods.subscribeSessionList()) events.push(event);
        }
      );

      // Forward, part two: every discriminant survived the allowlist check.
      expect(
        events.map((event) => event.type).sort(),
        'a discriminant the schema declares never reached the consumer — ' +
          'SESSION_LIST_EVENT_TYPES in session-stream-methods.ts dropped it silently'
      ).toEqual([...discriminants].sort());
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('the allowlist names nothing SessionListEventSchema does not declare', async () => {
      // Reverse direction. A forward-only scan is half a guard: a name that
      // outlived its discriminant keeps forwarding frames the server can no longer
      // send, which reads as coverage and is not.
      //

      // Read against the SET, not against probe frames. A first draft pushed a
      // handful of plausible stale names (`session_renamed`, `session_upsert`) and
      // asked which got through — and stayed green when a real orphan was seeded,
      // because the orphan was not one of the names guessed at. There is no finite
      // probe list for "any string somebody might leave behind", which is why the
      // allowlist is exported: the only honest reverse check compares the set.
      const discriminants = listDiscriminants();
      expect(
        [...SESSION_LIST_EVENT_TYPES].sort(),
        'SESSION_LIST_EVENT_TYPES names something SessionListEventSchema does not declare. ' +
          'The Set is the gate; a name that outlived its discriminant admits frames the ' +
          'server can no longer send, and the parse below it then warns on every one.'
      ).toEqual([...discriminants].sort());

      // And the exported set is the one the code path actually consults — an
      // exported copy nothing reads would pin nothing. A frame named by the set is
      // forwarded; a frame not named by it is dropped in silence.
      const samples = listEventSamples();
      const methods = createSessionStreamMethods('/api');

      const events: SessionListEvent[] = [];
      await script(
        [
          ['session_removed', samples['session_removed']],
          ['not_in_the_set', { type: 'session_removed', sessionId: 'sess-y' }],
        ],
        async () => {
          for await (const event of methods.subscribeSessionList()) events.push(event);
        }
      );

      expect(events).toEqual([samples['session_removed']]);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
