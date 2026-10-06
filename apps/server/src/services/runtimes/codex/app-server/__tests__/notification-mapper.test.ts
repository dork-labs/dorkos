import { describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { StreamEventSchema } from '@dorkos/shared/schemas';
import { createCodexEventContext } from '../../event-mapper.js';
import {
  AppServerTurnMapper,
  CODEX_STOPPED_COPY,
  NOTIFICATION_DISPOSITION,
} from '../notification-mapper.js';
import { mergeRateLimits, rateLimitsToRolloutShape } from '../rate-limits.js';
import { SERVER_NOTIFICATION_METHODS } from '../protocol/methods.js';

vi.mock('../../account-usage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../account-usage.js')>()),
  noteCodexTurnUsage: vi.fn(() => null),
}));
import { noteCodexTurnUsage } from '../../account-usage.js';

const T = { threadId: 'th', turnId: 'tu' };
const n = (method: string, params: Record<string, unknown> = {}) => ({
  method,
  params: { ...T, ...params },
});
function mapper(rateLimits?: () => unknown[]) {
  return new AppServerTurnMapper(createCodexEventContext('s1'), rateLimits ? { rateLimits } : {});
}
function all(m: AppServerTurnMapper, notifications: Array<ReturnType<typeof n>>): StreamEvent[] {
  const events = notifications.flatMap((notification) => m.map(notification));
  for (const event of events) StreamEventSchema.parse(event);
  return events;
}
const completed = (status = 'completed', error: unknown = null) =>
  n('turn/completed', { turn: { id: 'tu', status, items: [], error } });

describe('dispositions', () => {
  it('names every notification the binary can send', () => {
    expect(Object.keys(NOTIFICATION_DISPOSITION).sort()).toEqual(
      [...SERVER_NOTIFICATION_METHODS].sort()
    );
  });
});

