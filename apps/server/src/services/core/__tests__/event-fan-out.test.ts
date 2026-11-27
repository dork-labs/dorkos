import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../config/constants.js', () => ({
  SSE: { MAX_TOTAL_CLIENTS: 3, MAX_BUFFERED_BYTES: 1024 },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

/**
 * Counts every call to the real encoder, so "encoded once per broadcast" is a
 * measured claim rather than an inferred one. It calls through, so the exact
 * wire strings the other cases assert are unchanged.
 */
const { encodeSpy } = vi.hoisted(() => ({ encodeSpy: vi.fn() }));

vi.mock('../../../lib/event-stream/global-event-frames.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../lib/event-stream/global-event-frames.js')>();
  return {
    ...actual,
    encodeBroadcast: (...args: Parameters<typeof actual.encodeBroadcast>) => {
      encodeSpy(...args);
      return actual.encodeBroadcast(...args);
    },
  };
});

import { eventFanOut, type EncodedBroadcast, type FanOutClient } from '../event-fan-out.js';
import type { CallerPrincipal, PersonPrincipal } from '../../../lib/caller-principal.js';
import { logger } from '../../../lib/logger.js';

/** A recording {@link FanOutClient} — what a connected socket looks like here. */
interface MockClient extends FanOutClient {
  send: ReturnType<typeof vi.fn<(broadcast: EncodedBroadcast) => void>>;
  drop: ReturnType<typeof vi.fn<() => void>>;
}

/** Create a mock fan-out client, defaulting to a healthy connected one. */
function createMockClient(overrides: Partial<FanOutClient> = {}): MockClient {
  return {
    send: vi.fn(),
    bufferedBytes: 0,
    gone: false,
    drop: vi.fn(),
    ...overrides,
  } as MockClient;
}

