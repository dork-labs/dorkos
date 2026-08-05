import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../config/constants.js', () => ({
  SSE: { MAX_TOTAL_CLIENTS: 3, MAX_BUFFERED_BYTES: 1024 },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

import { eventFanOut, type EncodedBroadcast, type FanOutClient } from '../event-fan-out.js';
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

  /** Helper that registers a client and tracks its unsubscribe for cleanup. */
  function addTrackedClient(client: FanOutClient): () => void {
    const unsub = eventFanOut.addClient(client);
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
    const unsub = eventFanOut.addClient(rejected);
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
  });
});
