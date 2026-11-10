import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpinOffStartup, SPIN_OFF_START_TIMEOUT_MS } from '../spin-off-startup.js';
import { ChatReportBack } from '../../chat-report-back.js';
import { readChat } from '../../chat-read.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function harness(reason = 'The first message is still queued.') {
  const send = vi
    .fn()
    .mockResolvedValue({ messageId: 'report', chatId: 'parent', status: 'queued' });
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
    failureReason: (_id, fallback) => fallback ?? reason,
    report: (id, why, marks) => reports.onNeverStarted(id, why, marks),
  });
  return { startup, send };
}

describe('spin-off first-turn deadline', () => {
  it('reports a first turn that never starts at five minutes, through the existing report sender', async () => {
    const { startup, send } = harness();
    startup.watch('child');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'child' }),
      expect.objectContaining({
        to: 'parent',
        summary: 'Failed: never started',
        message: 'Failed: never started.\n\nThe first message is still queued.',
      }),
      'report'
    );
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(1);
    startup.stop();
  });

  it('chat_read reports never-started instead of idle, with its reason', async () => {
    const { startup } = harness('The runtime could not open this chat.');
    startup.watch('child');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    const result = await readChat(
      {
        store: { latestSentTo: () => [] } as never,
        mayRead: async () => true,
        maySeeTitle: async () => true,
        describe: async () => ({ title: 'Build', agent: 'Builder' }),
        status: () => null,
        history: async () => [],
        search: async () => [],
        startupFailure: (id) => startup.failureOf(id),
      },
      { sessionId: 'parent', agentPath: '/demo/parent' },
      { chat: 'child', include: 'status' }
    );
    expect(result.chat.state).toBe('never-started');
    expect(result.chat.startupFailure).toBe('The runtime could not open this chat.');
    startup.stop();
  });

  it('does not report a spin-off that starts normally, even if it later goes idle', async () => {
    const { startup, send } = harness();
    startup.watch('child');
    await vi.advanceTimersByTimeAsync(1000);
    startup.started('child');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(send).not.toHaveBeenCalled();
    expect(startup.failureOf('child')).toBeNull();
    startup.stop();
  });

  it('preserves the deadline and reason across a canonical rename', async () => {
    const { startup, send } = harness();
    startup.watch('request');
    startup.noteFailure('request', 'The selected account is at its usage limit.');
    await vi.advanceTimersByTimeAsync(1000);
    startup.rekey('request', 'canonical');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS - 1000);
    expect(startup.failureOf('canonical')).toContain('usage limit');
    expect(send.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'canonical' });
    startup.stop();
  });

  it('clears the failure when a late first turn starts', async () => {
    const { startup } = harness();
    startup.watch('child');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    startup.started('child');
    expect(startup.failureOf('child')).toBeNull();
    startup.stop();
  });

  it('preserves the starter’s marks before the runtime has a child turn to record', async () => {
    const { startup, send } = harness();
    const marks = {
      outsider: true as const,
      teammate: [{ roomId: 'demo-room', authorId: 'demo-member' }],
    };
    startup.watch('request', '/demo/agent', marks);
    marks.teammate.length = 0;
    startup.rekey('request', 'canonical');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'canonical',
        marksAtTurnEnd: {
          outsider: true,
          teammate: [{ roomId: 'demo-room', authorId: 'demo-member' }],
        },
      }),
      expect.anything(),
      'report'
    );
    startup.stop();
  });

  it('cancels a refused start and every timer at shutdown', async () => {
    const { startup, send } = harness();
    startup.watch('refused');
    startup.forget('refused');
    startup.watch('shutdown');
    startup.stop();
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(send).not.toHaveBeenCalled();
  });
});
