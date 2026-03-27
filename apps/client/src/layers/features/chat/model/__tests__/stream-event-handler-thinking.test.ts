import { describe, it, expect, vi } from 'vitest';
import { createStreamEventHandler } from '../stream-event-handler';
import type { MessagePart, SessionStatusEvent, TaskUpdateEvent } from '@dorkos/shared/types';

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

  return { handler, currentPartsRef, thinkingStartRef, setMessages };
}

describe('stream-event-handler — thinking_delta', () => {
  it('creates a ThinkingPart on first thinking_delta', () => {
    // Purpose: The first thinking_delta should create a new thinking part
    // with isStreaming: true and record the start time.
    const { handler, currentPartsRef, thinkingStartRef } = createMinimalDeps();

    handler('thinking_delta', { text: 'Let me think...' }, 'asst-1');

    expect(currentPartsRef.current).toHaveLength(1);
    expect(currentPartsRef.current[0].type).toBe('thinking');
    if (currentPartsRef.current[0].type === 'thinking') {
      expect(currentPartsRef.current[0].text).toBe('Let me think...');
      expect(currentPartsRef.current[0].isStreaming).toBe(true);
    }
    expect(thinkingStartRef.current).toBeGreaterThan(0);
  });

  it('appends text to existing thinking part on subsequent deltas', () => {
    // Purpose: Subsequent thinking_delta events should concatenate text
    // to the existing thinking part rather than creating new parts.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler('thinking_delta', { text: 'First ' }, 'asst-1');
    handler('thinking_delta', { text: 'thought' }, 'asst-1');

    expect(currentPartsRef.current).toHaveLength(1);
    if (currentPartsRef.current[0].type === 'thinking') {
      expect(currentPartsRef.current[0].text).toBe('First thought');
    }
  });

  it('finalizes thinking on first text_delta with elapsed time', () => {
    // Purpose: When the model transitions from thinking to text output,
    // the thinking part should be marked as complete with elapsed time.
    const { handler, currentPartsRef, thinkingStartRef } = createMinimalDeps();

    // Simulate a known start time for deterministic elapsed time
    handler('thinking_delta', { text: 'reasoning' }, 'asst-1');
    thinkingStartRef.current = Date.now() - 5000; // 5 seconds ago

    handler('text_delta', { text: 'Here is the answer' }, 'asst-1');

    const thinkingPart = currentPartsRef.current[0];
    expect(thinkingPart.type).toBe('thinking');
    if (thinkingPart.type === 'thinking') {
      expect(thinkingPart.isStreaming).toBe(false);
      expect(thinkingPart.elapsedMs).toBeGreaterThanOrEqual(4900); // ~5000ms
      expect(thinkingPart.elapsedMs).toBeLessThan(6000);
    }

    // thinkingStartRef should be cleared
    expect(thinkingStartRef.current).toBeNull();
  });

  it('preserves part ordering: thinking → text', () => {
    // Purpose: The parts array should maintain correct ordering when
    // transitioning from thinking to text output.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler('thinking_delta', { text: 'thinking content' }, 'asst-1');
    handler('text_delta', { text: 'visible text' }, 'asst-1');

    expect(currentPartsRef.current).toHaveLength(2);
    expect(currentPartsRef.current[0].type).toBe('thinking');
    expect(currentPartsRef.current[1].type).toBe('text');
  });

  it('triggers setMessages on each thinking_delta', () => {
    // Purpose: Each thinking_delta should update the assistant message
    // so the UI re-renders with the latest thinking content.
    const { handler, setMessages } = createMinimalDeps();

    handler('thinking_delta', { text: 'delta 1' }, 'asst-1');
    handler('thinking_delta', { text: 'delta 2' }, 'asst-1');

    // setMessages called for ensureAssistantMessage + updateAssistantMessage each time
    expect(setMessages).toHaveBeenCalled();
    const callCount = setMessages.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('resets thinkingStartRef on done event', () => {
    // Purpose: The done handler must clear thinking state to prevent
    // stale timestamps from leaking into the next stream.
    const { handler, thinkingStartRef } = createMinimalDeps();

    handler('thinking_delta', { text: 'thinking' }, 'asst-1');
    expect(thinkingStartRef.current).toBeGreaterThan(0);

    handler('done', { sessionId: 'test-session' }, 'asst-1');
    expect(thinkingStartRef.current).toBeNull();
  });
});
