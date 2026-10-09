/**
 * Spin-offs report back on their own (spec `spin-off-chats` §5): on finish,
 * fail, stop, limit and needs-you, and never on a turn that ended only to wait.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import {
  ChatReportBack,
  REPORT_TEXT_MAX,
  composeReport,
  lastTurnText,
  reasonOf,
  spinOffBriefing,
  type ChatReportBackDeps,
} from '../chat-report-back.js';

const CHILD = 'child-chat';
const PARENT = 'parent-chat';
const NOW = Date.parse('2026-10-09T12:00:00.000Z');

function status(over: Partial<SessionStatus> = {}): SessionStatus {
  return { lifecycle: 'idle', limit: null, ...over } as SessionStatus;
}

function history(...messages: Array<[HistoryMessage['role'], string]>): HistoryMessage[] {
  return messages.map(([role, content], i) => ({ id: `m${i}`, role, content }));
}

function harness(over: Partial<ChatReportBackDeps> = {}) {
  const send = vi.fn().mockResolvedValue({ messageId: 'r1', chatId: PARENT, status: 'working' });
  const deps: ChatReportBackDeps = {
    service: { send },
    store: { listStopsOf: () => [], latestInterruptFrom: () => undefined },
    reportTargetOf: (id) => (id === CHILD ? { parentSessionId: PARENT } : null),
    agentPathOf: async () => '/agents/builder',
    holdsBackgroundWork: async () => false,
    statusOf: () => status(),
    history: async () => history(['user', 'do the thing'], ['assistant', 'Done: merged #1.']),
    delay: async () => {},
    now: () => Date.parse('2026-10-09T12:00:00.000Z'),
    ...over,
  };
  const reportBack = new ChatReportBack(deps);
  /** The turn ends with the chat's status as the boundary reads it. */
  const end = () => reportBack.onTurnEnd(CHILD, deps.statusOf(CHILD), NOW);
  return { reportBack, send, end };
}

