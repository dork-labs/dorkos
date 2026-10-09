/** Exact clock compatibility stays ordinary DATA; it never registers a runtime or creates a request. */
import { expect, it, vi } from 'vitest';
import {
  createRoomReplyDeadline,
  createRoomReplyElapsedClock,
  type RoomReplyTimingData,
} from '../turn/room-reply-deadline.js';

it('retains the same complete answer after its exact five-millisecond ordinary wait', async () => {
  vi.useFakeTimers();
  try {
    const elapsed = createRoomReplyElapsedClock();
    let finish!: (value: RoomReplyTimingData) => void;
    const completed = new Promise<RoomReplyTimingData>((resolve) => {
      finish = resolve;
    });
    const wait = createRoomReplyDeadline(completed, 5);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(4);
    expect(await wait.beforeDeadline).toBeNull();
    // The timer passing never resolves or truncates the independently retained answer.
    let answered = false;
    void wait.afterDeadline.then(() => {
      answered = true;
    });
    await Promise.resolve();
    expect(answered).toBe(false);
    finish({ text: 'green', failed: false, waitedMs: elapsed() });
    const late = await wait.afterDeadline;
    expect(late.text).toBe('green');
    expect(late.unanswered).toBeUndefined();
    expect(late.waitedMs).toBe(5);
  } finally {
    vi.useRealTimers();
  }
});

it('clears the ordinary deadline on an early complete answer and preserves failure projection', async () => {
  vi.useFakeTimers();
  try {
    const turn = { text: 'Half an answer.', failed: true, waitedMs: 0 };
    const wait = createRoomReplyDeadline(Promise.resolve(turn), 5);
    expect(await wait.beforeDeadline).toBe(turn);
    expect(await wait.afterDeadline).toEqual({
      text: 'Half an answer.',
      waitedMs: 0,
      unanswered: 'failed',
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('cancels only the ordinary wait timer without fabricating completion', async () => {
  vi.useFakeTimers();
  try {
    let finish!: (value: RoomReplyTimingData) => void;
    const completed = new Promise<RoomReplyTimingData>((resolve) => {
      finish = resolve;
    });
    const wait = createRoomReplyDeadline(completed, 5);
    wait.clear();
    expect(vi.getTimerCount()).toBe(0);
    let answered = false;
    void wait.beforeDeadline.then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(5);
    expect(answered).toBe(false);
    const turn = { text: null, failed: false, waitedMs: 5 };
    finish(turn);
    expect(await wait.beforeDeadline).toBe(turn);
    expect(await wait.afterDeadline).toEqual({ text: null, waitedMs: 5 });
  } finally {
    vi.useRealTimers();
  }
});
