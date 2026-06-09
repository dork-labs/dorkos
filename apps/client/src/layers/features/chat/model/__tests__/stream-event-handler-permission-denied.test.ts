import { describe, it, expect, vi } from 'vitest';
import type { MessagePart, SessionStatusEvent, TaskUpdateEvent } from '@dorkos/shared/types';
import { createStreamEventHandler } from '../stream/stream-event-handler';

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
    onRemapRef: { current: undefined },
    themeRef: { current: vi.fn() },
    scrollToMessageRef: { current: undefined },
    switchAgentRef: { current: undefined },
  });

  return { handler, currentPartsRef, setMessages };
}

describe('stream-event-handler — permission_denied events', () => {
  it('appends a read-only permission_denied part with classifier copy and reason', () => {
    // Purpose: a classifier denial should surface as a read-only chip in the
    // message stream — not hit the unknown-event console.warn fallthrough.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler, currentPartsRef, setMessages } = createMinimalDeps();

    handler(
      'permission_denied',
      {
        toolCallId: 'tool-1',
        toolName: 'Bash',
        reasonType: 'classifier',
        reason: 'Destructive shell command',
        message: 'This command was blocked by the safety classifier.',
      },
      'asst-1'
    );

    const part = currentPartsRef.current.find((p) => p.type === 'permission_denied');
    expect(part).toBeDefined();
    if (part?.type === 'permission_denied') {
      expect(part.toolCallId).toBe('tool-1');
      expect(part.toolName).toBe('Bash');
      expect(part.reasonType).toBe('classifier');
      expect(part.reason).toBe('Destructive shell command');
      expect(part.message).toBe('This command was blocked by the safety classifier.');
    }

    // The part must be flushed into the assistant message.
    expect(setMessages).toHaveBeenCalled();
    // It must NOT hit the unknown-event-type fallthrough.
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[stream] unknown event type:',
      'permission_denied',
      expect.anything()
    );
    warnSpy.mockRestore();
  });

  it('falls back to message when reason is absent', () => {
    const { handler, currentPartsRef } = createMinimalDeps();

    handler(
      'permission_denied',
      {
        toolCallId: 'tool-2',
        toolName: 'Write',
        reasonType: 'rule',
        message: 'Write outside the working directory is not allowed.',
      },
      'asst-1'
    );

    const part = currentPartsRef.current.find((p) => p.type === 'permission_denied');
    expect(part).toBeDefined();
    if (part?.type === 'permission_denied') {
      expect(part.reason).toBeUndefined();
      expect(part.message).toBe('Write outside the working directory is not allowed.');
    }
  });
});
