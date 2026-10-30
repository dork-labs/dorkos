/**
 * A channel burst becomes one turn, started once the burst goes quiet
 * (DOR-3398, room coordination item 1).
 *
 * Driven against {@link RoomCollector} alone with fake timers: the window is a
 * clock property, and the dispatcher above it adds nothing to when a batch
 * closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import {
  RoomCollector,
  ROOM_BURST_MAX_WAIT_MS,
  ROOM_BURST_QUIET_MS,
  type CollectInput,
  type RoomCollection,
} from '../room-collect.js';

const DEBOUNCE_MS = 500;

function collectorFor(quietMs: number | undefined) {
  const batches: RoomCollection[][] = [];
  const collector = new RoomCollector({
    window: () => ({
      debounceMs: DEBOUNCE_MS,
      maxEntries: 20,
      ...(quietMs !== undefined ? { quietMs } : {}),
    }),
    run: (batch) => batches.push(batch),
  });
  return { collector, batches };
}

function message(kind: 'channel' | 'dm', seq: number): CollectInput {
  return {
    room: { id: 'room-1', kind } as Room,
    authorId: 'agent-ana',
    agentPath: '/agents/ana',
    displayName: 'Ana',
    entry: { id: `entry-${seq}`, seq } as RoomEntry,
    depth: 0,
    engaged: null,
    reason: 'mention' as CollectInput['reason'],
    duringTurnHere: false,
    park: false,
    arrivedAt: Date.now(),
  };
}

describe('channel burst window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the quiet window and its cap as constants', () => {
    expect(ROOM_BURST_QUIET_MS).toBe(20_000);
    expect(ROOM_BURST_MAX_WAIT_MS).toBe(60_000);
  });

  it('collapses 5 messages in 10s into one turn, 20s after the last', () => {
    const { collector, batches } = collectorFor(ROOM_BURST_QUIET_MS);
    for (let i = 0; i < 5; i += 1) {
      collector.collect(message('channel', i + 1));
      vi.advanceTimersByTime(2_500);
    }
    // The last message landed at 10s; nothing has run yet.
    vi.advanceTimersByTime(ROOM_BURST_QUIET_MS - 2_500 - 1);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]![0]!.entries.map((e) => e.entry.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never holds a turn back past the cap, however long the chatter lasts', () => {
    const { collector, batches } = collectorFor(ROOM_BURST_QUIET_MS);
    collector.collect(message('channel', 1));
    for (let seq = 2; seq <= 10; seq += 1) {
      vi.advanceTimersByTime(10_000);
      if (batches.length > 0) break;
      collector.collect(message('channel', seq));
    }
    // A message every 10s would slide forever; the cap closes it at 60s.
    expect(batches).toHaveLength(1);
    expect(Date.now()).toBe(ROOM_BURST_MAX_WAIT_MS);
    expect(batches[0]![0]!.entries).toHaveLength(6);
  });

  it('leaves a DM on the fixed window', () => {
    const { collector, batches } = collectorFor(ROOM_BURST_QUIET_MS);
    collector.collect(message('dm', 1));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(batches).toHaveLength(1);
  });

  it('keeps the fixed window when no quiet window is configured', () => {
    const { collector, batches } = collectorFor(undefined);
    collector.collect(message('channel', 1));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(batches).toHaveLength(1);
  });
});