describe('ChatReportBack.onTurnEnd', () => {
  it('sends the last turn to the parent as a report when the turn finished', async () => {
    const { send, end } = harness();
    await expect(end()).resolves.toBe('finished');
    expect(send).toHaveBeenCalledTimes(1);
    const [caller, input, kind] = send.mock.calls[0]!;
    expect(caller).toEqual({ sessionId: CHILD, agentPath: '/agents/builder' });
    expect(input.to).toBe(PARENT);
    expect(input.summary).toBe('Finished');
    expect(input.message).toContain('Finished this turn.');
    expect(input.message).toContain('Done: merged #1.');
    expect(kind).toBe('report');
  });

  it('reports a failed turn, a stopped one and a usage limit with their own words', async () => {
    for (const [s, summary] of [
      [status({ lifecycle: 'error' }), 'Failed'],
      [status({ lifecycle: 'interrupted' }), 'Stopped'],
      [
        status({
          limit: {
            accountId: null,
            window: 'five_hour',
            resetsAt: null,
            since: '2026-10-09T11:00:00.000Z',
          } as SessionStatus['limit'],
        }),
        'Paused at a usage limit',
      ],
    ] as const) {
      const { send, end } = harness({ statusOf: () => s });
      await end();
      expect(send.mock.calls[0]![1].summary).toBe(summary);
    }
  });

  it('sends nothing when the turn ended only to wait on background work', async () => {
    const { send, end } = harness({ holdsBackgroundWork: async () => true });
    await expect(end()).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing for a chat that does not report back, or has no parent', async () => {
    const { send, end } = harness({ reportTargetOf: () => null });
    await expect(end()).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing for a finished turn that said nothing', async () => {
    const { send, end } = harness({
      history: async () => history(['assistant', 'earlier answer'], ['user', 'summarize']),
    });
    await expect(end()).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not report a stop the parent itself made just now', async () => {
    const { send, end } = harness({
      statusOf: () => status({ lifecycle: 'interrupted' }),
      store: {
        listStopsOf: () =>
          [{ fromSessionId: PARENT, createdAt: '2026-10-09T11:59:50.000Z' }] as never,
        latestInterruptFrom: () => undefined,
      },
    });
    await expect(end()).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('still reports a stop somebody else made', async () => {
    const { send, end } = harness({
      statusOf: () => status({ lifecycle: 'interrupted' }),
      store: {
        listStopsOf: () =>
          [{ fromSessionId: 'someone-else', createdAt: '2026-10-09T11:59:50.000Z' }] as never,
        latestInterruptFrom: () => undefined,
      },
    });
    await expect(end()).resolves.toBe('stopped');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a send that throws is logged, never thrown at the projector', async () => {
    const { end } = harness({
      service: { send: vi.fn().mockRejectedValue(new Error('no room')) },
    });
    await expect(end()).resolves.toBe('finished');
  });
});

describe('ChatReportBack.onWaiting', () => {
  it('reports waiting on the person once per wait, with what it asks', async () => {
    const { reportBack, send } = harness({ statusOf: () => status({ lifecycle: 'blocked' }) });
    const wait = { key: 'w1', what: 'It asks to use Bash.' };
    await expect(reportBack.onWaiting(CHILD, wait)).resolves.toBe(true);
    await expect(reportBack.onWaiting(CHILD, wait)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const [, input] = send.mock.calls[0]!;
    expect(input.summary).toBe('Needs the person');
    expect(input.message).toContain('It asks to use Bash.');
  });

  it('sends nothing for an ask answered before the settle: nobody is woken for nothing', async () => {
    const { reportBack, send } = harness({ statusOf: () => status({ lifecycle: 'streaming' }) });
    await expect(reportBack.onWaiting(CHILD, { key: 'w2', what: 'x' })).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('a turn ending while still waiting on the person sends nothing more', async () => {
    const { send, end } = harness({ statusOf: () => status({ lifecycle: 'blocked' }) });
    await expect(end()).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the review findings (DOR-2790 PR 2)', () => {
  it('reads THIS turn’s words even when the next turn’s message is already in the history', async () => {
    // The parent's follow-up queued behind the turn, started the next turn,
    // and reached the history before the report read it.
    const { send, end } = harness({
      history: async () => [
        { id: 'u1', role: 'user', content: 'go', timestamp: '2026-10-09T11:59:00.000Z' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Wrote the haiku.',
          timestamp: '2026-10-09T11:59:59.000Z',
        },
        { id: 'u2', role: 'user', content: 'next', timestamp: '2026-10-09T12:00:05.000Z' },
      ],
    });
    await expect(end()).resolves.toBe('finished');
    expect(send.mock.calls[0]![1].message).toContain('Wrote the haiku.');
  });

  it('sends nothing while a helper is still running', async () => {
    const { send, end } = harness({
      statusOf: () => status({ runningSubagentCount: 1 } as Partial<SessionStatus>),
    });
    await expect(end()).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not report the parent’s own interrupt back to it', async () => {
    const { send, end } = harness({
      statusOf: () => status({ lifecycle: 'interrupted' }),
      store: {
        listStopsOf: () => [],
        latestInterruptFrom: () => ({ createdAt: '2026-10-09T11:59:55.000Z' }) as never,
      },
    });
    await expect(end()).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the words', () => {
  it('lastTurnText joins the assistant messages after the last message it was sent', () => {
    expect(
      lastTurnText(
        history(
          ['user', 'a'],
          ['assistant', 'old'],
          ['user', 'b'],
          ['assistant', 'one'],
          ['assistant', 'two']
        )
      )
    ).toBe('one\n\ntwo');
    expect(lastTurnText(history(['assistant', 'x'], ['user', 'b']))).toBe('');
  });

  it('composeReport cuts a long message and says how to read the rest', () => {
    const long = 'x'.repeat(REPORT_TEXT_MAX + 10);
    const report = composeReport('finished', long);
    expect(report).toContain('chat_read');
    expect(report.length).toBeLessThan(long.length + 200);
  });

  it('reasonOf reads the status', () => {
    expect(reasonOf(status())).toBe('finished');
    expect(reasonOf(status({ lifecycle: 'blocked' }))).toBeNull();
  });

  it('the briefing names the parent and says how reports work, or that they do not', () => {
    const on = spinOffBriefing({
      parentChatId: PARENT,
      parentTitle: 'Release v1',
      parentAgentName: 'Coordinator',
      reportBack: true,
    });
    expect(on).toContain(PARENT);
    expect(on).toContain('Release v1');
    expect(on).toContain('goes back to that chat on its own');
    expect(on).toContain('keep your turn alive');
    const off = spinOffBriefing({
      parentChatId: PARENT,
      parentTitle: null,
      parentAgentName: 'Coordinator',
      reportBack: false,
    });
    expect(off).toContain('does not hear from you on its own');
  });
});
