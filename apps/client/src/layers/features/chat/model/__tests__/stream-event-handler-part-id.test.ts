import { describe, it, expect, vi } from 'vitest';
import { createStreamEventHandler } from '../stream-event-handler';
import type { MessagePart } from '@dorkos/shared/types';

function createMinimalDeps() {
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
  const onSessionIdChangeRef = { current: undefined };
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
    sessionId: 'test-session',
    onTaskEventRef,
    onSessionIdChangeRef,
    onStreamingDoneRef,
  });

  return { handler, currentPartsRef, setMessages };
}

describe('stream-event-handler — _partId assignment', () => {
  it('assigns _partId to new text part on first text_delta', () => {
    // Purpose: verify _partId is assigned exactly once at part creation
    // so keys are stable regardless of how many subsequent deltas arrive.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler('text_delta', { text: 'Hello' }, 'asst-1');

    const part = currentPartsRef.current[0] as { type: string; text: string; _partId?: string };
    expect(part._partId).toBe('text-part-0');
    expect(part.text).toBe('Hello');
  });

  it('preserves _partId when subsequent text_delta appends to same part', () => {
    // Purpose: confirm { ...lastPart, text: ... } spread preserves _partId.
    // This is the critical invariant — _partId must not change between deltas.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler('text_delta', { text: 'Hello' }, 'asst-1');
    const idAfterFirst = (currentPartsRef.current[0] as { _partId?: string })._partId;

    handler('text_delta', { text: ' world' }, 'asst-1');
    const idAfterSecond = (currentPartsRef.current[0] as { _partId?: string })._partId;

    expect(idAfterFirst).toBe('text-part-0');
    expect(idAfterSecond).toBe('text-part-0'); // Must not change
    expect((currentPartsRef.current[0] as { text: string }).text).toBe('Hello world');
  });

  it('assigns a new _partId to a second text part after a tool_call', () => {
    // Purpose: verify that when the parts array grows (text → tool_call → text),
    // the second text part gets a distinct _partId based on its creation-time position.
    // This is the exact shape that caused the key storm in production.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler('text_delta', { text: 'First block' }, 'asst-1');
    handler('tool_call_start', { toolCallId: 'tc-1', toolName: 'Read' }, 'asst-1');
    handler('text_delta', { text: 'Second block' }, 'asst-1');

    const parts = currentPartsRef.current as Array<{
      type: string;
      _partId?: string;
      toolCallId?: string;
    }>;
    expect(parts[0]._partId).toBe('text-part-0'); // First text part
    expect(parts[1].toolCallId).toBe('tc-1'); // Tool call (no _partId)
    expect(parts[2]._partId).toBe('text-part-2'); // Second text part — position 2 at creation
  });
});
