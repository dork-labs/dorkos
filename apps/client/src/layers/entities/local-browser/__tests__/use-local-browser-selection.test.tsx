// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLocalBrowserState } from '../model/use-local-browser';

const { read } = vi.hoisted(() => ({
  read: vi.fn(async (sessionId?: string | null) => ({ sessionId, revision: 1 })),
}));
vi.mock('@/layers/shared/model', () => ({ useTransport: () => ({ getLocalBrowserState: read }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('keeps two chat panels and Your browser in separate live caches', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
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
    read.mockImplementationOnce(async (sessionId) => ({ sessionId, revision: 2 }));
    await a.result.current.refetch();
    await waitFor(() => expect(a.result.current.data?.revision).toBe(2));
    expect(b.result.current.data?.revision).toBe(1);
    expect(person.result.current.data?.revision).toBe(1);
  } finally {
    client.clear();
  }
});
