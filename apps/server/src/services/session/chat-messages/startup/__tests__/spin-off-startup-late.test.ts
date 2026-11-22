/**
 * DOR-4985: a spin-off that waits for a free agent slot, or starts late, is
 * never reported as "never started" while it is in fact starting, and a
 * failure already sent is followed by one "started after all".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { SLOT_WAIT_STATUS, SLOT_WAIT_TEXT } from '@dorkos/shared/schemas';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import {
  setSpinOffStartup,
  SpinOffStartup,
  SPIN_OFF_START_TIMEOUT_MS,
  WAIT_LEASE_MS,
  type StartupClock,
} from '../spin-off-startup.js';
import { watchSpinOffTurn } from '../spin-off-turn.js';
import { ChatReportBack } from '../../chat-report-back.js';
import { readChat } from '../../chat-read.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  setSpinOffStartup(undefined);
  vi.useRealTimers();
});

function harness(clock?: StartupClock, send = sender()) {
  const reports = new ChatReportBack({
    service: { send },
    store: { listStopsOf: () => [], latestInterruptFrom: () => undefined },
    reportTargetOf: () => ({ parentSessionId: 'parent' }),
    agentPathOf: async () => '/demo/agent',
    holdsBackgroundWork: async () => false,
    statusOf: () => null,
    history: async () => [],
  });
  const startup = new SpinOffStartup({
    failureReason: (_id, fallback) => fallback ?? 'The runtime did not start its first turn.',
    report: (id, why, marks) => reports.onNeverStarted(id, why, marks),
    reportStartedLate: (id, marks) => reports.onStartedLate(id, marks),
    ...(clock ? { clock } : {}),
  });
  return { startup, send };
}

function sender() {
  return vi.fn().mockResolvedValue({ messageId: 'report', chatId: 'parent', status: 'queued' });
}

/** What a chat_read of `child` says, given what its projector shows. */
async function stateOf(startup: SpinOffStartup, lifecycle: SessionStatus['lifecycle']) {
  const result = await readChat(
    {
      store: { latestSentTo: () => [] } as never,
      mayRead: async () => true,
      maySeeTitle: async () => true,
      describe: async () => ({ title: 'Build', agent: 'Builder' }),
      status: () => ({ status: { lifecycle } as SessionStatus, needsYou: false }),
      history: async () => [],
      search: async () => [],
      startupFailure: (id) => startup.failureOf(id),
    },
    { sessionId: 'parent', agentPath: '/demo/parent' },
    { chat: 'child', include: 'status' }
  );
  return result.chat.state;
}

const slotWait: StreamEvent = {
  type: 'system_status',
  data: { message: SLOT_WAIT_TEXT, status: SLOT_WAIT_STATUS },
};
const firstWords: StreamEvent = { type: 'text_delta', data: { text: 'On it.' } };

/** A hand-fed runtime stream: push events, then end it. */
function handStream() {
  const queue: StreamEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* source(): AsyncIterable<StreamEvent> {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    source: source(),
    push(event: StreamEvent) {
      queue.push(event);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

/** Let `ms` pass while the runtime says it waits, one beat a minute as it does. */
async function waitInLine(runtime: { push(event: StreamEvent): void }, ms: number) {
  for (let left = ms; left > 0; left -= 60_000) {
    runtime.push(slotWait);
    await vi.advanceTimersByTimeAsync(Math.min(60_000, left));
  }
}

/** Drain a watched stream in the background, as the projector feed does. */
function drain(stream: AsyncIterable<StreamEvent>): Promise<void> {
  return (async () => {
    for await (const _event of stream) void _event;
  })();
}

describe('a first turn that waits for a free agent slot', () => {
  it('is not reported while it waits past five minutes, and its first words clear it', async () => {
    const { startup, send } = harness();
    setSpinOffStartup(startup);
    startup.watch('child');
    const runtime = handStream();
    const done = drain(watchSpinOffTurn(runtime.source, { sessionId: 'child' }).stream);

    await waitInLine(runtime, SPIN_OFF_START_TIMEOUT_MS + 90_000);
    expect(send).not.toHaveBeenCalled();
    expect(startup.failureOf('child')).toBeNull();
    expect(await stateOf(startup, 'streaming')).toBe('running');

    runtime.push(firstWords);
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS * 2);
    expect(send).not.toHaveBeenCalled();
    expect(startup.isWatching('child')).toBe(false);
    runtime.end();
    await done;
  });

  it('counts only the time outside the wait toward the five minutes', async () => {
    const { startup, send } = harness();
    startup.watch('child');
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 10; i++) {
      startup.waitingToStart('child');
      await vi.advanceTimersByTimeAsync(60_000);
    }
    startup.doneWaiting('child');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS - 60_001);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    startup.stop();
  });
});

