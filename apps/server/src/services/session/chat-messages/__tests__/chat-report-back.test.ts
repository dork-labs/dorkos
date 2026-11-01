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
  const end = () =>
    reportBack.onTurnEnd(CHILD, deps.statusOf(CHILD), { from: NOW - 60_000, to: NOW });
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

  it('says why when a refused turn failed without a word (DOR-3167)', async () => {
    const reason = 'gpt-6.1-sol isn’t available with a ChatGPT account.';
    const { send, end } = harness({
      statusOf: () => status({ lifecycle: 'error', lastError: { message: reason } }),
      history: async () => history(['user', 'do the thing']),
    });

    await end();

    expect(send.mock.calls[0]![1].message).toBe(`This turn failed.\n\n${reason}`);
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
        // Claude Code records no time on a message somebody sent.
        { id: 'u2', role: 'user', content: 'next' },
        {
          id: 'a2',
          role: 'assistant',
          content: 'Added the title.',
          timestamp: '2026-10-09T12:00:06.000Z',
        },
      ],
    });
    await expect(end()).resolves.toBe('finished');
    expect(send.mock.calls[0]![1].message).toContain('Wrote the haiku.');
    expect(send.mock.calls[0]![1].message).not.toContain('Added the title.');
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
      parentTakesMessages: true,
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
      parentTakesMessages: true,
    });
    expect(off).toContain('does not hear from you on its own');
    expect(off).toContain(`chat_send to ${PARENT}`);
  });

  it('never points a spin-off of a room chat at chat_send, which that chat refuses', () => {
    // 2026-10-12: chats started from the room-bound coordinator were told to
    // "Send what matters with chat_send to <it>", every send was refused, and
    // they reported "the coordinator doesn't accept direct messages".
    const roomChild = spinOffBriefing({
      parentChatId: PARENT,
      parentTitle: 'Other agents in #dorkos',
      parentAgentName: 'Coordinator',
      reportBack: false,
      parentTakesMessages: false,
    });
    expect(roomChild).not.toContain('chat_send');
    expect(roomChild).toContain('post_to_room');
  });
});

describe('a parent that is a room’s seat (DOR-3488)', () => {
  it('sends the report into the seat, not as a chat message the seat would refuse', async () => {
    const toRoomSeat = vi.fn().mockResolvedValue(true);
    const { send, end } = harness({ toRoomSeat });
    await expect(end()).resolves.toBe('finished');
    expect(send).not.toHaveBeenCalled();
    expect(toRoomSeat).toHaveBeenCalledTimes(1);
    const [parent, report] = toRoomSeat.mock.calls[0]!;
    expect(parent).toBe(PARENT);
    expect(report).toMatchObject({ fromSessionId: CHILD, fromAgentPath: '/agents/builder' });
    expect(report.text).toContain('Finished this turn.');
    expect(report.text).toContain('Done: merged #1.');
  });

  it('sends a chat message as before when the parent is no room’s seat', async () => {
    const toRoomSeat = vi.fn().mockResolvedValue(false);
    const { send, end } = harness({ toRoomSeat });
    await end();
    expect(toRoomSeat).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1].to).toBe(PARENT);
  });

  it('sends a "needs the person" wait into the seat too', async () => {
    const toRoomSeat = vi.fn().mockResolvedValue(true);
    const { reportBack, send } = harness({
      toRoomSeat,
      statusOf: () => status({ lifecycle: 'blocked' }),
    });
    await expect(reportBack.onWaiting(CHILD, { key: 'w1', what: 'It asks: ship?' })).resolves.toBe(
      true
    );
    expect(send).not.toHaveBeenCalled();
    expect(toRoomSeat.mock.calls[0]![1].text).toContain('It asks: ship?');
  });

  it('a seat delivery that throws is logged, never thrown at the projector', async () => {
    const { send, end } = harness({ toRoomSeat: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(end()).resolves.toBe('finished');
    expect(send).not.toHaveBeenCalled();
  });

  it('the briefing promises reports to a seat, and never tells the spin-off to chat_send it', () => {
    const seatChild = spinOffBriefing({
      parentChatId: PARENT,
      parentTitle: 'Other agents in #dorkos',
      parentAgentName: 'Coordinator',
      reportBack: true,
      parentTakesMessages: false,
      parentIsRoomSeat: true,
    });
    expect(seatChild).toContain('goes back to that chat on its own');
    expect(seatChild).toContain('takes no chat_send');
    expect(seatChild).not.toContain(`chat_send to ${PARENT}`);
    expect(seatChild).toContain('keep your turn alive');
  });
});
