import { describe, it, expect, vi } from 'vitest';

import {
  TransportSessionStreamPump,
  TransportListStreamPump,
  type TransportStreams,
} from '../transport-stream-pump';

/**
 * The embedded-mode pumps feed the SAME handler maps `WSConnection` feeds, from
 * the Transport seam instead of a socket. The event name is still data, and the
 * map is still a plain object, so they dispatch by the same rule — an own,
 * callable handler or nothing.
 */

/** A Transport stand-in that yields the given session events, then ends. */
function transportYielding(events: Array<{ type: string }>): TransportStreams {
  return {
    getSessionSnapshot: vi.fn().mockResolvedValue({ cursor: 'c0', messages: [] }),
    subscribeSession: async function* () {
      for (const event of events) yield event;
    },
    subscribeSessionList: async function* () {
      for (const event of events) yield event;
    },
  } as unknown as TransportStreams;
}

/** Let the pump's async loop drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('TransportSessionStreamPump', () => {
  it('dispatches an event to its own registered handler', async () => {
    const onDelta = vi.fn();
    const pump = new TransportSessionStreamPump({
      transport: transportYielding([{ type: 'text_delta' }]),
      sessionId: 'abc',
      cwd: null,
      eventHandlers: { text_delta: onDelta },
    });

    pump.connect();
    await settle();

    expect(onDelta).toHaveBeenCalledWith({ type: 'text_delta' });
    pump.destroy();
  });

  it('never calls anything the handler map merely inherits', async () => {
    const inherited = vi.fn();
    const handlers = Object.create({ text_delta: inherited }) as Record<
      string,
      (data: unknown) => void
    >;
    const pump = new TransportSessionStreamPump({
      transport: transportYielding([{ type: 'text_delta' }]),
      sessionId: 'abc',
      cwd: null,
      eventHandlers: handlers,
    });

    pump.connect();
    await settle();

    expect(inherited).not.toHaveBeenCalled();
    pump.destroy();
  });

  it('keeps reading after an event named for a built-in member of the map', async () => {
    // `handlers['__proto__']` is Object.prototype, which is not callable: an
    // unguarded dispatch throws, the throw leaves the read loop, and every
    // event after it is lost. The stream still reports `disconnected` on the
    // way out, so the honest signal is the NEXT event arriving.
    const onDelta = vi.fn();
    const pump = new TransportSessionStreamPump({
      transport: transportYielding([{ type: '__proto__' }, { type: 'text_delta' }]),
      sessionId: 'abc',
      cwd: null,
      eventHandlers: { text_delta: onDelta },
    });

    pump.connect();
    await settle();

    expect(onDelta).toHaveBeenCalledWith({ type: 'text_delta' });
    pump.destroy();
  });
});

describe('TransportListStreamPump', () => {
  it('never calls anything the handler map merely inherits', async () => {
    const inherited = vi.fn();
    const handlers = Object.create({ session_updated: inherited }) as Record<
      string,
      (data: unknown) => void
    >;
    const pump = new TransportListStreamPump({
      transport: transportYielding([{ type: 'session_updated' }]),
      eventHandlers: handlers,
    });

    pump.connect();
    await settle();

    expect(inherited).not.toHaveBeenCalled();
    pump.destroy();
  });

  it('dispatches an event to its own registered handler', async () => {
    const onUpdate = vi.fn();
    const pump = new TransportListStreamPump({
      transport: transportYielding([{ type: 'session_updated' }]),
      eventHandlers: { session_updated: onUpdate },
    });

    pump.connect();
    await settle();

    expect(onUpdate).toHaveBeenCalledWith({ type: 'session_updated' });
    pump.destroy();
  });
});
