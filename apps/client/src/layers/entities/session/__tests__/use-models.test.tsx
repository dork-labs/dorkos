/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useModels } from '../model/use-models';

const mockModels = [
  { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast model' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Capable model' },
];

describe('useModels', () => {
  it('returns model options from transport', async () => {
    const transport = createMockTransport({ getModels: vi.fn().mockResolvedValue(mockModels) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      );
    }

    const { result } = renderHook(() => useModels(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.data).toEqual(mockModels);
    });

    expect(transport.getModels).toHaveBeenCalledOnce();
  });

  it('keys the cache by runtime so each runtime fetches its own catalog', async () => {
    const codexModels = [
      { value: 'gpt-5-codex', displayName: 'GPT-5 Codex', description: 'Codex model' },
    ];
    const getModels = vi.fn((opts?: { runtime?: string }) =>
      Promise.resolve(opts?.runtime === 'codex' ? codexModels : mockModels)
    );
    const transport = createMockTransport({ getModels });
    // One shared client across both hooks: distinct query keys must not dedupe.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      );
    }

    const claude = renderHook(() => useModels({ runtime: 'claude-code' }), { wrapper: Wrapper });
    const codex = renderHook(() => useModels({ runtime: 'codex' }), { wrapper: Wrapper });

    await waitFor(() => {
      expect(claude.result.current.data).toEqual(mockModels);
      expect(codex.result.current.data).toEqual(codexModels);
    });

    // Each runtime resolved independently — no stale cross-runtime cache hit.
    expect(getModels).toHaveBeenCalledWith({ sessionId: undefined, runtime: 'claude-code' });
    expect(getModels).toHaveBeenCalledWith({ sessionId: undefined, runtime: 'codex' });
    expect(getModels).toHaveBeenCalledTimes(2);
  });
});
