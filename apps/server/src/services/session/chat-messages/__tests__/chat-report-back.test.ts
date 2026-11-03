/**
 * Spin-offs report back on their own (spec `spin-off-chats` §5): on finish,
 * fail, stop, limit and needs-you, and for a turn that ended holding work, once it is released.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { logger } from '../../../../lib/logger.js';
import {
  ChatReportBack,
  DEFER_MAX_MS,
  DELIVERY_RETRY_MS,
  REPORT_SETTLE_MS,
  REPORT_TEXT_MAX,
  composeReport,
  lastTurnText,
  reasonOf,
  spinOffBriefing,
  type ChatReportBackDeps,
} from '../chat-report-back.js';

vi.mock('../../../../lib/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/logger.js')>();
  return { ...actual, logger: { ...actual.logger, warn: vi.fn(), error: vi.fn() } };
});

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
    expect(caller).toEqual({ sessionId: CHILD, agentPath: '/agents/builder', marksAtTurnEnd: {} });
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

  it('sends nothing yet when the turn ended holding background work', async () => {
    const { send, end } = harness({ holdsBackgroundWork: async () => true, later: () => {} });
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

describe('a turn that ended holding work (DOR-3720)', () => {
  /** A harness whose rechecks run by hand, with a clock and a hold the test moves. */
  function holding(over: Partial<ChatReportBackDeps> = {}) {
    const state = { holds: true, lifecycle: 'idle' as SessionStatus['lifecycle'], at: NOW };
    const rechecks: Array<() => void> = [];
    const h = harness({
      holdsBackgroundWork: async () => state.holds,
      statusOf: () => status({ lifecycle: state.lifecycle }),
      now: () => state.at,
      later: (_ms, run) => {
        rechecks.push(run);
      },
      ...over,
    });
    /** Run the next pending recheck and let it finish. */
    const recheck = async () => {
      rechecks.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { ...h, state, rechecks, recheck };
  }

  it('an expired delivery with no later turn still reports', async () => {
    const { end, send, state, recheck } = holding();
    await expect(end()).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
    // Still owed: nothing goes yet.
    await recheck();
    expect(send).not.toHaveBeenCalled();
    // The owed-delivery clock expires. No turn opens.
    state.holds = false;
    await recheck();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1].summary).toBe('Finished');
    expect(send.mock.calls[0]![1].message).toContain('Done: merged #1.');
  });

  it('a report cannot arrive twice when a later turn does open', async () => {
    const { reportBack, end, send, state, recheck, rechecks } = holding();
    await end();
    // The debt clears because a delivery segment opened: the turn shows as open.
    state.holds = false;
    state.lifecycle = 'streaming';
    await recheck();
    expect(send).not.toHaveBeenCalled();
    // That turn ends and reports.
    state.lifecycle = 'idle';
    await reportBack.onTurnEnd(CHILD, status(), { from: NOW - 60_000, to: NOW });
    expect(send).toHaveBeenCalledTimes(1);
    // The recheck still pending finds its entry taken.
    while (rechecks.length > 0) await recheck();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a later turn opening during the settle takes the report, once', async () => {
    const delays: Array<() => void> = [];
    const { reportBack, end, send, state, recheck } = holding({
      delay: (ms) =>
        ms === 750
          ? new Promise((resolve) => {
              delays.push(() => resolve());
            })
          : Promise.resolve(),
    });
    await end();
    state.holds = false;
    await recheck();
    // Released and quiet: the recheck is in its settle. The later turn opens and ends now.
    const later = reportBack.onTurnEnd(CHILD, status(), { from: NOW - 60_000, to: NOW });
    await vi.waitFor(() => expect(delays.length).toBe(2));
    for (const go of delays) go();
    await later;
    await new Promise((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a turn ending during the last look takes the report, once', async () => {
    // Security's DOR-3720 proof: the last look at whether work is held is async, and the entry was
    // deleted after it unchecked, so the waiting turn's words went twice.
    let calls = 0;
    let release: (holds: boolean) => void = () => {};
    const { reportBack, end, send, recheck } = holding({
      holdsBackgroundWork: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(true);
        if (calls === 3) return new Promise<boolean>((resolve) => (release = resolve));
        return Promise.resolve(false);
      },
    });
    await end();
    await recheck();
    await vi.waitFor(() => expect(calls).toBe(3));
    await reportBack.onTurnEnd(CHILD, status(), { from: NOW + 1_000, to: NOW + 2_000 });
    expect(send).toHaveBeenCalledTimes(1);
    release(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a later turn that said nothing falls back to the words of the turn that waited', async () => {
    const { reportBack, end, send, state } = holding({
      history: async () => [
        {
          id: 'a1',
          role: 'assistant',
          content: 'Done, waiting on CI.',
          timestamp: new Date(NOW - 30_000).toISOString(),
        },
      ],
    });
    await end();
    state.holds = false;
    await reportBack.onTurnEnd(CHILD, status(), { from: NOW + 60_000, to: NOW + 90_000 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1].message).toContain('Done, waiting on CI.');
  });

  it('work that runs past the limit reports once, saying it is still running', async () => {
    const { end, send, state, recheck, rechecks } = holding();
    await end();
    state.at = NOW + DEFER_MAX_MS;
    await recheck();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1].summary).toBe('Still working');
    expect(send.mock.calls[0]![1].message).toContain('background work still running');
    expect(rechecks).toHaveLength(0);
  });

  it('a running helper makes it wait too, and it reports once the helper is gone', async () => {
    let helpers = 1;
    const { end, send, recheck } = holding({
      holdsBackgroundWork: async () => false,
      statusOf: () => status({ runningSubagentCount: helpers } as Partial<SessionStatus>),
    });
    await expect(end()).resolves.toBeNull();
    await recheck();
    expect(send).not.toHaveBeenCalled();
    helpers = 0;
    await recheck();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['failed', status({ lifecycle: 'error' }), 'Failed'],
    ['stopped', status({ lifecycle: 'interrupted' }), 'Stopped'],
  ] as const)('a %s turn holding work reports at once', async (_name, ended, summary) => {
    const { reportBack, send } = holding();
    await reportBack.onTurnEnd(CHILD, ended, { from: NOW - 60_000, to: NOW });
    expect(send.mock.calls[0]![1].summary).toBe(summary);
  });

  it('a turn at a usage limit holding work reports at once', async () => {
    const { reportBack, send } = holding();
    const limited = status({
      limit: {
        accountId: null,
        window: 'five_hour',
        resetsAt: null,
        since: '2026-10-09T11:00:00.000Z',
      } as SessionStatus['limit'],
    });
    await reportBack.onTurnEnd(CHILD, limited, { from: NOW - 60_000, to: NOW });
    expect(send.mock.calls[0]![1].summary).toBe('Paused at a usage limit');
  });

  describe.each([
    ['a chat', false],
    ['a room seat', true],
  ] as const)('every way a turn ends, into %s', (_name, seat) => {
    /** What landed: the seat's report text, or the chat message. */
    function deps() {
      const toRoomSeat = vi.fn().mockResolvedValue(seat);
      const texts = () =>
        seat ? toRoomSeat.mock.calls.map(([, r]) => r.text as string) : undefined;
      return { toRoomSeat, texts };
    }

    it.each([
      ['finished', status(), 'Finished this turn.'],
      ['failed', status({ lifecycle: 'error' }), 'This turn failed.'],
      ['stopped', status({ lifecycle: 'interrupted' }), 'This turn was stopped.'],
      [
        'paused',
        status({
          limit: {
            accountId: null,
            window: 'five_hour',
            resetsAt: null,
            since: '2026-10-09T11:00:00.000Z',
          } as SessionStatus['limit'],
        }),
        'Paused:',
      ],
    ] as const)('%s, with nothing held', async (_ending, ended, line) => {
      const { toRoomSeat, texts } = deps();
      const { reportBack, send } = harness({ toRoomSeat });
      await reportBack.onTurnEnd(CHILD, ended, { from: NOW - 60_000, to: NOW });
      const landed = texts() ?? send.mock.calls.map(([, input]) => input.message as string);
      expect(landed).toHaveLength(1);
      expect(landed[0]).toContain(line);
    });

    it('needs-you', async () => {
      const { toRoomSeat, texts } = deps();
      const { reportBack, send } = harness({
        toRoomSeat,
        statusOf: () => status({ lifecycle: 'blocked' }),
      });
      await reportBack.onWaiting(CHILD, { key: `w-${seat}`, what: 'It asks: ship?' });
      const landed = texts() ?? send.mock.calls.map(([, input]) => input.message as string);
      expect(landed).toHaveLength(1);
      expect(landed[0]).toContain('It asks: ship?');
    });
  });

  it('into a room seat: an expired delivery wakes the seat', async () => {
    const toRoomSeat = vi.fn().mockResolvedValue(true);
    const { end, send, state, recheck } = holding({ toRoomSeat });
    await end();
    state.holds = false;
    await recheck();
    expect(send).not.toHaveBeenCalled();
    expect(toRoomSeat).toHaveBeenCalledTimes(1);
    expect(toRoomSeat.mock.calls[0]![1].text).toContain('Finished this turn.');
  });
});

