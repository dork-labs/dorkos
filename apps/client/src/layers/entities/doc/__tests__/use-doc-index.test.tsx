/**
 * `useDocIndex` and `useInvalidateDocIndex` (DOR-2982): the space's docs over
 * the Transport, idle until asked, and read again when invalidated.
 */
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useDocIndex, useInvalidateDocIndex } from '../index';

const INDEX = { root: '/repo', docs: [{ path: 'a.md', title: 'A', slug: 'a' }], truncated: false };

function setup() {
  const getDocIndex = vi.fn().mockResolvedValue(INDEX);
  const transport = createMockTransport({ getDocIndex });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { getDocIndex, wrapper };
}

describe('useDocIndex', () => {
  it('reads the docs of a working directory', async () => {
    const { getDocIndex, wrapper } = setup();
    const { result } = renderHook(() => useDocIndex('/repo', true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(INDEX));
    expect(getDocIndex).toHaveBeenCalledWith('/repo');
  });

  it('stays idle while disabled or with no working directory', async () => {
    const { getDocIndex, wrapper } = setup();
    renderHook(() => useDocIndex('/repo', false), { wrapper });
    renderHook(() => useDocIndex(null, true), { wrapper });
    await act(async () => {});
    expect(getDocIndex).not.toHaveBeenCalled();
  });

  it('reads again when invalidated, for one directory or for all', async () => {
    const { getDocIndex, wrapper } = setup();
    const { result } = renderHook(
      () => ({ index: useDocIndex('/repo', true), invalidate: useInvalidateDocIndex() }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.index.data).toBeDefined());
    act(() => result.current.invalidate('/other'));
    await act(async () => {});
    expect(getDocIndex).toHaveBeenCalledTimes(1);
    act(() => result.current.invalidate('/repo'));
    await waitFor(() => expect(getDocIndex).toHaveBeenCalledTimes(2));
    act(() => result.current.invalidate());
    await waitFor(() => expect(getDocIndex).toHaveBeenCalledTimes(3));
  });
});
