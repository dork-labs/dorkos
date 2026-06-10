/**
 * @vitest-environment jsdom
 *
 * Path B recovery — re-emitted interaction events on the persistent sync stream.
 *
 * These tests drive the full `useChatSession` → `useSessionHistory` →
 * `usePendingInteractions.replayInteractionEvent` path. They capture the
 * `eventHandlers` object that `useSessionHistory` passes to the sync
 * `useSSEConnection` and invoke the new `approval_required` / `question_prompt` /
 * `elicitation_prompt` keys directly — simulating the native SSE events the server
 * re-emits on every (re)connect of `GET /api/sessions/:id/stream`.
 *
 * The key assertion is cross-path dedup: an interaction delivered by BOTH the
 * Path A pull (`transport.getPendingInteractions`) AND a Path B sync re-emit must
 * render exactly ONE card, because both route through the same idempotent renderer
 * (upsert by interaction id).
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChatSession } from '../model/use-chat-session';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type { Transport } from '@dorkos/shared/transport';
import { resetUuidCounter } from './chat-session-test-helpers';
import { useSessionChatStore } from '@/layers/entities/session';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Mocks: app store + a useSSEConnection that captures the sync event handlers
// ---------------------------------------------------------------------------

let mockAppState: Record<string, unknown> = {
  selectedCwd: '/test/cwd',
  enableCrossClientSync: true,
  enableMessagePolling: true,
};

/**
 * Captures the most recent non-empty `eventHandlers` object passed to
 * `useSSEConnection`. `useChatSession` opens more than one SSE connection; only the
 * cross-client sync connection registers the interaction handlers, so we keep the
 * latest object that actually contains them.
 */
let capturedSyncHandlers: Record<string, (data: unknown) => void> | null = null;

vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  const useAppStore = Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      return selector ? selector(mockAppState) : mockAppState;
    },
    { getState: () => mockAppState }
  );
  return {
    ...actual,
    useAppStore,
    useSSEConnection: (
      _url: string | null,
      options: { eventHandlers: Record<string, (data: unknown) => void> }
    ) => {
      if (options?.eventHandlers && 'approval_required' in options.eventHandlers) {
        capturedSyncHandlers = options.eventHandlers;
      }
      return {
        connectionState: 'connected' as const,
        failedAttempts: 0,
        lastEventAt: null,
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 's-pathb';

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Native `approval_required` re-emit payload (Path B shape). */
function approvalEvent(overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: 'tool-approval-1',
    toolName: 'Bash',
    input: 'mkdir foo',
    startedAt: Date.now(),
    remainingMs: 540_000,
    hasSuggestions: false,
    ...overrides,
  };
}

/** Native `question_prompt` re-emit payload (Path B shape). */
function questionEvent(overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: 'q-1',
    questions: [{ question: 'Pick a branch', options: [{ label: 'main' }, { label: 'dev' }] }],
    startedAt: Date.now(),
    remainingMs: 480_000,
    ...overrides,
  };
}

/** Native `elicitation_prompt` re-emit payload (Path B shape). */
function elicitationEvent(overrides: Record<string, unknown> = {}) {
  return {
    interactionId: 'elicit-1',
    serverName: 'github',
    message: 'Authorize access?',
    mode: 'form',
    startedAt: Date.now(),
    remainingMs: 300_000,
    ...overrides,
  };
}

/** Flatten all tool_call parts that are pending approvals across message bubbles. */
function pendingApprovalParts(messages: { parts: Array<Record<string, unknown>> }[]) {
  return messages
    .flatMap((m) => m.parts)
    .filter(
      (p) => p.type === 'tool_call' && p.interactiveType === 'approval' && p.status === 'pending'
    );
}

/** Flatten all pending question tool_call parts across message bubbles. */
function pendingQuestionParts(messages: { parts: Array<Record<string, unknown>> }[]) {
  return messages
    .flatMap((m) => m.parts)
    .filter(
      (p) => p.type === 'tool_call' && p.interactiveType === 'question' && p.status === 'pending'
    );
}

/** Flatten all pending elicitation parts across message bubbles. */
function pendingElicitationParts(messages: { parts: Array<Record<string, unknown>> }[]) {
  return messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'elicitation' && p.status === 'pending');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChatSession — Path B re-emit on sync stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUuidCounter();
    capturedSyncHandlers = null;
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    mockAppState = {
      selectedCwd: '/test/cwd',
      enableCrossClientSync: true,
      enableMessagePolling: true,
    };
  });

  it('renders a pending approval card from an approval_required event on the sync channel', async () => {
    // Purpose: Path B events handled on the sync channel.
    const transport = createMockTransport();
    // No Path A pull — exercise the sync channel in isolation.
    transport.getPendingInteractions = vi.fn().mockResolvedValue({ interactions: [] });

    const { result } = renderHook(() => useChatSession(SESSION_ID), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));
    await waitFor(() => expect(capturedSyncHandlers).not.toBeNull());

    act(() => {
      capturedSyncHandlers!.approval_required(approvalEvent());
    });

    await waitFor(() => {
      expect(pendingApprovalParts(result.current.messages)).toHaveLength(1);
    });
    const part = pendingApprovalParts(result.current.messages)[0];
    expect(part.toolCallId).toBe('tool-approval-1');
  });

  it('renders exactly one card when the same approval id arrives via BOTH a Path A pull and a Path B sync re-emit', async () => {
    // Purpose: cross-path dedup end-to-end.
    const transport = createMockTransport();
    // Path A: the pull hydrates the card on mount.
    transport.getPendingInteractions = vi.fn().mockResolvedValue({
      interactions: [
        {
          type: 'approval' as const,
          id: 'tool-approval-1',
          startedAt: Date.now(),
          remainingMs: 540_000,
          toolName: 'Bash',
          input: 'mkdir foo',
          hasSuggestions: false,
        },
      ],
    });

    const { result } = renderHook(() => useChatSession(SESSION_ID), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));
    // Path A pull paints the card first.
    await waitFor(() => {
      expect(pendingApprovalParts(result.current.messages)).toHaveLength(1);
    });
    await waitFor(() => expect(capturedSyncHandlers).not.toBeNull());

    // Path B: the SAME interaction id is re-emitted on the sync stream (e.g. a
    // live reconnect / background→foreground). Routed through the same renderer,
    // it must upsert in place — fresher remainingMs, still one card.
    act(() => {
      capturedSyncHandlers!.approval_required(approvalEvent({ remainingMs: 530_000 }));
    });

    const cards = pendingApprovalParts(result.current.messages);
    expect(cards).toHaveLength(1);
    expect(cards[0].approvalRemainingMs).toBe(530_000);
  });

  it('renders one elicitation card when a Path B elicitation_prompt is delivered then duplicated', async () => {
    // Purpose: elicitation Path B dedup.
    const transport = createMockTransport();
    transport.getPendingInteractions = vi.fn().mockResolvedValue({ interactions: [] });

    const { result } = renderHook(() => useChatSession(SESSION_ID), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));
    await waitFor(() => expect(capturedSyncHandlers).not.toBeNull());

    act(() => {
      capturedSyncHandlers!.elicitation_prompt(elicitationEvent());
    });
    await waitFor(() => {
      expect(pendingElicitationParts(result.current.messages)).toHaveLength(1);
    });

    // Duplicate re-emit for the same interactionId (a second reconnect).
    act(() => {
      capturedSyncHandlers!.elicitation_prompt(elicitationEvent({ remainingMs: 290_000 }));
    });

    const cards = pendingElicitationParts(result.current.messages);
    expect(cards).toHaveLength(1);
    expect(cards[0].remainingMs).toBe(290_000);
  });

  it('renders exactly one question card when the same id arrives via BOTH a Path A pull and a Path B sync re-emit', async () => {
    // Purpose: cross-path dedup for question_prompt. The committed cross-path test only
    // covers approval; questions ride a different handler (handleQuestionPrompt) and
    // must also fold a Path A pull and a same-id Path B re-emit into one card.
    const transport = createMockTransport();
    transport.getPendingInteractions = vi.fn().mockResolvedValue({
      interactions: [
        {
          type: 'question' as const,
          id: 'q-1',
          startedAt: Date.now(),
          remainingMs: 480_000,
          questions: [
            { question: 'Pick a branch', options: [{ label: 'main' }, { label: 'dev' }] },
          ],
        },
      ],
    });

    const { result } = renderHook(() => useChatSession(SESSION_ID), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));
    // Path A pull paints the question card first.
    await waitFor(() => {
      expect(pendingQuestionParts(result.current.messages)).toHaveLength(1);
    });
    await waitFor(() => expect(capturedSyncHandlers).not.toBeNull());

    // Path B: the SAME question id is re-emitted on the sync stream. Routed through the
    // same renderer, it upserts in place — fresher remainingMs, still one card.
    act(() => {
      capturedSyncHandlers!.question_prompt(questionEvent({ remainingMs: 470_000 }));
    });

    const cards = pendingQuestionParts(result.current.messages);
    expect(cards).toHaveLength(1);
    expect(cards[0].toolCallId).toBe('q-1');
    expect(cards[0].approvalRemainingMs).toBe(470_000);
  });
});
