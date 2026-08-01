/**
 * @vitest-environment jsdom
 */
/**
 * The banner's freshness contract.
 *
 * The aggregate is fetched once and then kept honest by two server signals. A
 * typo in either name is the exact failure this file exists to catch, and it is
 * invisible everywhere else: `StreamManager` drops a frame nobody subscribed to
 * in silence, so a misspelled name looks the same as a banner that was never
 * built — the standing signal simply never appears after somebody dials a task
 * or an integration up to Full autonomy.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

/** Handlers registered through `useEventSubscription`, by event name. */
const handlers = new Map<string, () => void>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (name: string, handler: () => void) => {
      handlers.set(name, handler);
    },
  };
});

import { useUnattendedAutonomy, useUnattendedAutonomySync } from '../model/use-unattended-autonomy';

afterEach(() => {
  cleanup();
  handlers.clear();
});

/** A provider tree with a transport whose aggregate the test controls. */
function harness(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useUnattendedAutonomy', () => {
  it('asks the server for the aggregate, not for the binding and task lists', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getUnattendedAutonomy).mockResolvedValue({
      drivers: [{ kind: 'task', id: 't1', name: 'Nightly cleanup' }],
    });

    const { result } = renderHook(() => useUnattendedAutonomy(), {
      wrapper: harness(transport),
    });

    await waitFor(() => expect(result.current?.drivers).toHaveLength(1));
    expect(vi.mocked(transport.listTasks)).not.toHaveBeenCalled();
    expect(vi.mocked(transport.getBindings)).not.toHaveBeenCalled();
  });

  it('re-reads when the server says bindings, tasks, or integrations moved', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getUnattendedAutonomy).mockResolvedValue({ drivers: [] });
    const wrapper = harness(transport);

    const { result } = renderHook(
      () => {
        useUnattendedAutonomySync();
        return useUnattendedAutonomy();
      },
      { wrapper }
    );

    await waitFor(() => expect(result.current).toEqual({ drivers: [] }));
    expect(vi.mocked(transport.getUnattendedAutonomy)).toHaveBeenCalledTimes(1);

    handlers.get('relay_bindings_changed')!();
    await waitFor(() =>
      expect(vi.mocked(transport.getUnattendedAutonomy)).toHaveBeenCalledTimes(2)
    );

    handlers.get('tasks_changed')!();
    await waitFor(() =>
      expect(vi.mocked(transport.getUnattendedAutonomy)).toHaveBeenCalledTimes(3)
    );

    // The one that is easy to forget: switching an integration off makes every
    // binding behind it inert without touching a binding row.
    handlers.get('relay_adapters_changed')!();
    await waitFor(() =>
      expect(vi.mocked(transport.getUnattendedAutonomy)).toHaveBeenCalledTimes(4)
    );
  });
});
