/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import { useTasksEnabled } from '../model/use-tasks-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useTasksEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when tasks.enabled is true', async () => {
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
        tasks: { enabled: true },
      }),
    });

    const { result } = renderHook(() => useTasksEnabled(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('returns false when tasks.enabled is false', async () => {
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
        tasks: { enabled: false },
      }),
    });

    const { result } = renderHook(() => useTasksEnabled(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      // Query resolves, tasks.enabled is false
      expect(transport.getConfig).toHaveBeenCalledTimes(1);
    });

    expect(result.current).toBe(false);
  });

  it('returns false when tasks field is undefined in config', async () => {
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
        // no tasks field
      }),
    });

    const { result } = renderHook(() => useTasksEnabled(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(transport.getConfig).toHaveBeenCalledTimes(1);
    });

    expect(result.current).toBe(false);
  });

  it('returns false while config is loading', () => {
    const transport = createMockTransport({
      // Never resolves, simulating loading state
      getConfig: vi.fn().mockReturnValue(new Promise(() => {})),
    });

    const { result } = renderHook(() => useTasksEnabled(), {
      wrapper: createWrapper(transport),
    });

    // Before the query resolves, should default to false
    expect(result.current).toBe(false);
  });
});
