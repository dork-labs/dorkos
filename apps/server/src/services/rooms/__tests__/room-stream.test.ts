import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RoomEntry, RoomEvent } from '@dorkos/shared/room-schemas';
import { RoomBroadcaster } from '../room-stream.js';

/** A committed entry event carrying a given seq. */
function entryEvent(seq: number): RoomEvent {
  const entry: RoomEntry = {
    roomId: 'room-1',
    seq,
    id: `e-${seq}`,
    authorId: 'author-1',
    kind: 'post',
    body: { text: `#${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: `e-${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T12:00:00.000Z',
  };
  return { type: 'entry', seq, entry };
}

/** Pull `count` events off an iterable, or reject if it ends early. */
async function take(source: AsyncIterable<RoomEvent>, count: number): Promise<RoomEvent[]> {
  const taken: RoomEvent[] = [];
  for await (const event of source) {
    taken.push(event);
    if (taken.length === count) break;
  }
  return taken;
}

describe('RoomBroadcaster', () => {
  const controllers: AbortController[] = [];

  afterEach(() => {
    for (const controller of controllers) controller.abort();
    controllers.length = 0;
  });

  /** A tracked AbortController so no subscription outlives its test. */
  function controller(): AbortController {
    const created = new AbortController();
    controllers.push(created);
    return created;
  }

  it('delivers to every reader of a room, in publish order', async () => {
    const broadcaster = new RoomBroadcaster();
    const a = broadcaster.subscribe('room-1', controller().signal);
    const b = broadcaster.subscribe('room-1', controller().signal);

    broadcaster.publish('room-1', entryEvent(1));
    broadcaster.publish('room-1', entryEvent(2));

    expect((await take(a, 2)).map((e) => e.type === 'entry' && e.seq)).toEqual([1, 2]);
    expect((await take(b, 2)).map((e) => e.type === 'entry' && e.seq)).toEqual([1, 2]);
  });

  it('does not deliver another room events', async () => {
    const broadcaster = new RoomBroadcaster();
    const reader = broadcaster.subscribe('room-1', controller().signal);

    broadcaster.publish('room-2', entryEvent(1));
    broadcaster.publish('room-1', entryEvent(7));

    expect((await take(reader, 1)).map((e) => e.type === 'entry' && e.seq)).toEqual([7]);
  });

  it('registers the reader synchronously, so nothing published after subscribe is lost', async () => {
    const broadcaster = new RoomBroadcaster();
    const reader = broadcaster.subscribe('room-1', controller().signal);

    // No await between subscribe and publish — this is the cold-connect race
    // the SSE handler closes by subscribing before it reads the log.
    expect(broadcaster.subscriberCount('room-1')).toBe(1);
    broadcaster.publish('room-1', entryEvent(1));
    expect(await take(reader, 1)).toHaveLength(1);
  });

  it('unregisters the reader when its signal aborts', async () => {
    const broadcaster = new RoomBroadcaster();
    const aborter = new AbortController();
    const reader = broadcaster.subscribe('room-1', aborter.signal);
    const drained = take(reader, 10);

    expect(broadcaster.subscriberCount('room-1')).toBe(1);
    aborter.abort();
    await drained;
    expect(broadcaster.subscriberCount('room-1')).toBe(0);
  });

  it('never registers a reader whose signal has already aborted', () => {
    const broadcaster = new RoomBroadcaster();
    const aborter = new AbortController();
    aborter.abort();
    broadcaster.subscribe('room-1', aborter.signal);
    expect(broadcaster.subscriberCount('room-1')).toBe(0);
  });

  it('ends a stalled reader stream rather than buffering without bound', async () => {
    const warn = vi.spyOn(await import('../../../lib/logger.js').then((m) => m.logger), 'warn');
    const broadcaster = new RoomBroadcaster();
    const reader = broadcaster.subscribe('room-1', controller().signal);

    // Nothing is pulling, so every event queues. Past the cap the stream ends:
    // the client reconnects with its Last-Event-ID and replays off the durable
    // log, which is the only recovery that stays gap-free.
    for (let seq = 1; seq <= 1100; seq++) broadcaster.publish('room-1', entryEvent(seq));

    const collected: RoomEvent[] = [];
    for await (const event of reader) collected.push(event);

    expect(collected).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    expect(broadcaster.subscriberCount('room-1')).toBe(0);
    warn.mockRestore();
  });
});
