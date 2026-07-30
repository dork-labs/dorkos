/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useEngagedWindow } from '../model/use-engaged-window';

function createHarness(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function serverConfig(rooms: ServerConfig['rooms']): ServerConfig {
  return { rooms } as unknown as ServerConfig;
}

describe('useEngagedWindow', () => {
  it('reports the ceilings this install is actually running', () => {
    const transport = createMockTransport({ getConfig: vi.fn().mockResolvedValue({}) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(
      configKeys.current(),
      serverConfig({ engagedWindowMinutes: 3, engagedWindowPosts: 2 })
    );

    const { result } = renderHook(() => useEngagedWindow(), { wrapper });

    expect(result.current).toEqual({ engagedWindowMinutes: 3, engagedWindowPosts: 2 });
  });

  it('answers "not yet" rather than substituting the shipped numbers', () => {
    // The one thing this selector must never do. The cockpit prints these
    // inside a sentence — "keeps answering for 10 more minutes" — so a
    // stand-in default is not a harmless placeholder, it is the UI stating
    // something false about somebody's own install. 10 and 5 are the shipped
    // values, and reading either of them here would be the bug.
    const transport = createMockTransport({ getConfig: vi.fn().mockResolvedValue({}) });
    const { wrapper } = createHarness(transport);

    const { result } = renderHook(() => useEngagedWindow(), { wrapper });

    expect(result.current).toBeNull();
  });

  it('answers "not yet" for a server too old to carry the block', () => {
    const transport = createMockTransport({ getConfig: vi.fn().mockResolvedValue({}) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), serverConfig(undefined));

    const { result } = renderHook(() => useEngagedWindow(), { wrapper });

    expect(result.current).toBeNull();
  });
});
