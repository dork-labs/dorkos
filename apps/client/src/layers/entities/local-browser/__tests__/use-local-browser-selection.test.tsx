// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import { useLocalBrowserState } from '../model/use-local-browser';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('keeps two chat panels and Your browser in separate live caches', async () => {
  const initial = await createMockTransport().getLocalBrowserState();
  const read = vi.fn(async (sessionId: string | null = null) => ({
    ...initial,
    sessionId,
    revision: 1,
  }));
  const transport = createMockTransport({ getLocalBrowserState: read });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  const a = renderHook(() => useLocalBrowserState(true, 'chat-a'), { wrapper });
  const b = renderHook(() => useLocalBrowserState(true, 'chat-b'), { wrapper });
  const person = renderHook(() => useLocalBrowserState(true, null), { wrapper });
  try {
    await waitFor(() => {
      expect(a.result.current.data?.sessionId).toBe('chat-a');
      expect(b.result.current.data?.sessionId).toBe('chat-b');
      expect(person.result.current.data?.sessionId).toBeNull();
    });
    read.mockImplementationOnce(async (sessionId) => ({
      ...initial,
      sessionId: sessionId ?? null,
      revision: 2,
    }));
    await a.result.current.refetch();
    await waitFor(() => expect(a.result.current.data?.revision).toBe(2));
    expect(b.result.current.data?.revision).toBe(1);
    expect(person.result.current.data?.revision).toBe(1);
  } finally {
    client.clear();
  }
});
