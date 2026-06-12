import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../config/constants.js', () => ({
  SSE: { MAX_TOTAL_CLIENTS: 3, MAX_BUFFERED_BYTES: 1024 },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

import { eventFanOut } from '../event-fan-out.js';
import { logger } from '../../../lib/logger.js';
import type { Response } from 'express';

/** Create a minimal mock Express Response for SSE testing. */
function createMockResponse(overrides: Partial<Response> = {}): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    write: vi.fn().mockReturnValue(true),
    once: vi.fn(),
    writableEnded: false,
    ...overrides,
  } as unknown as Response;
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
  function addTrackedClient(res: Response): () => void {
    const unsub = eventFanOut.addClient(res);
    unsubs.push(unsub);
    return unsub;
  }

  it('addClient registers a response and broadcast writes to it', () => {
    const res = createMockResponse();
    addTrackedClient(res);

    expect(eventFanOut.clientCount).toBe(1);

    eventFanOut.broadcast('session:update', { id: '123' });

    expect(res.write).toHaveBeenCalledWith('event: session:update\ndata: {"id":"123"}\n\n');
  });

  it('addClient rejects when MAX_TOTAL_CLIENTS is reached', () => {
    const clients = Array.from({ length: 3 }, () => createMockResponse());
    for (const c of clients) addTrackedClient(c);

    expect(eventFanOut.clientCount).toBe(3);

    // Fourth client should be rejected
    const rejected = createMockResponse();
    const unsub = eventFanOut.addClient(rejected);
    // No need to track — rejected client was never added

    expect(rejected.status).toHaveBeenCalledWith(503);
    expect(rejected.json).toHaveBeenCalledWith({ error: 'Too many SSE clients' });
    expect(eventFanOut.clientCount).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Max clients reached'));

    // Calling the returned unsub should be a no-op
    unsub();
  });

  it('broadcast removes clients whose writableEnded is true', () => {
    const alive = createMockResponse();
    const dead = createMockResponse({ writableEnded: true } as Partial<Response>);

    addTrackedClient(alive);
    addTrackedClient(dead);

    expect(eventFanOut.clientCount).toBe(2);

    eventFanOut.broadcast('ping', {});

    // Dead client removed during broadcast
    expect(eventFanOut.clientCount).toBe(1);
    expect(alive.write).toHaveBeenCalled();
    expect(dead.write).not.toHaveBeenCalled();
  });

  it('broadcast handles res.write() throwing by removing client', () => {
    const good = createMockResponse();
    const bad = createMockResponse({
      write: vi.fn().mockImplementation(() => {
        throw new Error('socket closed');
      }),
    } as Partial<Response>);

    addTrackedClient(good);
    addTrackedClient(bad);

    expect(eventFanOut.clientCount).toBe(2);

    eventFanOut.broadcast('test', { value: 1 });

    expect(eventFanOut.clientCount).toBe(1);
    expect(good.write).toHaveBeenCalled();
  });

  it('keeps a congested client whose buffer is under the byte ceiling', () => {
    // write() === false just means the kernel buffer is full; Node keeps the
    // frame in memory, so a briefly-slow client must NOT be dropped.
    const res = createMockResponse({
      write: vi.fn().mockReturnValue(false),
      writableLength: 512,
      destroy: vi.fn(),
    } as Partial<Response>);

    addTrackedClient(res);

    eventFanOut.broadcast('data', { chunk: 'large' });

    expect(res.write).toHaveBeenCalled();
    expect(res.destroy).not.toHaveBeenCalled();
    expect(eventFanOut.clientCount).toBe(1);
  });

  it('destroys a slow client whose buffered bytes exceed the ceiling', () => {
    // Real failure mode: a stalled consumer on a broadcast stream buffers
    // every frame in server memory forever — the fan-out cannot await one
    // client, so the honest recovery is destroy + client auto-reconnect.
    const res = createMockResponse({
      write: vi.fn().mockReturnValue(false),
      writableLength: 4096,
      destroy: vi.fn(),
    } as Partial<Response>);

    addTrackedClient(res);

    eventFanOut.broadcast('data', { chunk: 'large' });

    expect(res.destroy).toHaveBeenCalled();
    expect(eventFanOut.clientCount).toBe(0);
  });

  it('clientCount reflects add and remove operations', () => {
    expect(eventFanOut.clientCount).toBe(0);

    const res1 = createMockResponse();
    const res2 = createMockResponse();

    const unsub1 = addTrackedClient(res1);
    expect(eventFanOut.clientCount).toBe(1);

    addTrackedClient(res2);
    expect(eventFanOut.clientCount).toBe(2);

    unsub1();
    expect(eventFanOut.clientCount).toBe(1);
  });
});
