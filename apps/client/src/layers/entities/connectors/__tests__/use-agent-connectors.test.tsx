/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  useAgentConnectors,
  useAttachAgentConnector,
  useDetachAgentConnector,
} from '../model/use-agent-connectors';

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

describe('useAgentConnectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the standing attachments for an agent', async () => {
    const rows = [{ agentId: 'dorkbot', accountId: 'acc-1', attachedAt: '2026-08-03T10:00:00Z' }];
    const transport = createMockTransport({
      getAgentConnectors: vi.fn().mockResolvedValue(rows),
    });

    const { result } = renderHook(() => useAgentConnectors('dorkbot'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.getAgentConnectors).toHaveBeenCalledWith('dorkbot');
    expect(result.current.data).toEqual(rows);
  });

  it('makes no request without an agent', () => {
    const transport = createMockTransport({
      getAgentConnectors: vi.fn().mockResolvedValue([]),
    });

    renderHook(() => useAgentConnectors(null), { wrapper: createWrapper(transport) });

    expect(transport.getAgentConnectors).not.toHaveBeenCalled();
  });
});

describe('agent attachment writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attach returns the custody disclosure the consent point must show', async () => {
    const receipt = {
      account: { accountId: 'acc-1', toolkit: 'gmail', label: 'work', status: 'active' as const },
      disclosure: 'Your sign-ins live in Composio’s vault, not on this machine.',
    };
    const transport = createMockTransport({
      attachAgentConnector: vi.fn().mockResolvedValue(receipt),
    });

    const { result } = renderHook(() => useAttachAgentConnector(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ agentId: 'dorkbot', accountId: 'acc-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.attachAgentConnector).toHaveBeenCalledWith('dorkbot', 'acc-1');
    expect(result.current.data?.disclosure).toBe(receipt.disclosure);
  });

  it('detach passes both ids through', async () => {
    const transport = createMockTransport({
      detachAgentConnector: vi.fn().mockResolvedValue(undefined),
    });

    const { result } = renderHook(() => useDetachAgentConnector(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ agentId: 'dorkbot', accountId: 'acc-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.detachAgentConnector).toHaveBeenCalledWith('dorkbot', 'acc-1');
  });
});
