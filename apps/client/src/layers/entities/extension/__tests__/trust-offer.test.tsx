/**
 * The approve answer carries the server's one-time trust offer into this
 * window's offer store, and nothing else does (spec `flow-multiproject` §9.3).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useExtensionApprovalActions } from '../model/use-extension-approval-actions';
import { useTrustOfferStore } from '../model/trust-offer-store';
import { runningCopiesOnly } from '../lib/running-copies';

const COPY = { id: 'flow', name: 'Flow', path: '/p/flow', version: '1.0.0', plugin: 'flow' };

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('the trust offer after turning an extension on', () => {
  beforeEach(() => useTrustOfferStore.getState().withdrawAll());
  afterEach(() => vi.unstubAllGlobals());

  it('is remembered when the server makes one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ extension: {}, trustOffer: { source: 'dork-labs/marketplace' } })
          )
      )
    );
    const { result } = renderHook(() => useExtensionApprovalActions(), { wrapper });

    result.current.approve(COPY);

    await waitFor(() =>
      expect(useTrustOfferStore.getState().offers.flow).toMatchObject({
        extensionId: 'flow',
        source: 'dork-labs/marketplace',
      })
    );
  });

  it('is not invented when the server makes none', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ extension: {} })));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useExtensionApprovalActions(), { wrapper });

    result.current.approve(COPY);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(useTrustOfferStore.getState().offers).toEqual({});
  });
});

describe('runningCopiesOnly', () => {
  it('drops each older copy a newer one shadows', () => {
    const base = {
      manifest: { id: 'flow', name: 'Flow', version: '1.0.0' },
      status: 'compiled' as const,
      scope: 'local' as const,
      origin: 'user' as const,
      bundleReady: true,
      hasServerEntry: false,
      hasDataProxy: false,
      approvedToRun: true,
    };
    const running = { ...base, id: 'flow', shadowedBy: null };
    const older = { ...base, id: 'flow', shadowedBy: '/b/flow' };
    expect(runningCopiesOnly([running, older])).toEqual([running]);
  });
});
