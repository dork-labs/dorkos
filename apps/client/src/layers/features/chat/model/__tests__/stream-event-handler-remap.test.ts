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
  const rateLimitClearRef = { current: null };
  const onTaskEventRef = { current: undefined };
  const onSessionIdChangeFn = overrides?.onSessionIdChange ?? vi.fn();
  const onSessionIdChangeRef = { current: onSessionIdChangeFn as ((newSessionId: string) => void) | undefined };
  const onStreamingDoneRef = { current: undefined };

  const handler = createStreamEventHandler({
    currentPartsRef,
    assistantCreatedRef,
    sessionStatusRef,
    streamStartTimeRef,
    estimatedTokensRef,
    textStreamingTimerRef,
    isTextStreamingRef,
    setMessages,
    setError,
    setStatus,
    setSessionStatus,
    setEstimatedTokens,
    setStreamStartTime,
    setIsTextStreaming,
    setRateLimitRetryAfter,
    setIsRateLimited,
    rateLimitClearRef,
    sessionId: overrides?.sessionId ?? 'test-session',
    onTaskEventRef,
    onSessionIdChangeRef,
    onStreamingDoneRef,
  });

  return {
    handler,
    currentPartsRef,
    assistantCreatedRef,
    setMessages,
    onSessionIdChangeFn,
    onSessionIdChangeRef,
  };
}

describe('stream-event-handler — session remap on done event', () => {
  it('clears messages and resets refs when done event carries a new sessionId', () => {
    // Purpose: Regression for Bug #1 — when the server remaps the session UUID in the
    // done event, the client must clear the streaming buffer so history is the sole
    // source of truth. Without this, the streaming assistant message (client UUID) and
    // the history copy (SDK UUID) both render, creating a duplicate.
    const onSessionIdChangeFn = vi.fn();
    const { handler, currentPartsRef, assistantCreatedRef, setMessages } = createMinimalDeps({
      sessionId: 'client-uuid',
      onSessionIdChange: onSessionIdChangeFn,
    });

    currentPartsRef.current = [{ type: 'text', text: 'hello' } as MessagePart];
    assistantCreatedRef.current = true;

    handler('done', { sessionId: 'sdk-uuid' }, 'some-assistant-id');

    expect(setMessages).toHaveBeenCalledWith([]);
    expect(currentPartsRef.current).toEqual([]);
    expect(assistantCreatedRef.current).toBe(false);
    expect(onSessionIdChangeFn).toHaveBeenCalledWith('sdk-uuid');

    const setMessagesOrder = setMessages.mock.invocationCallOrder[0];
    const onChangeFnOrder = onSessionIdChangeFn.mock.invocationCallOrder[0];
    expect(setMessagesOrder).toBeLessThan(onChangeFnOrder);
  });

  it('does not clear messages on done event when sessionId is unchanged', () => {
    // Purpose: Ensure the remap clear only triggers when sessionId actually changes.
    // Normal stream completion (no remap) must not wipe the message buffer.
    const onSessionIdChangeFn = vi.fn();
    const { handler, currentPartsRef, assistantCreatedRef, setMessages } = createMinimalDeps({
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
  });
});
