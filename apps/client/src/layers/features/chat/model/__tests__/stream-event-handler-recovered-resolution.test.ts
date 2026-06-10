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

describe('stream-event-handler — recovered card resolution', () => {
  it('a recovered pending approval part transitions to complete when a tool_result for its toolCallId arrives', () => {
    // Purpose: resolve-on-result for recovered approvals. A card pulled/re-emitted
    // on reconnect (the recovery re-emit carries server-authoritative remainingMs)
    // must close the loop when its tool_result arrives — sharing the same
    // resolution machinery as a live card, keyed on toolCallId.
    const { handler, currentPartsRef } = createMinimalDeps();

    // Recovery re-emit: an approval_required carrying remainingMs (no prior
    // tool_call_start — the live turn that created it is long gone).
    handler(
      'approval_required',
      {
        toolCallId: 'tool-approval-recovered',
        toolName: 'Bash',
        input: 'mkdir foo',
        timeoutMs: 600_000,
        startedAt: Date.now(),
        remainingMs: 300_000,
        hasSuggestions: false,
      },
      'asst-1'
    );

    const pending = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tool-approval-recovered'
    );
    expect(pending?.type === 'tool_call' && pending.status).toBe('pending');

    // The user approves on another client; a tool_result for the same id arrives.
    handler('tool_result', { toolCallId: 'tool-approval-recovered', result: 'created' }, 'asst-1');

    const resolved = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tool-approval-recovered'
    );
    expect(resolved?.type === 'tool_call' && resolved.status).toBe('complete');
    expect(resolved?.type === 'tool_call' && resolved.result).toBe('created');
  });

  it('a recovered question part transitions to complete when a tool_result for its toolCallId arrives', () => {
    // Purpose: resolve-on-result for recovered AskUserQuestion cards. Like
    // approvals, a recovered question card is keyed on toolCallId; the 'complete'
    // status alone collapses QuestionPrompt into its answered row.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler(
      'question_prompt',
      {
        toolCallId: 'q-recovered',
        questions: [
          { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
        ],
        startedAt: Date.now(),
        remainingMs: 200_000,
      },
      'asst-1'
    );

    const pending = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'q-recovered'
    );
    expect(pending?.type === 'tool_call' && pending.status).toBe('pending');

    handler('tool_result', { toolCallId: 'q-recovered', result: 'A' }, 'asst-1');

    const resolved = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'q-recovered'
    );
    expect(resolved?.type === 'tool_call' && resolved.status).toBe('complete');
  });

  it('a recovered elicitation part resolves when its elicitation_complete arrives (keyed by interactionId)', () => {
    // Purpose: elicitation resolution path. A recovered elicitation card is keyed
    // by interactionId, NOT toolCallId; the server registers it under
    // interactionId = elicitationId, so elicitation_complete (which carries
    // elicitationId) matches and transitions the card to resolved.
    const { handler, currentPartsRef } = createMinimalDeps();

    // Recovery re-emit of a URL-mode elicitation. interactionId === elicitationId.
    handler(
      'elicitation_prompt',
      {
        interactionId: 'elicit-url-1',
        serverName: 'github',
        message: 'Authorize via the link',
        mode: 'url',
        url: 'https://example.com/auth',
        elicitationId: 'elicit-url-1',
        remainingMs: 250_000,
      },
      'asst-1'
    );

    const pending = currentPartsRef.current.find(
      (p) => p.type === 'elicitation' && p.interactionId === 'elicit-url-1'
    );
    expect(pending?.type === 'elicitation' && pending.status).toBe('pending');

    // The MCP server confirms the URL auth — elicitation_complete carries elicitationId.
    handler(
      'elicitation_complete',
      { serverName: 'github', elicitationId: 'elicit-url-1' },
      'asst-1'
    );

    const resolved = currentPartsRef.current.find(
      (p) => p.type === 'elicitation' && p.interactionId === 'elicit-url-1'
    );
    expect(resolved?.type === 'elicitation' && resolved.status).toBe('complete');
    expect(resolved?.type === 'elicitation' && resolved.action).toBe('accept');
  });
});
