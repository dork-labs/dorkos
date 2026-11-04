/**
 * @vitest-environment jsdom
 */
/**
 * Whether the DM view setting is known yet (DOR-3074): off is not a safe guess
 * before the server answers, because it draws the session's chrome.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useDmViewState } from '../model/use-dm-view';

/** Read the state over this config read, with this config already in the cache. */
function read(getConfig: Transport['getConfig'], cached?: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cached !== undefined)
    queryClient.setQueryData(configKeys.current(), cached, { updatedAt: 1 });
  const transport = createMockTransport({ getConfig });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useDmViewState(), { wrapper });
}

const never = () => new Promise<never>(() => {});

describe('useDmViewState', () => {
  it('is not settled before the first answer', () => {
    const { result } = read(vi.fn(never) as never);
    expect(result.current).toEqual({ enabled: false, settled: false });
  });

  it('settles on the answer, on or off', async () => {
    const on = read(vi.fn().mockResolvedValue({ ui: { dmView: true } }));
    await waitFor(() => expect(on.result.current).toEqual({ enabled: true, settled: true }));
    const off = read(vi.fn().mockResolvedValue({ ui: { dmView: false } }));
    await waitFor(() => expect(off.result.current).toEqual({ enabled: false, settled: true }));
  });

  it('does not trust a boot cache from before the setting while it asks', () => {
    const { result } = read(vi.fn(never) as never, { version: '0.130.0', ui: {} });
    expect(result.current.settled).toBe(false);
  });

  it('trusts a cached answer at once, so a reload draws no neutral frame', () => {
    const { result } = read(vi.fn(never) as never, { ui: { dmView: true } });
    expect(result.current).toEqual({ enabled: true, settled: true });
  });

  it('settles as off when the read fails, so a chat still draws', async () => {
    const { result } = read(vi.fn().mockRejectedValue(new Error('down')));
    await waitFor(() => expect(result.current).toEqual({ enabled: false, settled: true }));
  });
});
