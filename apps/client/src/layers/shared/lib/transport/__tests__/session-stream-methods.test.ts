import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StaleResumeCursorError,
  type SessionEvent,
  type SessionSnapshot,
  type SessionStatus,
  type SessionListEvent,
} from '@dorkos/shared/session-stream';

import { createSessionStreamMethods } from '../session-stream-methods';

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
  cursor: 7,
};

const TURN_START: SessionEvent = { type: 'turn_start', seq: 8 };
const LIST_EVENT: SessionListEvent = { type: 'session_removed', sessionId: 'sess-x' };

/** Encode SSE frames into a Response whose body streams them then ends. */
function sseResponse(frames: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** One SSE frame: `event: <type>` + JSON data + blank-line dispatch. */
function frame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('createSessionStreamMethods', () => {
  const fetchMock = vi.fn();
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    warnSpy.mockRestore();
  });

  describe('getSessionSnapshot', () => {
    it('captures the leading snapshot frame from a cold /events connect', async () => {
      // Real failure mode: hydration callers get nothing without this — there
      // is no REST snapshot endpoint; the SSE leading frame IS the snapshot.
      fetchMock.mockResolvedValue(sseResponse(frame('snapshot', SNAPSHOT)));
      const methods = createSessionStreamMethods('/api');

      const snapshot = await methods.getSessionSnapshot('sess-a', '/proj');

      expect(snapshot).toEqual(SNAPSHOT);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/sessions/sess-a/events?cwd=%2Fproj');
      expect((init as RequestInit).headers).toMatchObject({ Accept: 'text/event-stream' });
    });

    it('skips keepalive comments before the snapshot frame', async () => {
      fetchMock.mockResolvedValue(sseResponse(`: keepalive\n\n${frame('snapshot', SNAPSHOT)}`));
      const methods = createSessionStreamMethods('/api');

      await expect(methods.getSessionSnapshot('sess-a')).resolves.toEqual(SNAPSHOT);
    });

    it('throws when the leading data frame is not a snapshot (protocol violation)', async () => {
      fetchMock.mockResolvedValue(sseResponse(frame('turn_start', TURN_START)));
      const methods = createSessionStreamMethods('/api');

      await expect(methods.getSessionSnapshot('sess-a')).rejects.toThrow(
        /expected leading snapshot frame/
      );
    });

    it('throws on a non-OK response', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 500, statusText: 'boom' }));
      const methods = createSessionStreamMethods('/api');

      await expect(methods.getSessionSnapshot('sess-a')).rejects.toThrow('HTTP 500');
    });
  });

  describe('subscribeSession', () => {
    it('yields validated events, skipping the snapshot frame and comments', async () => {
      // Real failure mode: a cold connect leads with a snapshot frame — leaking
      // it into the event iteration would corrupt seq-based consumers.
      fetchMock.mockResolvedValue(
        sseResponse(
          `${frame('snapshot', SNAPSHOT)}: keepalive\n\n${frame('turn_start', TURN_START)}`
        )
      );
      const methods = createSessionStreamMethods('/api');

      const events: SessionEvent[] = [];
      for await (const event of methods.subscribeSession('sess-a')) events.push(event);

      expect(events).toEqual([TURN_START]);
    });

    it('passes the resume cursor as ?after= alongside cwd', async () => {
      fetchMock.mockResolvedValue(sseResponse(''));
      const methods = createSessionStreamMethods('/api');

      for await (const _ of methods.subscribeSession('sess-a', 42, '/proj')) void _;

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/sessions/sess-a/events?cwd=%2Fproj&after=42');
    });

    it('throws StaleResumeCursorError when a resume connect falls back to a cold snapshot', async () => {
      // Real failure mode (review finding): the server emits a snapshot on a
      // RESUME connect only when the cursor is unservable — silently skipping
      // it would hide every event between the stale cursor and the fallback.
      fetchMock.mockResolvedValue(sseResponse(frame('snapshot', SNAPSHOT)));
      const methods = createSessionStreamMethods('/api');

      const iterate = async () => {
        for await (const _ of methods.subscribeSession('sess-a', 42)) void _;
      };

      await expect(iterate()).rejects.toThrow(StaleResumeCursorError);
    });

    it('chains an external abort signal into the underlying fetch', async () => {
      // Real failure mode: a consumer aborting its signal must cancel the SSE
      // request, or the connection (and its server-side subscription) leaks.
      const parked = new ReadableStream<Uint8Array>({ start() {} });
      fetchMock.mockResolvedValue(
        new Response(parked, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      );
      const methods = createSessionStreamMethods('/api');
      const external = new AbortController();

      const iterator = methods
        .subscribeSession('sess-a', undefined, undefined, external.signal)
        [Symbol.asyncIterator]();
      void iterator.next(); // opens the fetch; parks on the never-ending body
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(init.signal!.aborted).toBe(false);
      external.abort();
      expect(init.signal!.aborted).toBe(true);
    });

    it('drops a malformed frame with a warning instead of corrupting the stream', async () => {
      fetchMock.mockResolvedValue(
        sseResponse(`${frame('text_delta', { bogus: true })}${frame('turn_start', TURN_START)}`)
      );
      const methods = createSessionStreamMethods('/api');

      const events: SessionEvent[] = [];
      for await (const event of methods.subscribeSession('sess-a')) events.push(event);

      expect(events).toEqual([TURN_START]);
      expect(warnSpy).toHaveBeenCalledWith(
        '[Transport] dropping malformed session-event frame',
        expect.anything()
      );
    });
  });

  describe('subscribeSessionList', () => {
    it('forwards only the 3 session-list event types from the unified stream', async () => {
      // Real failure mode: /events is the unified fan-out — sync updates and
      // relay frames must not leak into the session-list contract.
      fetchMock.mockResolvedValue(
        sseResponse(
          `${frame('sync_update', { anything: 1 })}${frame('session_removed', LIST_EVENT)}`
        )
      );
      const methods = createSessionStreamMethods('/api');

      const events: SessionListEvent[] = [];
      for await (const event of methods.subscribeSessionList()) events.push(event);

      expect(events).toEqual([LIST_EVENT]);
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/events');
    });
  });
});
