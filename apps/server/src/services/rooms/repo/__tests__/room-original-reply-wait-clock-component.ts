/** Ordinary timing compatibility only; this callback never enters the native child. */
import assert from 'node:assert/strict';
import { vi } from 'vitest';
import {
  createRoomReplyDeadline,
  createRoomReplyElapsedClock,
  type RoomReplyTimingData,
} from '../../turn/room-reply-deadline.js';
export async function runOriginalReplyWaitClockComponent(): Promise<void> {
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
    assert.equal(await wait.beforeDeadline, null);
    finish({ text: 'green', failed: false, waitedMs: elapsed() });
    const late = await wait.afterDeadline;
    assert.equal(late.text, 'green');
    assert.equal(late.unanswered, undefined);
    assert.equal(late.waitedMs, 5);
  } finally {
    vi.useRealTimers();
  }
}