describe('text', () => {
  it('streams agent deltas and adds only the tail the deltas missed', () => {
    const m = mapper();
    const events = all(m, [
      n('item/agentMessage/delta', { itemId: 'a', delta: 'Hel' }),
      n('item/agentMessage/delta', { itemId: 'a', delta: 'lo' }),
      n('item/completed', { item: { type: 'agentMessage', id: 'a', text: 'Hello world' } }),
      n('item/completed', { item: { type: 'agentMessage', id: 'b', text: 'Whole' } }),
      n('item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'think', summaryIndex: 0 }),
    ]);
    expect(events).toEqual([
      { type: 'text_delta', data: { text: 'Hel' } },
      { type: 'text_delta', data: { text: 'lo' } },
      { type: 'text_delta', data: { text: ' world' } },
      { type: 'text_delta', data: { text: 'Whole' } },
      { type: 'thinking_delta', data: { text: 'think' } },
    ]);
  });
});

describe('tools', () => {
  it('maps a command to the Shell tool with progress and its result', () => {
    const events = all(mapper(), [
      n('item/started', {
        item: {
          type: 'commandExecution',
          id: 'c',
          command: 'ls',
          cwd: '/p',
          status: 'inProgress',
          processId: null,
        },
      }),
      n('item/commandExecution/outputDelta', { itemId: 'c', delta: 'a\n' }),
      n('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'c',
          command: 'ls',
          cwd: '/p',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: 'a\n',
        },
      }),
    ]);
    expect(events.map((e) => e.type)).toEqual([
      'tool_call_start',
      'tool_progress',
      'tool_call_end',
      'tool_result',
    ]);
    expect(events[0]).toMatchObject({ data: { toolCallId: 'c', toolName: 'Shell' } });
    expect(events[3]).toMatchObject({ data: { result: 'a\n', status: 'complete' } });
  });

  it('says a declined command was not allowed, and a failed one errored', () => {
    const declined = all(mapper(), [
      n('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'd',
          command: 'rm -rf /',
          status: 'declined',
          exitCode: null,
        },
      }),
    ]);
    expect(declined.at(-1)).toMatchObject({
      type: 'tool_result',
      data: { status: 'error', result: 'Codex was not allowed to run this command.' },
    });
  });

  it('maps file changes, MCP calls and web searches with exec’s names', () => {
    const events = all(mapper(), [
      n('item/completed', {
        item: {
          type: 'fileChange',
          id: 'f',
          status: 'completed',
          changes: [{ path: 'a.ts', kind: { type: 'add' }, diff: '' }],
        },
      }),
      n('item/started', {
        item: {
          type: 'mcpToolCall',
          id: 'm',
          server: 'dorkos',
          tool: 'post',
          status: 'inProgress',
          arguments: { x: 1 },
        },
      }),
      n('item/mcpToolCall/progress', { itemId: 'm', message: 'halfway' }),
      n('item/completed', {
        item: {
          type: 'mcpToolCall',
          id: 'm',
          server: 'dorkos',
          tool: 'post',
          status: 'completed',
          arguments: { x: 1 },
          result: { content: [{ type: 'text', text: 'posted' }] },
          error: null,
        },
      }),
      n('item/started', { item: { type: 'webSearch', id: 'w', query: 'q' } }),
      n('item/completed', { item: { type: 'webSearch', id: 'w', query: 'q' } }),
    ]);
    const names = events
      .filter((e) => e.type === 'tool_call_start')
      .map((e) => (e.data as { toolName: string }).toolName);
    expect(names).toEqual(['ApplyPatch', 'mcp__dorkos__post', 'WebSearch']);
    expect(events).toContainEqual({
      type: 'tool_result',
      data: { toolCallId: 'f', toolName: 'ApplyPatch', result: 'add a.ts', status: 'complete' },
    });
    expect(events).toContainEqual({
      type: 'tool_progress',
      data: { toolCallId: 'm', content: 'halfway' },
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      data: {
        toolCallId: 'm',
        toolName: 'mcp__dorkos__post',
        result: 'posted',
        status: 'complete',
      },
    });
  });

  it('records an MCP image for the runtime to store', () => {
    const ctx = createCodexEventContext('s1');
    const m = new AppServerTurnMapper(ctx);
    m.map(
      n('item/completed', {
        item: {
          type: 'mcpToolCall',
          id: 'm',
          server: 's',
          tool: 't',
          status: 'completed',
          arguments: {},
          result: { content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] },
          error: null,
        },
      })
    );
    expect(ctx.pendingMedia).toHaveLength(1);
  });

  it('turns a plan into a task snapshot and sub-agents into background tasks', () => {
    const events = all(mapper(), [
      n('turn/plan/updated', {
        explanation: null,
        plan: [
          { step: 'one', status: 'completed' },
          { step: 'two', status: 'inProgress' },
          { step: 'three', status: 'pending' },
        ],
      }),
      n('item/completed', {
        item: {
          type: 'subAgentActivity',
          id: 's',
          kind: 'started',
          agentThreadId: 'ag',
          agentPath: 'helper',
        },
      }),
      n('item/completed', {
        item: {
          type: 'subAgentActivity',
          id: 's2',
          kind: 'completed',
          agentThreadId: 'ag',
          agentPath: 'helper',
        },
      }),
    ]);
    expect(events[0]).toMatchObject({
      type: 'task_update',
      data: {
        action: 'snapshot',
        tasks: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }],
      },
    });
    expect(events[1]).toMatchObject({
      type: 'background_task_started',
      data: { taskId: 'ag', taskType: 'agent' },
    });
    expect(events[2]).toEqual({
      type: 'background_task_done',
      data: { taskId: 'ag', status: 'completed' },
    });
  });
});

