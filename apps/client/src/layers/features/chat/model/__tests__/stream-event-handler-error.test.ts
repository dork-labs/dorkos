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
    sessionId: 'test-session',
    onTaskEventRef,
    onSessionIdChangeRef,
    onStreamingDoneRef,
    isRemappingRef: { current: false },
    themeRef: { current: vi.fn() },
    scrollToMessageRef: { current: undefined },
    switchAgentRef: { current: undefined },
  });

  return { handler, currentPartsRef, setMessages, setError, setStatus };
}

describe('stream-event-handler — error events', () => {
  it('categorized error appends ErrorPart to message parts without killing streaming status', () => {
    // Purpose: SDK result errors with a category should render inline in the message stream
    // rather than using the error banner, so they persist in scroll history.
    // Critically, they must NOT set status to 'error' — the stream may continue
    // after SDK recovery, and inference indicators should remain visible.
    const { handler, currentPartsRef, setError, setStatus } = createMinimalDeps();

    handler(
      'error',
      {
        message: 'Turn limit reached',
        code: 'error_max_turns',
        category: 'max_turns',
        details: 'Reached 10 turn limit',
      },
      'asst-1'
    );

    const errorPart = currentPartsRef.current.find((p) => p.type === 'error');
    expect(errorPart).toBeDefined();
    expect(errorPart!.type).toBe('error');
    if (errorPart!.type === 'error') {
      expect(errorPart!.message).toBe('Turn limit reached');
      expect(errorPart!.category).toBe('max_turns');
      expect(errorPart!.details).toBe('Reached 10 turn limit');
    }
    // Should NOT set banner error for categorized errors
    expect(setError).not.toHaveBeenCalled();
    // Should NOT kill streaming status — stream continues after inline errors
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('uncategorized error sets banner error state', () => {
    // Purpose: Transport-level errors (no category) should use the existing error banner,
    // not the inline message stream.
    const { handler, currentPartsRef, setError, setStatus } = createMinimalDeps();

    handler(
      'error',
      {
        message: 'Network connection lost',
      },
      'asst-1'
    );

    // Should set banner error
    expect(setError).toHaveBeenCalledWith({
      heading: 'Error',
      message: 'Network connection lost',
      retryable: false,
    });
    expect(setStatus).toHaveBeenCalledWith('error');
    // Should NOT append to parts
    expect(currentPartsRef.current.find((p) => p.type === 'error')).toBeUndefined();
  });

  it('categorized error triggers assistant message creation', () => {
    // Purpose: The error part must be visible in the assistant message, which means
    // ensureAssistantMessage + updateAssistantMessage must be called.
    const { handler, setMessages } = createMinimalDeps();

    handler(
      'error',
      {
        message: 'Budget exceeded',
        category: 'budget_exceeded',
      },
      'asst-1'
    );

    // setMessages should have been called (ensureAssistantMessage + updateAssistantMessage)
    expect(setMessages).toHaveBeenCalled();
  });
});
