import { describe, it, expect, vi } from 'vitest';
import { createStreamEventHandler } from '../stream-event-handler';
import type { MessagePart } from '@dorkos/shared/types';

function createMinimalDeps(overrides?: {
  sessionId?: string;
  onSessionIdChange?: ReturnType<typeof vi.fn>;
}) {
  const currentPartsRef = { current: [] as MessagePart[] };
  const assistantCreatedRef = { current: false };
  const sessionStatusRef = { current: null };
  const streamStartTimeRef = { current: null };
  const estimatedTokensRef = { current: 0 };
  const textStreamingTimerRef = { current: null };
  const isTextStreamingRef = { current: false };
  const setMessages = vi.fn();
  const setError = vi.fn();
  const setStatus = vi.fn();
  const setSessionStatus = vi.fn();
  const setEstimatedTokens = vi.fn();
  const setStreamStartTime = vi.fn();
  const setIsTextStreaming = vi.fn();
  const setRateLimitRetryAfter = vi.fn();
  const setIsRateLimited = vi.fn();
  const setSystemStatus = vi.fn();
  const rateLimitClearRef = { current: null };
  const orphanHooksRef = { current: new Map() };
  const onTaskEventRef = { current: undefined };
  const onSessionIdChangeFn = overrides?.onSessionIdChange ?? vi.fn();
  const onSessionIdChangeRef = {
    current: onSessionIdChangeFn as ((newSessionId: string) => void) | undefined,
  };
  const onStreamingDoneRef = { current: undefined };
  const thinkingStartRef = { current: null };
  const isRemappingRef = { current: false };

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
    setError,
    setStatus,
    setSessionStatus,
    setEstimatedTokens,
    setStreamStartTime,
    setIsTextStreaming,
    setRateLimitRetryAfter,
    setIsRateLimited,
    setSystemStatus,
    setPromptSuggestions: vi.fn(),
    rateLimitClearRef,
    sessionId: overrides?.sessionId ?? 'test-session',
    onTaskEventRef,
    onSessionIdChangeRef,
    onStreamingDoneRef,
    isRemappingRef,
    themeRef: { current: vi.fn() },
    scrollToMessageRef: { current: undefined },
    switchAgentRef: { current: undefined },
  });

  return {
    handler,
    currentPartsRef,
    orphanHooksRef,
    assistantCreatedRef,
    setMessages,
    onSessionIdChangeFn,
    onSessionIdChangeRef,
    isRemappingRef,
  };
}

describe('stream-event-handler — session remap on done event', () => {
  it('preserves messages and resets refs when done event carries a new sessionId', () => {
    // Purpose: Tagged-dedup handles ID reconciliation, so messages must stay on screen
    // during session remap. The old setMessages([]) caused a blank flash.
    const onSessionIdChangeFn = vi.fn();
    const { handler, currentPartsRef, assistantCreatedRef, setMessages, isRemappingRef } =
      createMinimalDeps({
        sessionId: 'client-uuid',
        onSessionIdChange: onSessionIdChangeFn,
      });

    currentPartsRef.current = [{ type: 'text', text: 'hello' } as MessagePart];
    assistantCreatedRef.current = true;

    handler('done', { sessionId: 'sdk-uuid' }, 'some-assistant-id');

    // Messages should NOT be cleared — tagged-dedup handles reconciliation
    const emptyArrayCalls = setMessages.mock.calls.filter(
      (call) => Array.isArray(call[0]) && call[0].length === 0
    );
    expect(emptyArrayCalls).toHaveLength(0);

    // isRemappingRef must be true so the session change effect skips clearing
    expect(isRemappingRef.current).toBe(true);

    // Refs are still reset
    expect(currentPartsRef.current).toEqual([]);
    expect(assistantCreatedRef.current).toBe(false);

    // Session change callback still fires
    expect(onSessionIdChangeFn).toHaveBeenCalledWith('sdk-uuid');
  });

  it('does not clear messages on done event when sessionId is unchanged', () => {
    // Purpose: Ensure the remap clear only triggers when sessionId actually changes.
    // Normal stream completion (no remap) must not wipe the message buffer.
    const onSessionIdChangeFn = vi.fn();
    const { handler, currentPartsRef, assistantCreatedRef, setMessages, isRemappingRef } =
      createMinimalDeps({
        sessionId: 'same-uuid',
        onSessionIdChange: onSessionIdChangeFn,
      });

    currentPartsRef.current = [{ type: 'text', text: 'hello' } as MessagePart];
    assistantCreatedRef.current = true;

    handler('done', { sessionId: 'same-uuid' }, 'some-assistant-id');

    const emptyArrayCalls = setMessages.mock.calls.filter(
      (call) => Array.isArray(call[0]) && call[0].length === 0
    );
    expect(emptyArrayCalls).toHaveLength(0);
    expect(onSessionIdChangeFn).not.toHaveBeenCalled();
    // isRemappingRef should remain false — no remap occurred
    expect(isRemappingRef.current).toBe(false);
  });
});

