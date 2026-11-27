/**
 * The replay window's edges: the oldest cursor it can still serve, the byte
 * count it holds, and an event bigger than the whole budget.
 */
import { describe, expect, it } from 'vitest';
import { EventReplayBuffer } from '../event-replay-buffer.js';
import { deliveryBytes, encodeBroadcast } from '../global-event-frames.js';

/** A buffer of `maxEvents` whose deliveries weigh `bytes` each. */
function window(maxEvents: number, maxBytes = 1_000) {
  const buffer = new EventReplayBuffer<number>('events', { maxEvents, maxBytes });
  const add = (bytes = 1) =>
    buffer.append(
      'tasks_changed',
      () => bytes,
      (b) => b
    ).seq;
  const at = (seq: number) => ({ seq, generation: buffer.generation });
  return { buffer, add, at };
}

describe('EventReplayBuffer', () => {
  it('serves a cursor one below the oldest kept event, and refuses one below that', () => {
    const { buffer, add, at } = window(3);
    for (let i = 0; i < 5; i += 1) add(); // keeps 3, 4, 5
    const edge = buffer.resume(at(2));
    expect(edge.kind === 'replay' && edge.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(buffer.resume(at(1)).kind).toBe('snapshot');
  });

  it('does not keep an event bigger than the whole budget, and empties the window', () => {
    const { buffer, add, at } = window(10, 100);
    add(40);
    add(40);
    const huge = add(101);
    expect(buffer.heldBytes).toBe(0);
    // A cursor before it would replay across a gap, so it gets a snapshot.
    expect(buffer.resume(at(huge - 1)).kind).toBe('snapshot');
    expect(buffer.resume(at(huge))).toEqual({ kind: 'replay', entries: [] });
    const next = add(10);
    const after = buffer.resume(at(huge));
    expect(after.kind === 'replay' && after.entries.map((e) => e.seq)).toEqual([next]);
  });

  it('evicts the oldest once the bytes held pass the budget', () => {
    const { buffer, add, at } = window(10, 100);
    add(60);
    add(60);
    expect(buffer.heldBytes).toBe(60);
    expect(buffer.resume(at(0)).kind).toBe('snapshot');
  });

  it('counts both wire copies of every rendering, in bytes', () => {
    const place = { id: 'events-1-g1-1', seq: 1, at: '2026-11-27T00:00:00.000Z' };
    const full = encodeBroadcast('tasks_changed', { name: 'café' }, place);
    const redacted = encodeBroadcast('tasks_changed', {}, place);
    const bytes = (s: string) => Buffer.byteLength(s);
    expect(deliveryBytes({ full, redacted })).toBe(
      bytes(full.sse) + bytes(full.json) + bytes(redacted.sse) + bytes(redacted.json)
    );
    expect(bytes(full.sse)).toBeGreaterThan(full.sse.length);
  });
});
