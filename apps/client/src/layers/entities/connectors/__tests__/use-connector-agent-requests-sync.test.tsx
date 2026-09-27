// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const handlers = new Map<string, (data: unknown) => void>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (event: string, handler: (data: unknown) => void) => {
      handlers.set(event, handler);
    },
  };
});

import { useConnectorAgentRequestsSync } from '../model/use-connector-agent-requests-sync';

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  handlers.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('useConnectorAgentRequestsSync', () => {
  it('re-reads every agent request cache once per burst of changes', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useConnectorAgentRequestsSync(250), { wrapper });

    expect([...handlers.keys()]).toEqual(['connector_agent_requests_changed']);
    handlers.get('connector_agent_requests_changed')!({ changedAt: 'a' });
    handlers.get('connector_agent_requests_changed')!({ changedAt: 'b' });
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    // A prefix: the owner lists, each conversation's list and each request.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connectors', 'agent-requests'] });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
