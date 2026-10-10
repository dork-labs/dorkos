/** Exact minute-clock predicates are ordinary DATA, never a native producer clock. */
import { expect, it, vi } from 'vitest';
import { createRoomWaitingGrace } from '../turn/room-waiting-grace.js';

type Waiting = { kind: 'approval'; toolName: string };
const approval: Waiting = { kind: 'approval', toolName: 'Bash' };

it('forgets an approval answered three seconds after it appeared', async () => {
  vi.useFakeTimers();
  try {
    const waited: Waiting[] = [];
    const grace = createRoomWaitingGrace(60_000, (value: Waiting) => waited.push(value));
    grace.schedule('call-1', approval);
    await vi.advanceTimersByTimeAsync(3_000);
    grace.resolve('call-1');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(waited).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('reports a standing approval once after fifty-nine then two seconds', async () => {
  vi.useFakeTimers();
  try {
    const waited: Waiting[] = [];
    const grace = createRoomWaitingGrace(60_000, (value: Waiting) => waited.push(value));
    grace.schedule('call-1', approval);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(waited).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(waited).toEqual([approval]);
    grace.clear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(waited).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('reports the wait before terminal failure and forgets all terminal prompts', async () => {
  vi.useFakeTimers();
  try {
    const waited: Waiting[] = [];
    const order: string[] = [];
    const grace = createRoomWaitingGrace(60_000, (value: Waiting) => {
      waited.push(value);
      order.push('waiting');
    });
    grace.schedule('call-1', approval);
    await vi.advanceTimersByTimeAsync(60_500);
    expect(waited).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    grace.clear();
    order.push('failed');
    expect(order).toEqual(['waiting', 'failed']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(waited).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('forgets a standing prompt when its turn ends before grace expires', async () => {
  vi.useFakeTimers();
  try {
    const waited: Waiting[] = [];
    const grace = createRoomWaitingGrace(60_000, (value: Waiting) => waited.push(value));
    grace.schedule('call-1', approval);
    await vi.advanceTimersByTimeAsync(1_000);
    grace.clear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(waited).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
