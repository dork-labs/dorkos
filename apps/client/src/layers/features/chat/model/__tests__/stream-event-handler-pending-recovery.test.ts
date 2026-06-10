import { describe, it, expect, vi } from 'vitest';
import type { MessagePart, SessionStatusEvent, TaskUpdateEvent } from '@dorkos/shared/types';
import { createStreamEventHandler } from '../stream/stream-event-handler';

/**
 * Build a stream event handler over fresh refs/spies, mirroring the harness used
 * by the sibling stream-event-handler tests. Returns the handler plus the live
 * `currentPartsRef` so assertions can inspect the upserted parts directly.
 */
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
    themeRef: { current: vi.fn() },
    scrollToMessageRef: { current: undefined },
    switchAgentRef: { current: undefined },
  });

  return { handler, currentPartsRef, setMessages };
}

describe('stream-event-handler — pending interaction recovery (idempotent upsert)', () => {
  it('handleApprovalRequired twice with the same toolCallId yields exactly one pending tool_call part', () => {
    // Purpose: approval dedup — the foreground in-band emit and a later recovery
    // re-emit/pull carrying the same toolCallId must not stack two cards.
    const { handler, currentPartsRef } = createMinimalDeps();

    const approval = {
      toolCallId: 'tool-approval-1',
      toolName: 'Bash',
      input: 'mkdir foo',
      timeoutMs: 600_000,
      startedAt: Date.now(),
      hasSuggestions: false,
    };

    handler('approval_required', approval, 'asst-1');
    handler('approval_required', approval, 'asst-1');

    const pendingApprovals = currentPartsRef.current.filter(
      (p) => p.type === 'tool_call' && p.interactiveType === 'approval'
    );
    expect(pendingApprovals).toHaveLength(1);
  });

  it('handleElicitationPrompt twice with the same interactionId yields exactly one elicitation part', () => {
    // Purpose: elicitation dedup — this is the fixed bug. handleElicitationPrompt
    // previously ALWAYS pushed a new part; a re-emit/pull with the same id must
    // now update in place rather than append a duplicate card.
    const { handler, currentPartsRef } = createMinimalDeps();

    const elicitation = {
      interactionId: 'elicit-1',
      serverName: 'github',
      message: 'Provide a token',
      requestedSchema: { type: 'object', properties: {} },
      timeoutMs: 600_000,
    };

    handler('elicitation_prompt', elicitation, 'asst-1');
    handler('elicitation_prompt', elicitation, 'asst-1');

    const elicitationParts = currentPartsRef.current.filter((p) => p.type === 'elicitation');
    expect(elicitationParts).toHaveLength(1);
    if (elicitationParts[0]?.type === 'elicitation') {
      expect(elicitationParts[0].interactionId).toBe('elicit-1');
    }
  });

  it('an approval re-fire carrying remainingMs updates the part countdown seed in place', () => {
    // Purpose: resumes from the server offset — the recovery re-emit carries a
    // server-authoritative remainingMs so the countdown resumes at the true
    // remaining time instead of resetting to the full timeout.
    const { handler, currentPartsRef } = createMinimalDeps();

    const startedAt = Date.now();
    // First emit: live foreground turn, no remainingMs (countdown seeds from startedAt+timeoutMs).
    handler(
      'approval_required',
      {
        toolCallId: 'tool-approval-2',
        toolName: 'Bash',
        input: 'rm -rf build',
        timeoutMs: 600_000,
        startedAt,
        hasSuggestions: false,
      },
      'asst-1'
    );

    const before = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tool-approval-2'
    );
    expect(before?.type === 'tool_call' && before.approvalRemainingMs).toBeUndefined();

    // Recovery re-emit: same id, now carrying server-authoritative remainingMs.
    handler(
      'approval_required',
      {
        toolCallId: 'tool-approval-2',
        toolName: 'Bash',
        input: 'rm -rf build',
        timeoutMs: 600_000,
        startedAt,
        hasSuggestions: false,
        remainingMs: 123_456,
      },
      'asst-1'
    );

    const parts = currentPartsRef.current.filter(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tool-approval-2'
    );
    // Still exactly one part (upsert, not append).
    expect(parts).toHaveLength(1);
    const after = parts[0];
    if (after?.type === 'tool_call') {
      expect(after.approvalRemainingMs).toBe(123_456);
    }
  });
});
