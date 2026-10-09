/** Ordinary event schedules exercise the production classifier; no private projector ingress. */
import { expect, it, vi } from 'vitest';
import {
  createRoomReplyTurnGate,
  shouldCancelUnstartedRoomReply,
} from '../turn/room-reply-turn-data.js';

type Event = { type: string; seq: number; text?: string; prompt?: string; target?: string };
function ordinaryRead(readSeq: () => number | null) {
  const gate = createRoomReplyTurnGate(readSeq);
  const text: string[] = [];
  const activity: Array<string | null> = [];
  const prompts: string[] = [];
  return {
    text,
    activity,
    prompts,
    feed(event: Event) {
      if (!gate.read(event.type, event.seq)) return;
      if (event.type === 'text_delta') text.push(event.text ?? '');
      if (event.type === 'tool_call') activity.push(event.target ?? null);
      if (event.type === 'approval_required') prompts.push(event.prompt ?? '');
      if (event.type === 'turn_end') activity.push(null);
    },
  };
}

it('cancels an accepted ordinary schedule immediately when it is declared never started', async () => {
  vi.useFakeTimers();
  try {
    const startedAt = Date.now();
    let startSeq: number | null = null;
    const waited = new Promise<'failed'>((resolve) => {
      setTimeout(() => {
        if (shouldCancelUnstartedRoomReply('failed', startSeq)) resolve('failed');
      }, 0);
    });
    let resolved = false;
    void waited.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await waited).toBe('failed');
    expect(resolved).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    // Original 5000/10000 bounds are never reached: this classifier says cancel now.
    startSeq = 1;
    expect(shouldCancelUnstartedRoomReply('failed', startSeq)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps a started failing schedule on its existing read path', () => {
  let own: number | null = null;
  const read = ordinaryRead(() => own);
  own = 4;
  read.feed({ type: 'turn_start', seq: 4 });
  read.feed({ type: 'text_delta', seq: 5, text: 'Half an answer.' });
  expect(shouldCancelUnstartedRoomReply('failed', own)).toBe(false);
  read.feed({ type: 'turn_end', seq: 6 });
  expect(read.text.join('')).toBe('Half an answer.');
});

it('reads a start delivered after ordinary acceptance resolved', async () => {
  let own: number | null = null;
  const read = ordinaryRead(() => own);
  await Promise.resolve({ accepted: true });
  own = 8;
  read.feed({ type: 'turn_start', seq: 8 });
  read.feed({ type: 'text_delta', seq: 9, text: 'Paris.' });
  read.feed({ type: 'turn_end', seq: 10 });
  expect(read.text.join('')).toBe('Paris.');
});

it('does not collect the tail before its own start inside an older turn', () => {
  const read = ordinaryRead(() => 20);
  read.feed({ type: 'text_delta', seq: 17, text: 'green and here is why' });
  read.feed({ type: 'turn_end', seq: 18 });
  read.feed({ type: 'turn_start', seq: 20 });
  read.feed({ type: 'text_delta', seq: 21, text: 'the tests pass' });
  read.feed({ type: 'turn_end', seq: 22 });
  expect(read.text.join('')).toBe('the tests pass');
});

it('ignores identical or absent prompt resemblance before its actual sequence', () => {
  const read = ordinaryRead(() => 30);
  read.feed({ type: 'turn_start', seq: 1, prompt: 'is the build green?' });
  read.feed({ type: 'text_delta', seq: 2, text: 'not the answer to the room' });
  read.feed({ type: 'turn_end', seq: 3 });
  read.feed({ type: 'turn_start', seq: 4 });
  read.feed({ type: 'text_delta', seq: 5, text: 'compacted the transcript' });
  read.feed({ type: 'turn_end', seq: 6 });
  read.feed({ type: 'turn_start', seq: 30, prompt: 'is the build green?' });
  read.feed({ type: 'text_delta', seq: 31, text: 'green' });
  expect(read.text.join('')).toBe('green');
});

it('passes only its own tool activity and terminal clear', () => {
  const read = ordinaryRead(() => 10);
  read.feed({ type: 'turn_start', seq: 1 });
  read.feed({ type: 'tool_call', seq: 2, target: 'secrets.md' });
  read.feed({ type: 'turn_end', seq: 3 });
  read.feed({ type: 'turn_start', seq: 10 });
  read.feed({ type: 'tool_call', seq: 11, target: 'standup.md' });
  read.feed({ type: 'text_delta', seq: 12, text: 'green' });
  read.feed({ type: 'turn_end', seq: 13 });
  expect(read.activity).toEqual(['standup.md', null]);
  expect(read.text.join('')).toBe('green');
});

it('passes no approval from a foreign ordinary turn even with zero grace', () => {
  const read = ordinaryRead(() => 10);
  read.feed({ type: 'turn_start', seq: 1 });
  read.feed({ type: 'approval_required', seq: 2, prompt: 'Bash' });
  read.feed({ type: 'turn_end', seq: 3 });
  read.feed({ type: 'turn_start', seq: 10 });
  read.feed({ type: 'text_delta', seq: 11, text: 'green' });
  expect(read.prompts).toEqual([]);
  expect(read.text.join('')).toBe('green');
});