describe('stream-event-handler — client ID remap via done event messageIds', () => {
  it('calls setMessages with mapper when done event includes messageIds', () => {
    const { handler, setMessages } = createMinimalDeps({ sessionId: 'test-session' });

    handler(
      'done',
      {
        messageIds: { user: 'server-user-1', assistant: 'server-asst-1' },
      },
      'client-asst-id'
    );

    const mapperCalls = setMessages.mock.calls.filter((call) => typeof call[0] === 'function');
    expect(mapperCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('mapper remaps _streaming user message to server ID', () => {
    const { handler, setMessages } = createMinimalDeps({ sessionId: 'test-session' });

    handler(
      'done',
      {
        messageIds: { user: 'server-user-1', assistant: 'server-asst-1' },
      },
      'client-asst-id'
    );

    // Find the mapper call for messageIds remap and apply it
    const mapperCalls = setMessages.mock.calls.filter((call) => typeof call[0] === 'function');
    const mapper = mapperCalls[0][0] as (
      prev: { id: string; role: string; _streaming?: boolean }[]
    ) => { id: string; role: string; _streaming?: boolean }[];

    const prev = [
      { id: 'pending-user-uuid', role: 'user', _streaming: true },
      { id: 'pending-asst-uuid', role: 'assistant', _streaming: true },
    ];
    const result = mapper(prev);

    expect(result[0].id).toBe('server-user-1');
    expect(result[0]._streaming).toBe(false);
    expect(result[1].id).toBe('server-asst-1');
    expect(result[1]._streaming).toBe(false);
  });

  it('mapper leaves non-streaming messages unchanged', () => {
    const { handler, setMessages } = createMinimalDeps({ sessionId: 'test-session' });

    handler(
      'done',
      {
        messageIds: { user: 'server-user-1', assistant: 'server-asst-1' },
      },
      'client-asst-id'
    );

    const mapperCalls = setMessages.mock.calls.filter((call) => typeof call[0] === 'function');
    const mapper = mapperCalls[0][0] as (
      prev: { id: string; role: string; _streaming?: boolean }[]
    ) => { id: string; role: string; _streaming?: boolean }[];

    const prev = [{ id: 'stable-id', role: 'user', _streaming: false }];
    const result = mapper(prev);

    expect(result[0].id).toBe('stable-id');
  });

  it('does not call a messageIds mapper when messageIds is absent', () => {
    const { handler, setMessages } = createMinimalDeps({ sessionId: 'test-session' });

    handler('done', {}, 'client-asst-id');

    // The only function-form setMessages call should be the force-complete safety net,
    // not a messageIds mapper. Verify by applying the mapper — it should be a no-op
    // for messages without pending interactive tool calls.
    const mapperCalls = setMessages.mock.calls.filter((call) => typeof call[0] === 'function');
    // 1 call: force-complete safety net (no messageIds mapper)
    expect(mapperCalls).toHaveLength(1);
    // The safety net mapper is a no-op for normal messages (returns same reference)
    const safetyMapper = mapperCalls[0][0] as (
      prev: { id: string; role: string; toolCalls?: unknown[] }[]
    ) => unknown[];
    const prev = [{ id: 'msg-1', role: 'assistant', toolCalls: [] }];
    const result = safetyMapper(prev);
    expect(result[0]).toBe(prev[0]); // Same reference — no mutation
  });

  it('handles remap and messageIds together in one done event', () => {
    const onSessionIdChangeFn = vi.fn();
    const { handler, setMessages } = createMinimalDeps({
      sessionId: 'client-session',
      onSessionIdChange: onSessionIdChangeFn,
    });

    handler(
      'done',
      {
        sessionId: 'server-session',
        messageIds: { user: 'u1', assistant: 'a1' },
      },
      'client-asst-id'
    );

    // Session callback fires
    expect(onSessionIdChangeFn).toHaveBeenCalledWith('server-session');

    // messageIds mapper also applied
    const mapperCalls = setMessages.mock.calls.filter((call) => typeof call[0] === 'function');
    expect(mapperCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('stream-event-handler — force-complete pending interactive tool calls on done', () => {
  it('force-completes pending interactive tool calls in done handler', () => {
    const { handler, setMessages } = createMinimalDeps({ sessionId: 'test-session' });

    handler('done', {}, 'asst-1');

    // Find the force-complete safety net mapper
    const mapperCalls = setMessages.mock.calls.filter((call) => typeof call[0] === 'function');
    expect(mapperCalls.length).toBeGreaterThanOrEqual(1);

    const safetyMapper = mapperCalls[mapperCalls.length - 1][0] as (prev: unknown[]) => unknown[];

    const prev = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool_call',
            toolCallId: 'tc-1',
            toolName: 'AskUserQuestion',
            input: '',
            status: 'pending',
            interactiveType: 'question',
          },
        ],
        toolCalls: [
          {
            toolCallId: 'tc-1',
            toolName: 'AskUserQuestion',
            input: '',
            status: 'pending',
            interactiveType: 'question',
          },
        ],
        timestamp: '2026-01-01T00:00:00Z',
      },
    ];

    const result = safetyMapper(prev) as typeof prev;
    expect(result[0].toolCalls[0].status).toBe('complete');
    expect(result[0].parts[0].status).toBe('complete');
  });

  it('force-completes pending interactive tool calls during remap', () => {
    const onSessionIdChangeFn = vi.fn();
    const { handler, setMessages } = createMinimalDeps({
      sessionId: 'client-uuid',
      onSessionIdChange: onSessionIdChangeFn,
    });

    handler('done', { sessionId: 'server-uuid' }, 'asst-1');

    // Find the force-complete mapper (last function-form call)
    const mapperCalls = setMessages.mock.calls.filter((call) => typeof call[0] === 'function');
    const safetyMapper = mapperCalls[mapperCalls.length - 1][0] as (prev: unknown[]) => unknown[];

    const prev = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool_call',
            toolCallId: 'tc-1',
            toolName: 'AskUserQuestion',
            input: '',
            status: 'pending',
            interactiveType: 'question',
          },
        ],
        toolCalls: [
          {
            toolCallId: 'tc-1',
            toolName: 'AskUserQuestion',
            input: '',
            status: 'pending',
            interactiveType: 'question',
          },
        ],
        timestamp: '2026-01-01T00:00:00Z',
      },
    ];

    const result = safetyMapper(prev) as typeof prev;
    expect(result[0].toolCalls[0].status).toBe('complete');
    expect(result[0].parts[0].status).toBe('complete');
  });

  it('preserves messages without pending interactive tool calls (referential identity)', () => {
    const { handler, setMessages } = createMinimalDeps({ sessionId: 'test-session' });

    handler('done', {}, 'asst-1');

    const mapperCalls = setMessages.mock.calls.filter((call) => typeof call[0] === 'function');
    const safetyMapper = mapperCalls[mapperCalls.length - 1][0] as (prev: unknown[]) => unknown[];

    const msg = {
      id: 'msg-1',
      role: 'assistant',
      content: 'hello',
      parts: [{ type: 'text', text: 'hello' }],
      toolCalls: [{ toolCallId: 'tc-1', toolName: 'Read', input: '', status: 'complete' }],
      timestamp: '2026-01-01T00:00:00Z',
    };
    const prev = [msg];
    const result = safetyMapper(prev) as typeof prev;
    // No pending interactive tool calls — same reference returned
    expect(result[0]).toBe(msg);
  });
});
