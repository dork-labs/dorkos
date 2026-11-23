/**
 * A refused answer to an extension's decision arrives as a problem document
 * (DOR-4979): a list code, and the inbox's own word as `reason`. The bell
 * reads `reason` to tell a question that changed (said calmly) from a failure,
 * and a lapsed offer's dismiss (said nothing) from one.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

import { useExtensionDecisionActions } from '../model/use-extension-decisions';

/** A problem document, as the server sends one. */
function problem(code: string, status: number, detail: string, reason?: string): Response {
  return new Response(
    JSON.stringify({
      type: `urn:dorkos:problem:${code}`,
      title: 'Refused.',
      status,
      code,
      detail,
      ...(reason === undefined ? {} : { reason }),
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } }
  );
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const DECISION = { id: '01JXAMPLE0000000000000000A', extensionName: 'Flow', revision: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('a refused decision answer', () => {
  it('says a changed question calmly, by its reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        problem('conflict', 409, 'This question changed. Take another look.', 'stale_decision')
      )
    );
    const { result } = renderHook(() => useExtensionDecisionActions(), { wrapper });
    await act(async () => {
      await result.current.answer({ decision: DECISION, request: { action: 'approve' } });
    });
    expect(toast).toHaveBeenCalledWith('This question changed. Take another look.');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows any other conflict as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem('conflict', 409, 'This was already settled.', 'already_resolved'))
    );
    const { result } = renderHook(() => useExtensionDecisionActions(), { wrapper });
    await act(async () => {
      await result.current.answer({ decision: DECISION, request: { action: 'approve' } });
    });
    expect(toast.error).toHaveBeenCalledWith('This was already settled.');
  });

  it('says nothing when dismissing an offer that already lapsed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => problem('conflict', 409, 'That offer is no longer open.', 'offer_gone'))
    );
    const { result } = renderHook(() => useExtensionDecisionActions(), { wrapper });
    act(() => result.current.answerOffer(DECISION.id, false));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
