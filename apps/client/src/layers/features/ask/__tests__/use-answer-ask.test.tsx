// @vitest-environment jsdom
/**
 * Answering an Ask reaches the right one of the six methods that already exist.
 *
 * Seeded defect, run and red: route `question` to `approveTool` and "a question
 * is answered by submitting answers" fails with the approval mock called
 * instead — which in the app would mean a question silently answered as a
 * permission grant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { clearAskReceipts, useAskReceipt } from '@/layers/entities/attention';
import { useAnswerAsk } from '../model/use-answer-ask';

const NOW = Date.parse('2026-08-18T10:00:00.000Z');

/** One prompt of the given kind, from one session. */
function ask(interaction: PendingInteractionDTO): InteractionPendingEvent {
  return { sessionId: 'session-1', cwd: '/projects/alpha', interaction };
}

const APPROVAL: PendingInteractionDTO = {
  type: 'approval',
  id: 'tc-1',
  startedAt: NOW,
  remainingMs: 600_000,
  toolName: 'Bash',
  input: '{}',
  hasSuggestions: false,
};

let transport: ReturnType<typeof createMockTransport>;

/** Mount the hook over a mock transport. */
function mount() {
  transport = createMockTransport();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </TransportProvider>
  );
  return renderHook(() => useAnswerAsk(), { wrapper });
}

beforeEach(() => clearAskReceipts());
afterEach(cleanup);

describe('useAnswerAsk', () => {
  it('allows a permission prompt through approveTool, and refuses it through denyTool', async () => {
    const { result } = mount();

    await act(async () => await result.current.answer(ask(APPROVAL), 'allow'));
    expect(transport.approveTool).toHaveBeenCalledWith('session-1', 'tc-1');

    await act(async () => await result.current.answer(ask(APPROVAL), 'deny'));
    expect(transport.denyTool).toHaveBeenCalledWith('session-1', 'tc-1');
  });

  it('answers a question by submitting answers, never by approving it', async () => {
    const { result } = mount();
    const question = ask({
      type: 'question',
      id: 'q-1',
      startedAt: NOW,
      remainingMs: 600_000,
      questions: [],
    });

    await act(async () => await result.current.answer(question, 'deny'));

    expect(transport.submitAnswers).toHaveBeenCalledWith('session-1', 'q-1', {});
    expect(transport.approveTool).not.toHaveBeenCalled();
  });

  it('accepts and declines an elicitation through its own method', async () => {
    const { result } = mount();
    const elicitation = ask({
      type: 'elicitation',
      id: 'e-1',
      startedAt: NOW,
      remainingMs: 600_000,
      serverName: 'linear',
      message: 'Pick a team',
    });

    await act(async () => await result.current.answer(elicitation, 'allow'));
    expect(transport.submitElicitation).toHaveBeenCalledWith('session-1', 'e-1', 'accept');

    await act(async () => await result.current.answer(elicitation, 'deny'));
    expect(transport.submitElicitation).toHaveBeenCalledWith('session-1', 'e-1', 'decline');
  });

  it('answers a whole burst in one call, not once per prompt', async () => {
    const { result } = mount();
    const burst = [ask(APPROVAL), ask({ ...APPROVAL, id: 'tc-2' })];

    await act(async () => await result.current.answerAll(burst, 'allow'));

    expect(transport.batchApprove).toHaveBeenCalledWith('session-1', ['tc-1', 'tc-2']);
    expect(transport.approveTool).not.toHaveBeenCalled();
  });

  it('takes the receipt back when the server refuses, so the card is answerable again', async () => {
    // The optimistic receipt is written before the server agrees. A refusal
    // means it never did, and a receipt left behind reads "You allowed this"
    // over a request still sitting there waiting. Seeded defect: drop the
    // `forgetAskReceipt` loop and this finds the stale receipt.
    const { result } = mount();
    vi.mocked(transport.approveTool).mockRejectedValue(
      Object.assign(new Error('Only a person signed in to DorkOS can answer this'), {
        code: 'operator_cookie_required',
      })
    );

    await act(async () => await result.current.answer(ask(APPROVAL), 'allow'));

    const { result: receipt } = renderHook(() => useAskReceipt('tc-1'));
    expect(receipt.current).toBeUndefined();
  });

  it('surfaces a refusal in words a person can act on', async () => {
    // The 403 from the answer guard is the one that matters: the card has to
    // say why rather than sitting there looking answered.
    const { result } = mount();
    vi.mocked(transport.approveTool).mockRejectedValue(
      Object.assign(new Error('Only a person signed in to DorkOS can answer this'), {
        code: 'operator_cookie_required',
      })
    );

    await act(async () => await result.current.answer(ask(APPROVAL), 'allow'));

    await waitFor(() =>
      expect(result.current.error).toBe('Only a person signed in to DorkOS can answer this')
    );
  });
});