describe('a first turn that starts before the deadline', () => {
  it('sends nothing at all', async () => {
    const { startup, send } = harness();
    setSpinOffStartup(startup);
    startup.watch('child');
    const runtime = handStream();
    const done = drain(watchSpinOffTurn(runtime.source, { sessionId: 'child' }).stream);
    await waitInLine(runtime, SPIN_OFF_START_TIMEOUT_MS - 60_000);
    runtime.push(firstWords);
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS * 2);
    expect(send).not.toHaveBeenCalled();
    runtime.end();
    await done;
  });
});

describe('the deadline itself', () => {
  it('never reports before five minutes, even when its timer fires early', async () => {
    let now = 0;
    const timers: Array<{ at: number; run: () => void }> = [];
    // A timer that fires halfway through what it was asked for.
    const clock: StartupClock = {
      now: () => now,
      set: (run, ms) => {
        const timer = { at: now + Math.ceil(ms / 2), run };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clear: (handle) => {
        const i = timers.indexOf(handle as unknown as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const tick = async (to: number) => {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > to) break;
        timers.shift();
        now = next.at;
        next.run();
        await vi.advanceTimersByTimeAsync(0);
      }
      now = to;
    };
    const { startup, send } = harness(clock);
    startup.watch('child');
    await tick(SPIN_OFF_START_TIMEOUT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    expect(startup.failureOf('child')).toBeNull();
    await tick(SPIN_OFF_START_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    startup.stop();
  });
});

describe('a first turn that starts after a failure was reported', () => {
  it('sends the same parent one "started after all", and chat_read says running', async () => {
    const { startup, send } = harness();
    setSpinOffStartup(startup);
    startup.watch('child');
    const runtime = handStream();
    const done = drain(watchSpinOffTurn(runtime.source, { sessionId: 'child' }).stream);

    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await stateOf(startup, 'streaming')).toBe('never-started');

    runtime.push(firstWords);
    runtime.push({
      type: 'tool_call_start',
      data: { toolCallId: 't1', toolName: 'Read', input: '', status: 'running' },
    });
    runtime.push({ type: 'text_delta', data: { text: ' More.' } });
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      to: 'parent',
      summary: 'Started after all',
    });
    expect(String(send.mock.calls[1]?.[1]?.message)).toMatch(/^Started after all/);
    expect(await stateOf(startup, 'streaming')).toBe('running');

    // A second turn, or a watch armed again for the same chat, sends no more.
    startup.started('child');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(2);
    runtime.end();
    await done;
  });
});

describe('a slot wait that never turns into a start', () => {
  it('is reported once the stream ends mid-wait, after the time still owed', async () => {
    const { startup, send } = harness();
    setSpinOffStartup(startup);
    startup.watch('child');
    const runtime = handStream();
    const done = drain(watchSpinOffTurn(runtime.source, { sessionId: 'child' }).stream);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitInLine(runtime, 10 * 60_000);
    runtime.end();
    await done;
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS - 60_001);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('is reported when the runtime refuses it after the wait', async () => {
    const { startup, send } = harness();
    setSpinOffStartup(startup);
    startup.watch('child');
    const runtime = handStream();
    const done = drain(watchSpinOffTurn(runtime.source, { sessionId: 'child' }).stream);
    await waitInLine(runtime, 10 * 60_000);
    runtime.push({
      type: 'error',
      data: { message: 'No slot.', code: 'turn_not_started', reason: 'warm-ceiling' },
    });
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(1);
    runtime.end();
    await done;
  });

  it('counts again from the last beat when the beats stop without the stream ending', async () => {
    const { startup, send } = harness();
    setSpinOffStartup(startup);
    startup.watch('child');
    const runtime = handStream();
    const done = drain(watchSpinOffTurn(runtime.source, { sessionId: 'child' }).stream);
    await waitInLine(runtime, 3 * 60_000);
    // The last beat was at 2:00; silence after it counts, so five minutes from it.
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS - 60_001);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(WAIT_LEASE_MS).toBeLessThan(SPIN_OFF_START_TIMEOUT_MS);
    runtime.end();
    await done;
  });
});

describe('the order a parent hears things in', () => {
  it('never gets "started after all" ahead of a "never started" still being retried', async () => {
    const send = sender();
    send.mockRejectedValueOnce(new Error('Parent busy.'));
    const { startup } = harness(undefined, send);
    startup.watch('child');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(1);
    startup.started('child');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    const summaries = send.mock.calls.map((call) => call[1]?.summary);
    expect(summaries).toEqual([
      'Failed: never started',
      'Failed: never started',
      'Started after all',
    ]);
  });
});