describe('EventFanOut', () => {
  /** Track unsubscribe functions so we can clean up after each test. */
  let unsubs: (() => void)[];

  beforeEach(() => {
    unsubs = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up all clients added during the test to avoid polluting the singleton
    for (const unsub of unsubs) unsub();
  });

  /**
   * Helper that registers a client and tracks its unsubscribe for cleanup.
   *
   * @param client - The reader to register.
   * @param principal - Who is on the other end; the cockpit's `operator` unless
   *   a case is about telling connections apart.
   */
  function addTrackedClient(
    client: FanOutClient,
    principal: PersonPrincipal = { kind: 'operator' }
  ): () => void {
    const unsub = eventFanOut.addClient(client, principal);
    unsubs.push(unsub);
    return unsub;
  }

  it('addClient registers a client and broadcast sends it one encoded frame', () => {
    const client = createMockClient();
    addTrackedClient(client);

    expect(eventFanOut.clientCount).toBe(1);

    eventFanOut.broadcast('tasks_changed', { id: '123' });

    // Numbered for replay: the same frame id on both wires, and one whole
    // envelope on each, its `seq` the id's last part (DOR-5474).
    const sent = client.send.mock.calls[0]![0];
    const [, id, seq] = /^id: (events-\d+-g\d+-(\d+))\n/.exec(sent.sse) ?? [];
    expect(id).toBeDefined();
    const at = (JSON.parse(sent.json) as { at: string }).at;
    expect(new Date(at).toISOString()).toBe(at);
    const envelope = `{"seq":${seq},"at":"${at}","type":"tasks_changed","payload":{"id":"123"}}`;
    expect(sent).toEqual({
      event: 'tasks_changed',
      json: `{"seq":${seq},"at":"${at}","type":"tasks_changed","payload":{"id":"123"},"id":"${id}"}`,
      sse: `id: ${id}\nevent: tasks_changed\ndata: ${envelope}\n\n`,
    });
  });

  it('encodes each wire format ONCE and hands every client the same object', () => {
    // The serialize-once property is why the port takes a pre-rendered
    // broadcast; a per-client JSON.stringify would be invisible until it was
    // expensive, and it is paid once per reader on a stream every window opens.
    const socketReader = createMockClient();
    const sseReader = createMockClient();
    addTrackedClient(socketReader);
    addTrackedClient(sseReader);

    eventFanOut.broadcast('tasks_changed', { n: 1 });

    const first = socketReader.send.mock.calls[0]?.[0];
    const second = sseReader.send.mock.calls[0]?.[0];
    expect(first, 'both readers get the identical object, not two encodings').toBe(second);
    expect(first?.json).toMatch(
      /^\{"seq":\d+,"at":"[^"]+","type":"tasks_changed","payload":\{"n":1\},"id":"events-/
    );
    expect(first?.sse).toMatch(
      /^id: events-\d+-g\d+-\d+\nevent: tasks_changed\ndata: \{"seq":\d+,"at":"[^"]+","type":"tasks_changed","payload":\{"n":1\}\}\n\n$/
    );
  });

  it('addClient rejects when MAX_TOTAL_CLIENTS is reached', () => {
    const clients = Array.from({ length: 3 }, () => createMockClient());
    for (const c of clients) addTrackedClient(c);

    expect(eventFanOut.clientCount).toBe(3);
    expect(eventFanOut.hasCapacity()).toBe(false);

    // Fourth client should be rejected
    const rejected = createMockClient();
    const unsub = eventFanOut.addClient(rejected, { kind: 'operator' });
    // No need to track — rejected client was never added

    expect(rejected.drop).toHaveBeenCalled();
    expect(eventFanOut.clientCount).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Max clients reached'));

    // Calling the returned unsub should be a no-op
    unsub();
  });

  it('broadcast removes clients that have gone', () => {
    const alive = createMockClient();
    const dead = createMockClient({ gone: true });

    addTrackedClient(alive);
    addTrackedClient(dead);

    expect(eventFanOut.clientCount).toBe(2);

    eventFanOut.broadcast('tasks_changed', {});

    // Dead client removed during broadcast
    expect(eventFanOut.clientCount).toBe(1);
    expect(alive.send).toHaveBeenCalled();
    expect(dead.send).not.toHaveBeenCalled();
  });

  it('broadcast handles send() throwing by removing the client', () => {
    const good = createMockClient();
    const bad = createMockClient({
      send: vi.fn().mockImplementation(() => {
        throw new Error('socket closed');
      }),
    });

    addTrackedClient(good);
    addTrackedClient(bad);

    expect(eventFanOut.clientCount).toBe(2);

    eventFanOut.broadcast('tasks_changed', { value: 1 });

    expect(eventFanOut.clientCount).toBe(1);
    expect(good.send).toHaveBeenCalled();
  });

  it('keeps a congested client whose buffer is under the byte ceiling', () => {
    // Buffered bytes alone are not a fault; the socket keeps the frame, so a
    // briefly-slow client must NOT be dropped.
    const client = createMockClient({ bufferedBytes: 512 });

    addTrackedClient(client);

    eventFanOut.broadcast('tasks_changed', { chunk: 'large' });

    expect(client.send).toHaveBeenCalled();
    expect(client.drop).not.toHaveBeenCalled();
    expect(eventFanOut.clientCount).toBe(1);
  });

  it('drops a slow client whose buffered bytes exceed the ceiling', () => {
    // Real failure mode: a stalled consumer on a broadcast stream buffers
    // every frame in server memory forever — the fan-out cannot await one
    // client, so the honest recovery is drop + client auto-reconnect.
    const client = createMockClient({ bufferedBytes: 4096 });

    addTrackedClient(client);

    eventFanOut.broadcast('tasks_changed', { chunk: 'large' });

    expect(client.drop).toHaveBeenCalled();
    expect(eventFanOut.clientCount).toBe(0);
  });

  it('clientCount reflects add and remove operations', () => {
    expect(eventFanOut.clientCount).toBe(0);

    const first = createMockClient();
    const second = createMockClient();

    const unsub1 = addTrackedClient(first);
    expect(eventFanOut.clientCount).toBe(1);

    addTrackedClient(second);
    expect(eventFanOut.clientCount).toBe(2);

    unsub1();
    expect(eventFanOut.clientCount).toBe(1);
  });

  describe('addressed broadcasts', () => {
    /** An audience only the person at the app passes. */
    const operatorOnly = (principal: CallerPrincipal) => principal.kind === 'operator';
    const program = (userId: string): PersonPrincipal => ({ kind: 'program', userId });

    it('sends an UNaddressed broadcast to every client, whatever their principal', () => {
      // All but one event on this bus mean "everyone", and that has to keep
      // meaning everyone once the audience parameter exists.
      const cockpit = createMockClient();
      const script = createMockClient();
      addTrackedClient(cockpit, { kind: 'operator' });
      addTrackedClient(script, program('u1'));

      eventFanOut.broadcast('session_status', { id: 's1' });

      expect(cockpit.send).toHaveBeenCalledTimes(1);
      expect(script.send).toHaveBeenCalledTimes(1);
    });

    it('sends an addressed broadcast only to the clients the audience accepts', () => {
      const cockpit = createMockClient();
      const script = createMockClient();
      addTrackedClient(cockpit, { kind: 'operator' });
      addTrackedClient(script, program('u1'));

      eventFanOut.broadcast('config_changed', { sections: ['ui'] }, operatorOnly);

      expect(cockpit.send).toHaveBeenCalledTimes(1);
      expect(script.send, 'this audience admits only the operator').not.toHaveBeenCalled();
      expect(eventFanOut.clientCount, 'a skipped client is still connected').toBe(2);
    });

    it('asks the audience once per person per frame, and again on the next frame', () => {
      // Several windows of one person cost one question; the answer lives for
      // one frame only, so a right that changes is read on the next.
      addTrackedClient(createMockClient(), { kind: 'operator' });
      addTrackedClient(createMockClient(), { kind: 'operator' });
      addTrackedClient(createMockClient(), program('u1'));
      const audience = vi.fn(operatorOnly);
      encodeSpy.mockClear();

      eventFanOut.broadcast('config_changed', { sections: ['ui'] }, audience);
      expect(audience.mock.calls.map(([p]) => p.kind)).toEqual(['operator', 'program']);
      expect(encodeSpy, 'one encode per broadcast, not one per client').toHaveBeenCalledTimes(1);

      eventFanOut.broadcast('config_changed', { sections: ['ui'] }, audience);
      expect(audience).toHaveBeenCalledTimes(4);
    });

    it('asks again for each program user, never sharing one user’s answer with another', () => {
      const first = createMockClient();
      const second = createMockClient();
      addTrackedClient(first, program('u1'));
      addTrackedClient(second, program('u2'));

      eventFanOut.broadcast(
        'config_changed',
        { sections: ['ui'] },
        (p) => p.kind === 'program' && p.userId === 'u2'
      );

      expect(first.send).not.toHaveBeenCalled();
      expect(second.send).toHaveBeenCalledTimes(1);
    });

    it('encodes once even when the audience admits nobody now, for a reader who resumes', () => {
      // A reader who reconnects with a cursor is owed this frame if the
      // audience admits it, so it is rendered once, at broadcast, and kept.
      addTrackedClient(createMockClient(), program('u1'));
      addTrackedClient(createMockClient(), program('u2'));
      encodeSpy.mockClear();

      eventFanOut.broadcast('config_changed', { sections: ['ui'] }, operatorOnly);

      expect(encodeSpy).toHaveBeenCalledTimes(1);
    });

    it('never measures or drops a client the audience skipped', () => {
      // Backpressure is about a client that could not take a frame. A client
      // this frame was never for has taken nothing, so reading its buffer — and
      // dropping it for being full — would evict a healthy reader.
      let bufferedReads = 0;
      const stalled: FanOutClient = {
        send: vi.fn(),
        get bufferedBytes(): number {
          bufferedReads += 1;
          return 4096; // well over the mocked 1024-byte ceiling
        },
        gone: false,
        drop: vi.fn(),
      };
      addTrackedClient(stalled, program('u1'));

      eventFanOut.broadcast('config_changed', { sections: ['ui'] }, operatorOnly);

      expect(stalled.send).not.toHaveBeenCalled();
      expect(bufferedReads, 'a skipped client is not measured').toBe(0);
      expect(stalled.drop).not.toHaveBeenCalled();
      expect(eventFanOut.clientCount).toBe(1);
    });
  });

  describe('in-process listeners', () => {
    it('delivers to a server-side listener with no HTTP client anywhere', () => {
      // The local community adapter reads room lifecycle from here rather than
      // polling the room table for a fact this bus already carries.
      const seen: [string, unknown][] = [];
      const unsub = eventFanOut.subscribe((name, data) => seen.push([name, data]));
      try {
        eventFanOut.broadcast('room_created', { roomId: 'room-1' }, () => false);
        expect(seen).toEqual([['room_created', { roomId: 'room-1' }]]);
      } finally {
        unsub();
      }
      eventFanOut.broadcast('room_created', { roomId: 'room-2' }, () => false);
      expect(seen, 'unsubscribing stops delivery').toHaveLength(1);
    });

    it('logs and skips a listener that throws, rather than failing the write behind it', () => {
      // A room write must never fail because something downstream of it did.
      const seen: string[] = [];
      const unsubs2 = [
        eventFanOut.subscribe(() => {
          throw new Error('listener exploded');
        }),
        eventFanOut.subscribe((name) => seen.push(name)),
      ];
      try {
        expect(() =>
          eventFanOut.broadcast('room_updated', { roomId: 'room-1' }, () => false)
        ).not.toThrow();
        expect(seen, 'the second listener still ran').toEqual(['room_updated']);
        expect(logger.warn).toHaveBeenCalled();
      } finally {
        for (const unsub of unsubs2) unsub();
      }
    });

    it('receives an ADDRESSED broadcast, because an audience governs clients only', () => {
      // A listener is the server itself, not a caller — there is no principal
      // to ask about, so an audience that admits no connected client must still
      // reach it.
      const seen: string[] = [];
      const unsub = eventFanOut.subscribe((name) => seen.push(name));
      addTrackedClient(createMockClient(), { kind: 'program', userId: 'u1' });
      try {
        eventFanOut.broadcast('config_changed', { sections: ['ui'] }, () => false);
        expect(seen).toEqual(['config_changed']);
      } finally {
        unsub();
      }
    });
  });
});