describe('a report keeps the marks of the turn it speaks for (DOR-3720 M1)', () => {
  const ORIGIN = { roomId: 'r', authorId: 'teammate' };
  const WIFI = { outsider: true as const, teammate: [ORIGIN] };

  /** A chat whose latest turn carries `marks.now`, which a test clears as its next turn starts. */
  function marked(over: Partial<ChatReportBackDeps> = {}) {
    const marks: { now: Record<string, unknown> } = { now: WIFI };
    return {
      marks,
      deps: { marksOfTurn: () => marks.now, ...over } as Partial<ChatReportBackDeps>,
    };
  }

  it('sends the marks to a chat parent on every try, whatever the chat runs meanwhile', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('no'))
      .mockResolvedValue({ messageId: 'r1', chatId: PARENT, status: 'working' });
    const { marks, deps } = marked({
      service: { send },
      delay: async (ms) => {
        if (ms !== REPORT_SETTLE_MS) marks.now = {};
      },
    });
    await harness(deps).end();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].marksAtTurnEnd).toEqual(WIFI);
    expect(send.mock.calls[1]![0].marksAtTurnEnd).toEqual(WIFI);
  });

  it('sends the marks to a room seat on every try', async () => {
    const toRoomSeat = vi
      .fn()
      .mockRejectedValueOnce(new Error('did not reach'))
      .mockResolvedValue(true);
    const { marks, deps } = marked({
      toRoomSeat,
      delay: async (ms) => {
        if (ms !== REPORT_SETTLE_MS) marks.now = {};
      },
    });
    await harness(deps).end();
    expect(toRoomSeat).toHaveBeenCalledTimes(2);
    expect(toRoomSeat.mock.calls[1]![1].marks).toEqual(WIFI);
  });

  it('reads them as the turn ends, before the settle lets the next turn start', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'r1', chatId: PARENT, status: 'working' });
    const { marks, deps } = marked({
      service: { send },
      delay: async () => {
        marks.now = {};
      },
    });
    await harness(deps).end();
    expect(send.mock.calls[0]![0].marksAtTurnEnd).toEqual(WIFI);
  });

  it('keeps them on a waiting report, and joins them with a later turn’s', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'r1', chatId: PARENT, status: 'working' });
    const rechecks: Array<() => void> = [];
    let holds = true;
    const { marks, deps } = marked({
      service: { send },
      holdsBackgroundWork: async () => holds,
      later: (_ms, run) => {
        rechecks.push(run);
      },
    });
    const { reportBack, end } = harness(deps);
    await end();
    // The next turn starts unmarked, ends still holding, and then the work is released.
    marks.now = {};
    await reportBack.onTurnEnd(CHILD, status(), { from: NOW + 1_000, to: NOW + 2_000 });
    holds = false;
    rechecks.at(-1)!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].marksAtTurnEnd).toEqual(WIFI);
  });

  it('keeps them on a "needs the person" report too', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'r1', chatId: PARENT, status: 'working' });
    const { marks, deps } = marked({
      service: { send },
      statusOf: () => status({ lifecycle: 'blocked' }),
      delay: async () => {
        marks.now = {};
      },
    });
    await harness(deps).reportBack.onWaiting(CHILD, { key: 'w-marks', what: 'It asks.' });
    expect(send.mock.calls[0]![0].marksAtTurnEnd).toEqual(WIFI);
  });
});

