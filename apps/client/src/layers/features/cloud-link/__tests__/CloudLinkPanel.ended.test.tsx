/**
 * @vitest-environment jsdom
 *
 * A link that ends somewhere else (the account was deleted, or this computer
 * was unlinked on the web) and the check that finds it (DOR-2651).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { connectorKeys } from '@/layers/entities/connectors';
import { CloudLinkPanel } from '../ui/CloudLinkPanel';
import { cloudStatusKey, useCheckCloudLink } from '../model/use-cloud-link';

const LINKED = { linked: true, accountLabel: 'kai@dork.dev', lastHeartbeatAt: null };
const UNLINKED = { linked: false, accountLabel: null, lastHeartbeatAt: null };

function wrapperFor(transport: Transport, queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('a link that ended somewhere else', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('returns the panel to signed out once the shared summary reads unlinked', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCloudStatus).mockResolvedValue(LINKED);
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({
      state: 'linked',
      accountLabel: 'kai@dork.dev',
    });
    const queryClient = newClient();
    const Wrapper = wrapperFor(transport, queryClient);
    render(
      <Wrapper>
        <CloudLinkPanel signedOut={<p>What an account adds here</p>}>
          <p>Plan sections</p>
        </CloudLinkPanel>
      </Wrapper>
    );
    expect(await screen.findByText('kai@dork.dev')).toBeInTheDocument();

    // The server has since dropped the key, and its note was dismissed.
    vi.mocked(transport.getCloudLinkStatus).mockResolvedValue({ state: 'idle' });
    vi.mocked(transport.getCloudStatus).mockResolvedValue(UNLINKED);
    act(() => {
      queryClient.setQueryData(cloudStatusKey, UNLINKED);
    });

    expect(await screen.findByText('What an account adds here')).toBeInTheDocument();
    expect(screen.queryByText('kai@dork.dev')).not.toBeInTheDocument();
    expect(screen.queryByText('Plan sections')).not.toBeInTheDocument();
  });
});

describe('useCheckCloudLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a link that still holds into the shared summary, touching nothing else', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.checkCloudLink).mockResolvedValue(LINKED);
    const queryClient = newClient();
    queryClient.setQueryData(connectorKeys.providers(), []);
    const { result } = renderHook(() => useCheckCloudLink(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    await expect(result.current({ expected: true })).resolves.toEqual(LINKED);
    expect(queryClient.getQueryData(cloudStatusKey)).toEqual(LINKED);
    expect(transport.cancelCloudLink).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(connectorKeys.providers())?.isInvalidated).toBe(false);
  });

  it('settles an ended link: the summary, the account reads, and the note when it was expected', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.checkCloudLink).mockResolvedValue(UNLINKED);
    const order: string[] = [];
    vi.mocked(transport.cancelCloudLink).mockImplementation(async () => {
      order.push('cancel');
      return { state: 'idle' };
    });
    const queryClient = newClient();
    queryClient.setQueryData(cloudStatusKey, LINKED);
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.queryKey === cloudStatusKey)
        order.push('summary');
    });
    queryClient.setQueryData(connectorKeys.providers(), []);
    const { result } = renderHook(() => useCheckCloudLink(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    await expect(result.current({ expected: true })).resolves.toEqual(UNLINKED);
    expect(queryClient.getQueryData(cloudStatusKey)).toEqual(UNLINKED);
    expect(queryClient.getQueryState(connectorKeys.providers())?.isInvalidated).toBe(true);
    // The note goes before the summary moves, so the panel never shows it.
    expect(order[0]).toBe('cancel');
  });

  it('leaves the note alone for a link it did not expect to end', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.checkCloudLink).mockResolvedValue(UNLINKED);
    const { result } = renderHook(() => useCheckCloudLink(), {
      wrapper: wrapperFor(transport, newClient()),
    });
    await result.current();
    expect(transport.cancelCloudLink).not.toHaveBeenCalled();
  });

  it('answers null, and changes nothing, when this DorkOS cannot be asked', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.checkCloudLink).mockRejectedValue(new Error('offline'));
    const queryClient = newClient();
    queryClient.setQueryData(cloudStatusKey, LINKED);
    const { result } = renderHook(() => useCheckCloudLink(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await expect(result.current({ expected: true })).resolves.toBeNull();
    await waitFor(() => expect(queryClient.getQueryData(cloudStatusKey)).toEqual(LINKED));
    expect(transport.cancelCloudLink).not.toHaveBeenCalled();
  });
});
