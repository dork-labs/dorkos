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

vi.mock('@dorkos/shared/stream-socket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dorkos/shared/stream-socket')>();
  return {
    ...actual,
    encodeStreamFrame: (frame: Parameters<typeof actual.encodeStreamFrame>[0]) => {
      encodeSpy(frame);
      return actual.encodeStreamFrame(frame);
    },
  };
});

import { eventFanOut, type EncodedBroadcast, type FanOutClient } from '../event-fan-out.js';
import type { CallerPrincipal } from '../../../lib/caller-principal.js';
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
    principal: CallerPrincipal = { kind: 'operator' }
  ): () => void {
    const unsub = eventFanOut.addClient(client, principal);
    unsubs.push(unsub);
    return unsub;
  }

  it('addClient registers a client and broadcast sends it one encoded frame', () => {
    const client = createMockClient();
    addTrackedClient(client);

    expect(eventFanOut.clientCount).toBe(1);

    eventFanOut.broadcast('session:update', { id: '123' });

    expect(client.send).toHaveBeenCalledWith({
      event: 'session:update',
      json: '{"event":"session:update","data":{"id":"123"}}',
      sse: 'event: session:update\ndata: {"id":"123"}\n\n',
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

    eventFanOut.broadcast('ping', { n: 1 });

    const first = socketReader.send.mock.calls[0]?.[0];
    const second = sseReader.send.mock.calls[0]?.[0];
    expect(first, 'both readers get the identical object, not two encodings').toBe(second);
    expect(first?.json).toBe('{"event":"ping","data":{"n":1}}');
    expect(first?.sse).toBe('event: ping\ndata: {"n":1}\n\n');
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

    eventFanOut.broadcast('ping', {});

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

    eventFanOut.broadcast('test', { value: 1 });

    expect(eventFanOut.clientCount).toBe(1);
    expect(good.send).toHaveBeenCalled();
  });

  it('keeps a congested client whose buffer is under the byte ceiling', () => {
    // Buffered bytes alone are not a fault; the socket keeps the frame, so a
    // briefly-slow client must NOT be dropped.
    const client = createMockClient({ bufferedBytes: 512 });

    addTrackedClient(client);

    eventFanOut.broadcast('data', { chunk: 'large' });

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

    eventFanOut.broadcast('data', { chunk: 'large' });

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
    /** Only the cockpit's connection may hold an Ask's detail. */
    const operatorOnly = (principal: CallerPrincipal) => principal.kind === 'operator';

    it('sends an UNaddressed broadcast to every client, whatever their principal', () => {
      // All but one event on this bus mean "everyone", and that has to keep
      // meaning everyone once the audience parameter exists.
      const cockpit = createMockClient();
      const agent = createMockClient();
      addTrackedClient(cockpit, { kind: 'operator' });
      addTrackedClient(agent, { kind: 'agent' });

      eventFanOut.broadcast('session_status', { id: 's1' });

      expect(cockpit.send).toHaveBeenCalledTimes(1);
      expect(agent.send).toHaveBeenCalledTimes(1);
    });

    it('sends an addressed broadcast only to the clients the audience accepts', () => {
      const cockpit = createMockClient();
      const agent = createMockClient();
      const program = createMockClient();
      addTrackedClient(cockpit, { kind: 'operator' });
      addTrackedClient(agent, { kind: 'agent' });
      addTrackedClient(program, { kind: 'program', userId: 'user_owner' });

      eventFanOut.broadcast('interaction_pending', { sessionId: 's1' }, operatorOnly);

      expect(cockpit.send).toHaveBeenCalledTimes(1);
      expect(agent.send, 'an agent never receives an Ask detail').not.toHaveBeenCalled();
      expect(program.send, 'this audience admits only the operator').not.toHaveBeenCalled();
      expect(eventFanOut.clientCount, 'a skipped client is still connected').toBe(3);
    });

    it('asks the audience once per client and encodes the frame once regardless', () => {
      const cockpit = createMockClient();
      const agent = createMockClient();
      addTrackedClient(cockpit, { kind: 'operator' });
      addTrackedClient(agent, { kind: 'agent' });
      const audience = vi.fn(operatorOnly);
      encodeSpy.mockClear();

      eventFanOut.broadcast('interaction_pending', { sessionId: 's1' }, audience);

      expect(audience).toHaveBeenCalledTimes(2);
      expect(audience.mock.calls.map(([p]) => p.kind)).toEqual(['operator', 'agent']);
      expect(encodeSpy, 'one encode per broadcast, not one per client').toHaveBeenCalledTimes(1);
    });

    it('does not encode at all when the audience admits nobody', () => {
      // A frame with no readers costs nothing to render, and that is what makes
      // the two-rendering path below affordable: the redacted variant is never
      // built on the ordinary install where only the cockpit is connected.
      addTrackedClient(createMockClient(), { kind: 'agent' });
      addTrackedClient(createMockClient(), { kind: 'agent' });
      encodeSpy.mockClear();

      eventFanOut.broadcast('interaction_pending', { sessionId: 's1' }, operatorOnly);

      expect(encodeSpy).not.toHaveBeenCalled();
    });

    it('never measures or drops a client the audience skipped', () => {
      // Backpressure is about a client that could not take a frame. A client
      // this frame was never for has taken nothing, so reading its buffer — and
      // dropping it for being full — would evict a healthy reader.
      let bufferedReads = 0;
      const stalledAgent: FanOutClient = {
        send: vi.fn(),
        get bufferedBytes(): number {
          bufferedReads += 1;
          return 4096; // well over the mocked 1024-byte ceiling
        },
        gone: false,
        drop: vi.fn(),
      };
      addTrackedClient(stalledAgent, { kind: 'agent' });

      eventFanOut.broadcast('interaction_pending', { sessionId: 's1' }, operatorOnly);

      expect(stalledAgent.send).not.toHaveBeenCalled();
      expect(bufferedReads, 'a skipped client is not measured').toBe(0);
      expect(stalledAgent.drop).not.toHaveBeenCalled();
      expect(eventFanOut.clientCount).toBe(1);
    });
  });

  describe('broadcastRedacted — one event, two renderings', () => {
    /** Only the cockpit's connection may hold a blocked session's detail. */
    const operatorOnly = (principal: CallerPrincipal) => principal.kind === 'operator';

    /** Every payload a client was written, decoded back off its JSON frame. */
    function payloads(client: MockClient): unknown[] {
      return client.send.mock.calls.map(
        ([broadcast]) => (JSON.parse(broadcast.json) as { data: unknown }).data
      );
    }

    it('writes the full payload to the entitled and the redacted one to everybody else', () => {
      const cockpit = createMockClient();
      const agent = createMockClient();
      addTrackedClient(cockpit, { kind: 'operator' });
      addTrackedClient(agent, { kind: 'agent' });

      eventFanOut.broadcastRedacted(
        'session_status',
        { sessionId: 's1', activity: { toolName: 'Bash', target: 'rm -rf build' } },
        { sessionId: 's1' },
        operatorOnly
      );

      expect(payloads(cockpit)).toEqual([
        { sessionId: 's1', activity: { toolName: 'Bash', target: 'rm -rf build' } },
      ]);
      expect(payloads(agent), 'an agent gets the frame without the detail').toEqual([
        { sessionId: 's1' },
      ]);
    });

    it('writes each connection exactly one of the two renderings, never both', () => {
      const cockpit = createMockClient();
      const agent = createMockClient();
      addTrackedClient(cockpit, { kind: 'operator' });
      addTrackedClient(agent, { kind: 'agent' });

      eventFanOut.broadcastRedacted('session_status', { a: 1 }, { b: 2 }, operatorOnly);

      expect(cockpit.send).toHaveBeenCalledTimes(1);
      expect(agent.send).toHaveBeenCalledTimes(1);
    });

    it('notifies an in-process listener ONCE, with the full payload', () => {
      // A listener is the server itself. Twice would be a new bug, and a
      // redacted one would be a lie to code that is not a caller.
      const seen: unknown[] = [];
      const unsub = eventFanOut.subscribe((_name, data) => seen.push(data));
      addTrackedClient(createMockClient(), { kind: 'agent' });
      try {
        eventFanOut.broadcastRedacted(
          'session_status',
          { full: true },
          { full: false },
          operatorOnly
        );
        expect(seen).toEqual([{ full: true }]);
      } finally {
        unsub();
      }
    });

    it('renders each variant once, and skips the one nobody is going to read', () => {
      const cockpit = createMockClient();
      addTrackedClient(cockpit, { kind: 'operator' });
      addTrackedClient(createMockClient(), { kind: 'operator' });
      encodeSpy.mockClear();

      eventFanOut.broadcastRedacted('session_status', { a: 1 }, { b: 2 }, operatorOnly);

      expect(
        encodeSpy,
        'two entitled clients, one full frame, no redacted one'
      ).toHaveBeenCalledTimes(1);
    });

    it('renders both when both kinds of reader are connected', () => {
      addTrackedClient(createMockClient(), { kind: 'operator' });
      addTrackedClient(createMockClient(), { kind: 'agent' });
      encodeSpy.mockClear();

      eventFanOut.broadcastRedacted('session_status', { a: 1 }, { b: 2 }, operatorOnly);

      expect(encodeSpy).toHaveBeenCalledTimes(2);
    });

    it('drops a slow client on the frame it actually received', () => {
      const slowAgent = createMockClient({ bufferedBytes: 4096 });
      addTrackedClient(slowAgent, { kind: 'agent' });

      eventFanOut.broadcastRedacted('session_status', { a: 1 }, { b: 2 }, operatorOnly);

      expect(slowAgent.send).toHaveBeenCalledTimes(1);
      expect(slowAgent.drop).toHaveBeenCalled();
      expect(eventFanOut.clientCount).toBe(0);
    });
  });

  describe('in-process listeners', () => {
    it('delivers to a server-side listener with no HTTP client anywhere', () => {
      // The local community adapter reads room lifecycle from here rather than
      // polling the room table for a fact this bus already carries.
      const seen: [string, unknown][] = [];
      const unsub = eventFanOut.subscribe((name, data) => seen.push([name, data]));
      try {
        eventFanOut.broadcast('room_created', { roomId: 'room-1' });
        expect(seen).toEqual([['room_created', { roomId: 'room-1' }]]);
      } finally {
        unsub();
      }
      eventFanOut.broadcast('room_created', { roomId: 'room-2' });
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
        expect(() => eventFanOut.broadcast('room_updated', { roomId: 'room-1' })).not.toThrow();
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
      addTrackedClient(createMockClient(), { kind: 'agent' });
      try {
        eventFanOut.broadcast('interaction_pending', { sessionId: 's1' }, () => false);
        expect(seen).toEqual(['interaction_pending']);
      } finally {
        unsub();
      }
    });
  });
});
