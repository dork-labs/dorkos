import { describe, it, expect, vi } from 'vitest';
import type { MessagePart, SessionStatusEvent, TaskUpdateEvent } from '@dorkos/shared/types';
import { createStreamEventHandler } from '../stream-event-handler';

function createMinimalDeps() {
  const currentPartsRef = { current: [] as MessagePart[] };
  const assistantCreatedRef = { current: false };
  const sessionStatusRef = { current: null as SessionStatusEvent | null };
  const streamStartTimeRef = { current: null as number | null };
  const estimatedTokensRef = { current: 0 };
  const textStreamingTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
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
  const thinkingStartRef = { current: null };
  const onTaskEventRef = { current: undefined as ((event: TaskUpdateEvent) => void) | undefined };
  const onSessionIdChangeRef = {
    current: undefined as ((newSessionId: string) => void) | undefined,
  };
  const onStreamingDoneRef = { current: undefined as (() => void) | undefined };

  const handler = createStreamEventHandler({
    currentPartsRef,
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
    orphanHooksRef,
    sessionId: 'test-session',
    onTaskEventRef,
    onSessionIdChangeRef,
    onStreamingDoneRef,
    isRemappingRef: { current: false },
    themeRef: { current: vi.fn() },
    scrollToMessageRef: { current: undefined },
    switchAgentRef: { current: undefined },
  });

  return { handler, setMessages, setSystemStatus, setStatus };
}

describe('stream-event-handler — system_status events', () => {
  it('calls setSystemStatus with the message text', () => {
    const { handler, setSystemStatus } = createMinimalDeps();

    handler('system_status', { message: 'Compacting context...' }, 'asst-1');

    expect(setSystemStatus).toHaveBeenCalledWith('Compacting context...');
  });
});

describe('stream-event-handler — compact_boundary events', () => {
  it('injects a compaction ChatMessage into messages', () => {
    const { handler, setMessages } = createMinimalDeps();

    handler('compact_boundary', {}, 'asst-1');

    expect(setMessages).toHaveBeenCalled();
    const updater = setMessages.mock.calls[0][0];
    const result = updater([]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'user',
      content: '',
      parts: [],
      messageType: 'compaction',
    });
    expect(result[0].id).toMatch(/^compaction-/);
  });
});

describe('stream-event-handler — done clears systemStatus', () => {
  it('clears systemStatus on done event', () => {
    const { handler, setSystemStatus } = createMinimalDeps();

    handler('done', {}, 'asst-1');

    expect(setSystemStatus).toHaveBeenCalledWith(null);
  });
});