describe('a report that cannot be delivered (DOR-3720)', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it('is logged and tried again until it lands', async () => {
    const waits: number[] = [];
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('no'))
      .mockRejectedValueOnce(new Error('still no'))
      .mockResolvedValue({ messageId: 'r1', chatId: PARENT, status: 'working' });
    const { end } = harness({
      service: { send },
      delay: async (ms) => {
        waits.push(ms);
      },
    });
    await end();
    expect(send).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([REPORT_SETTLE_MS, DELIVERY_RETRY_MS[0], DELIVERY_RETRY_MS[1]]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('retries a room seat too, and ends in one error line when it never lands', async () => {
    const toRoomSeat = vi.fn().mockRejectedValue(new Error('did not reach'));
    const { end, send } = harness({ toRoomSeat });
    await end();
    expect(toRoomSeat).toHaveBeenCalledTimes(DELIVERY_RETRY_MS.length + 1);
    expect(send).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error).mock.calls[0]![1]).toMatchObject({
      sessionId: CHILD,
      parent: PARENT,
    });
  });

  it('a chat with no agent home yet is tried again, never dropped without a word', async () => {
    const agentPathOf = vi.fn().mockResolvedValueOnce(null).mockResolvedValue('/agents/builder');
    const { end, send } = harness({ agentPathOf });
    await end();
    expect(send).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('reads the parent afresh on each try: a seat that moved meanwhile gets the report', async () => {
    let parent = PARENT;
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        parent = 'moved-seat';
        throw new Error('That chat belongs to a room');
      })
      .mockResolvedValue({ messageId: 'r1', chatId: 'moved-seat', status: 'working' });
    const { end } = harness({
      service: { send },
      reportTargetOf: () => ({ parentSessionId: parent }),
    });
    await end();
    expect(send.mock.calls[1]![1].to).toBe('moved-seat');
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
      later: () => {},
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
