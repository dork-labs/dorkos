import { describe, it, expect, vi } from 'vitest';
import { createStreamEventHandler } from '../stream/stream-event-handler';
import type {
  MessagePart,
  BackgroundTaskPart,
  SessionStatusEvent,
  TaskUpdateEvent,
} from '@dorkos/shared/types';

function createMinimalDeps() {
  const currentPartsRef = { current: [] as MessagePart[] };
  const assistantCreatedRef = { current: false };
  const sessionStatusRef = { current: null as SessionStatusEvent | null };
  const streamStartTimeRef = { current: null as number | null };
  const estimatedTokensRef = { current: 0 };
  const textStreamingTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
  const isTextStreamingRef = { current: false };
  const thinkingStartRef = { current: null as number | null };
  const setMessages = vi.fn();
  const orphanHooksRef = { current: new Map() };
  const onTaskEventRef = { current: undefined as ((event: TaskUpdateEvent) => void) | undefined };

  const handler = createStreamEventHandler({
    currentPartsRef,
    orphanHooksRef,
    assistantCreatedRef,
    sessionStatusRef,
    streamStartTimeRef,
    estimatedTokensRef,
    textStreamingTimerRef,
    isTextStreamingRef,
    thinkingStartRef,
    setMessages,
    setError: vi.fn(),
    setStatus: vi.fn(),
    setSessionStatus: vi.fn(),
    setEstimatedTokens: vi.fn(),
    setStreamStartTime: vi.fn(),
    setIsTextStreaming: vi.fn(),
    setRateLimitRetryAfter: vi.fn(),
    setIsRateLimited: vi.fn(),
    setSystemStatus: vi.fn(),
    setPromptSuggestions: vi.fn(),
    rateLimitClearRef: { current: null },
    sessionId: 'test-session',
    onTaskEventRef,
    onSessionIdChangeRef: { current: undefined },
    onStreamingDoneRef: { current: undefined },
    themeRef: { current: vi.fn() },
    scrollToMessageRef: { current: undefined },
    switchAgentRef: { current: undefined },
  });

  return { handler, currentPartsRef };
}

/** Find the background_task part for a given taskId in the current parts. */
function getTask(parts: MessagePart[], taskId: string): BackgroundTaskPart | undefined {
  return parts.find(
    (p): p is BackgroundTaskPart => p.type === 'background_task' && p.taskId === taskId
  );
}

describe('stream-event-handler — subagent_text_delta', () => {
  it('appends forwarded text to the task matched by parentToolUseId → toolUseId', () => {
    const { handler, currentPartsRef } = createMinimalDeps();

    handler(
      'background_task_started',
      { taskId: 'task-1', taskType: 'agent', startedAt: 0, toolUseId: 'toolu_1' },
      'asst-1'
    );
    handler('subagent_text_delta', { parentToolUseId: 'toolu_1', text: 'Reading ' }, 'asst-1');
    handler('subagent_text_delta', { parentToolUseId: 'toolu_1', text: 'the code' }, 'asst-1');

    expect(getTask(currentPartsRef.current, 'task-1')?.subagentText).toBe('Reading the code');
  });

  it('routes deltas to the correct task when multiple subagents run concurrently', () => {
    const { handler, currentPartsRef } = createMinimalDeps();

    handler(
      'background_task_started',
      { taskId: 'task-a', taskType: 'agent', startedAt: 0, toolUseId: 'toolu_a' },
      'asst-1'
    );
    handler(
      'background_task_started',
      { taskId: 'task-b', taskType: 'agent', startedAt: 0, toolUseId: 'toolu_b' },
      'asst-1'
    );
    handler('subagent_text_delta', { parentToolUseId: 'toolu_b', text: 'B output' }, 'asst-1');
    handler('subagent_text_delta', { parentToolUseId: 'toolu_a', text: 'A output' }, 'asst-1');

    expect(getTask(currentPartsRef.current, 'task-a')?.subagentText).toBe('A output');
    expect(getTask(currentPartsRef.current, 'task-b')?.subagentText).toBe('B output');
  });

  it('drops deltas with an unknown parentToolUseId without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler, currentPartsRef } = createMinimalDeps();

    handler(
      'background_task_started',
      { taskId: 'task-1', taskType: 'agent', startedAt: 0, toolUseId: 'toolu_1' },
      'asst-1'
    );
    handler('subagent_text_delta', { parentToolUseId: 'toolu_unknown', text: 'orphan' }, 'asst-1');

    expect(getTask(currentPartsRef.current, 'task-1')?.subagentText).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
