/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { usePendingInteractions } from '../use-pending-interactions';
import type { ChatMessage } from '../chat-types';

const SESSION_ID = 'session-recover-1';

function approvalDTO(
  overrides: Partial<Extract<PendingInteractionDTO, { type: 'approval' }>> = {}
) {
  return {
    type: 'approval' as const,
    id: 'tool-approval-1',
    startedAt: Date.now(),
    remainingMs: 540_000,
    toolName: 'Bash',
    input: 'mkdir foo',
    hasSuggestions: false,
    ...overrides,
  };
}

/** Pending tool_call parts hydrated into the captured messages, flattened across bubbles. */
function pendingApprovalParts(messages: ChatMessage[]) {
  return messages
    .flatMap((m) => m.parts)
    .filter(
      (p) => p.type === 'tool_call' && p.interactiveType === 'approval' && p.status === 'pending'
    );
}

function questionDTO(
  overrides: Partial<Extract<PendingInteractionDTO, { type: 'question' }>> = {}
) {
  return {
    type: 'question' as const,
    id: 'q-recover-1',
    startedAt: Date.now(),
    remainingMs: 480_000,
    questions: [{ question: 'Pick a branch', options: [{ label: 'main' }, { label: 'dev' }] }],
    ...overrides,
  };
}

/** Pending question tool_call parts hydrated into the captured messages. */
function pendingQuestionParts(messages: ChatMessage[]) {
  return messages
    .flatMap((m) => m.parts)
    .filter(
      (p) => p.type === 'tool_call' && p.interactiveType === 'question' && p.status === 'pending'
    );
}

describe('usePendingInteractions', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;
  let queryClient: QueryClient;
  /** Local message buffer standing in for the session store. */
  let messages: ChatMessage[];
  let setMessages: (update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;

  function createWrapper() {
    return function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={mockTransport}>{children}</TransportProvider>
        </QueryClientProvider>
      );
    };
  }

  function renderRecovery() {
    return renderHook(
      () =>
        usePendingInteractions({
          sessionId: SESSION_ID,
          transport: mockTransport,
          selectedCwd: null,
          isStreaming: false,
          setMessages,
        }),
      { wrapper: createWrapper() }
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockTransport = createMockTransport();
    messages = [];
    setMessages = (update) => {
      messages = typeof update === 'function' ? update(messages) : update;
    };
  });

  it('hydrates exactly one pending approval card on mount from the pulled DTO', async () => {
    // Purpose: Path A hydrate-on-mount — a session switched/refreshed into a blocked
    // state re-pulls its server-side pending interaction and rebuilds the Approve/Deny card.
    mockTransport.getPendingInteractions = vi
      .fn()
      .mockResolvedValue({ interactions: [approvalDTO()] });

    renderRecovery();

    await waitFor(() => {
      expect(pendingApprovalParts(messages)).toHaveLength(1);
    });
    const part = pendingApprovalParts(messages)[0];
    expect(part.type === 'tool_call' && part.toolCallId).toBe('tool-approval-1');
  });

  it('seeds the hydrated card countdown from the server remainingMs', async () => {
    // Purpose: countdown seeded from server offset — the recovered card carries the
    // DTO's server-authoritative remainingMs so #138 resumes at the true offset
    // instead of resetting to the full timeout.
    mockTransport.getPendingInteractions = vi
      .fn()
      .mockResolvedValue({ interactions: [approvalDTO({ remainingMs: 123_456 })] });

    renderRecovery();

    await waitFor(() => {
      expect(pendingApprovalParts(messages)).toHaveLength(1);
    });
    const part = pendingApprovalParts(messages)[0];
    expect(part.type === 'tool_call' && part.approvalRemainingMs).toBe(123_456);
  });

  it('dedups a live approval_required for the same id arriving after the pull into one card', async () => {
    // Purpose: pull + live dedup — relies on the committed idempotent upsert. The pull
    // hydrates the card; a same-id live re-emit replayed through the same renderer
    // updates it in place rather than stacking a second card.
    mockTransport.getPendingInteractions = vi
      .fn()
      .mockResolvedValue({ interactions: [approvalDTO()] });

    const { result } = renderRecovery();

    await waitFor(() => {
      expect(pendingApprovalParts(messages)).toHaveLength(1);
    });

    // Simulate a live SSE re-emit (Path B) for the SAME interaction id by routing a
    // native approval_required event through replayInteractionEvent — the shared
    // entrypoint syncEventHandlers reuses. Because the renderer upserts by id, this
    // updates the card in place rather than stacking a second one.
    act(() => {
      result.current.replayInteractionEvent('approval_required', {
        toolCallId: 'tool-approval-1',
        toolName: 'Bash',
        input: 'mkdir foo',
        startedAt: Date.now(),
        remainingMs: 530_000,
        hasSuggestions: false,
      });
    });

    const deduped = pendingApprovalParts(messages);
    expect(deduped).toHaveLength(1);
    // The in-place update applied the live re-emit's fresher remainingMs.
    const card = deduped[0];
    expect(card.type === 'tool_call' && card.approvalRemainingMs).toBe(530_000);
  });

  it('hydrates a pending AskUserQuestion card on mount and seeds its countdown from remainingMs', async () => {
    // Purpose: Path A hydrate for question_prompt — the committed hydrate tests only
    // exercise approval DTOs. A session blocked on an AskUserQuestion prompt must also
    // re-pull and rebuild its card (with the server-authoritative remainingMs seed)
    // through the same idempotent renderer.
    mockTransport.getPendingInteractions = vi
      .fn()
      .mockResolvedValue({ interactions: [questionDTO({ remainingMs: 321_000 })] });

    renderRecovery();

    await waitFor(() => {
      expect(pendingQuestionParts(messages)).toHaveLength(1);
    });
    const part = pendingQuestionParts(messages)[0];
    expect(part.type === 'tool_call' && part.toolCallId).toBe('q-recover-1');
    expect(part.type === 'tool_call' && part.approvalRemainingMs).toBe(321_000);
    expect(part.type === 'tool_call' && part.questions?.[0]?.question).toBe('Pick a branch');
  });
});
