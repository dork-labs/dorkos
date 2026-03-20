// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useRelayEnabled } from '../model/use-relay-config';

function createWrapper(relayEnabled: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/test',
      nodeVersion: 'v20.0.0',
      claudeCliPath: null,
      tunnel: {
        enabled: false,
        connected: false,
        url: null,
        authEnabled: false,
        tokenConfigured: false,
      },
      relay: { enabled: relayEnabled },
    }),
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useRelayEnabled', () => {
  it('returns true when relay is enabled in config', async () => {
    const { result } = renderHook(() => useRelayEnabled(), {
      wrapper: createWrapper(true),
    });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('returns false when relay is disabled in config', async () => {
    const { result } = renderHook(() => useRelayEnabled(), {
      wrapper: createWrapper(false),
    });
    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it('returns false before config loads', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const transport = createMockTransport({
      getConfig: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useRelayEnabled(), { wrapper });
    expect(result.current).toBe(false);
  });
});