describe('terminals — exactly one done', () => {
  it('completes with the context reading and usage from thread/tokenUsage/updated', () => {
    const m = mapper();
    const breakdown = (total: number, out: number) => ({
      totalTokens: total,
      inputTokens: total - out,
      cachedInputTokens: 7,
      cacheWriteInputTokens: 0,
      outputTokens: out,
      reasoningOutputTokens: 3,
    });
    const events = all(m, [
      n('thread/tokenUsage/updated', {
        tokenUsage: {
          total: breakdown(9000, 100),
          last: breakdown(1500, 20),
          modelContextWindow: 200000,
        },
      }),
      completed(),
      n('item/agentMessage/delta', { itemId: 'late', delta: 'after the end' }),
    ]);
    expect(events).toEqual([
      {
        type: 'session_status',
        data: {
          sessionId: 's1',
          contextTokens: 1500,
          contextMaxTokens: 200000,
          outputTokens: 103,
          cacheReadTokens: 7,
          terminalReason: 'completed',
        },
      },
      { type: 'done', data: { sessionId: 's1' } },
    ]);
    expect(m.isFinished).toBe(true);
  });

  it('ends an interrupted turn quietly', () => {
    expect(all(mapper(), [completed('interrupted')])).toEqual([
      { type: 'done', data: { sessionId: 's1' } },
    ]);
  });

  it('ends a failed turn with one error, sign-in copy for unauthorized, and the usage limit noted', () => {
    const auth = all(mapper(), [
      n('error', {
        error: { message: '401 Unauthorized', codexErrorInfo: 'unauthorized' },
        willRetry: false,
      }),
      completed('failed', { message: '401 Unauthorized', codexErrorInfo: 'unauthorized' }),
    ]);
    expect(auth.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(auth.find((e) => e.type === 'error')).toMatchObject({
      data: { category: 'auth_error', details: '401 Unauthorized' },
    });
    expect(auth.at(-1)).toEqual({ type: 'done', data: { sessionId: 's1' } });

    vi.mocked(noteCodexTurnUsage).mockClear();
    all(
      mapper(() => [{ limit_id: 'codex' }]),
      [
        completed('failed', {
          message: "You've hit your usage limit.",
          codexErrorInfo: 'usageLimitExceeded',
        }),
      ]
    );
    expect(noteCodexTurnUsage).toHaveBeenCalledWith(
      expect.anything(),
      [{ limit_id: 'codex' }],
      true,
      expect.any(Date)
    );
  });

  it('turns a retrying error into a status, not a failure', () => {
    expect(
      all(mapper(), [n('error', { error: { message: 'reconnecting' }, willRetry: true })])
    ).toEqual([{ type: 'system_status', data: { message: 'Codex is retrying: reconnecting' } }]);
  });

  it('reports background commands still running at the end', () => {
    const events = all(mapper(), [
      n('item/started', {
        item: {
          type: 'commandExecution',
          id: 'bg',
          command: 'sleep 20',
          status: 'inProgress',
          processId: 'p1',
        },
      }),
      completed(),
    ]);
    expect(events.find((e) => e.type === 'background_task_started')).toMatchObject({
      data: { taskId: 'bg', taskType: 'bash', command: 'sleep 20' },
    });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('ends with an honest error and one done when Codex stopped, and only once', () => {
    const m = mapper();
    expect(m.closeOnCrash('exit code 137')).toEqual([
      { type: 'session_status', data: { sessionId: 's1', terminalReason: 'error' } },
      {
        type: 'error',
        data: { message: CODEX_STOPPED_COPY, code: 'codex_stopped', details: 'exit code 137' },
      },
      { type: 'done', data: { sessionId: 's1' } },
    ]);
    expect(m.closeOnCrash('again')).toEqual([]);
    expect(m.closeQuietly()).toEqual([]);
    expect(m.map(completed())).toEqual([]);
  });
});

describe('rate limits', () => {
  it('reshapes an app-server snapshot into the rollout shape codexObservations reads', () => {
    expect(
      rateLimitsToRolloutShape({
        limitId: 'codex',
        limitName: null,
        planType: 'pro',
        rateLimitReachedType: null,
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1900000000 },
        secondary: null,
        credits: { hasCredits: true, unlimited: false, balance: '5' },
      })
    ).toEqual({
      limit_id: 'codex',
      limit_name: null,
      plan_type: 'pro',
      rate_limit_reached_type: null,
      primary: { used_percent: 12, window_minutes: 300, resets_at: 1900000000 },
      secondary: null,
      credits: { has_credits: true, unlimited: false, balance: '5' },
    });
  });

  it('merges a sparse update into the last reading without clearing what it leaves out', () => {
    const merged = mergeRateLimits(
      { limitId: 'codex', planType: 'pro', primary: { usedPercent: 1 } },
      {
        limitId: null,
        planType: null,
        primary: { usedPercent: 40 },
      }
    );
    expect(merged).toEqual({ limitId: 'codex', planType: 'pro', primary: { usedPercent: 40 } });
  });
});

describe('compaction (DOR-2732)', () => {
  const usage = (last: number) =>
    n('thread/tokenUsage/updated', {
      tokenUsage: {
        total: {
          totalTokens: 90_000,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: last,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 200_000,
      },
    });
  const item = { type: 'contextCompaction', id: 'c1' };

  it('reports a compaction Codex runs inside a turn as auto, with the sizes either side', () => {
    const events = all(mapper(), [
      usage(180_000),
      n('item/started', { item, startedAtMs: 100 }),
      usage(20_000),
      n('item/completed', { item, completedAtMs: 600 }),
    ]);
    expect(events).toEqual([
      {
        type: 'operation_progress',
        data: {
          operation: 'compaction',
          state: 'started',
          determinate: false,
          message: 'Compacting context…',
        },
      },
      {
        type: 'operation_progress',
        data: { operation: 'compaction', state: 'done', determinate: false },
      },
      {
        type: 'compact_boundary',
        data: { trigger: 'auto', preTokens: 180_000, postTokens: 20_000, durationMs: 500 },
      },
    ]);
  });

  it('leaves out a size it has no reading for, rather than guessing', () => {
    const m = new AppServerTurnMapper(createCodexEventContext('s1'), { compaction: true });
    const events = all(m, [n('item/started', { item }), n('item/completed', { item })]);
    expect(events.at(-1)).toEqual({ type: 'compact_boundary', data: { trigger: 'manual' } });
  });

  it('draws one line when the deprecated thread/compacted comes too, in either order', () => {
    const before = all(mapper(), [
      n('item/started', { item }),
      n('thread/compacted'),
      n('item/completed', { item }),
    ]);
    const after = all(mapper(), [
      n('item/started', { item }),
      n('item/completed', { item }),
      n('thread/compacted'),
    ]);
    for (const events of [before, after]) {
      expect(events.filter((e) => e.type === 'compact_boundary')).toHaveLength(1);
    }
  });

  it('still draws the line from thread/compacted alone', () => {
    expect(all(mapper(), [n('thread/compacted')])).toEqual([
      { type: 'compact_boundary', data: { trigger: 'auto' } },
    ]);
  });

  it('resolves an unfinished compaction as failed when its turn fails, so the bar never stays open', () => {
    const events = all(mapper(), [
      n('item/started', { item }),
      completed('failed', { message: 'Error running remote compact task' }),
    ]);
    expect(events.filter((e) => e.type === 'operation_progress').at(-1)).toMatchObject({
      data: { state: 'failed', error: expect.any(String) },
    });
    expect(events.filter((e) => e.type === 'compact_boundary')).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('resolves an unfinished compaction as failed when the process goes away', () => {
    const m = mapper();
    all(m, [n('item/started', { item })]);
    const events = m.closeOnCrash('exit code 1');
    expect(events[0]).toMatchObject({
      type: 'operation_progress',
      data: { state: 'failed', error: CODEX_STOPPED_COPY },
    });
  });
});

describe('how full the conversation is', () => {
  it('RT-CMP-03: ends a reply with the context in use and the window, and leaves out a window Codex did not send', () => {
    const reading = (window: number | null) =>
      n('thread/tokenUsage/updated', {
        tokenUsage: {
          total: {
            totalTokens: 9_000,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 160_000,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: window,
        },
      });
    const status = (events: StreamEvent[]) =>
      events.find((event) => event.type === 'session_status')!.data as Record<string, unknown>;

    const known = status(all(mapper(), [reading(200_000), completed()]));
    expect(known).toMatchObject({ contextTokens: 160_000, contextMaxTokens: 200_000 });

    // No window, no reading: a gauge (and the 80% note) cannot be computed
    // from half of one, so neither half is reported.
    const unknown = status(all(mapper(), [reading(null), completed()]));
    expect(unknown).not.toHaveProperty('contextTokens');
    expect(unknown).not.toHaveProperty('contextMaxTokens');
  });
});
