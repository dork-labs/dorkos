/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useEventSubscription: vi.fn(),
}));

import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { extensionQueryKeys } from '@/layers/entities/extension';
import {
  devLinkKey,
  marketplaceKeys,
  useDevLinkReloadStore,
  useDevLinkReloadSync,
  useLinkFolder,
} from '../index';

let transport: Transport;

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { invalidate, wrapper };
}

beforeEach(() => {
  transport = createMockTransport();
  useDevLinkReloadStore.setState({ latest: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useDevLinkReloadSync', () => {
  it('keeps the reload and refreshes the installed, dev link and extension lists', () => {
    // Purpose: the reload event is what makes the badge and lists current (spec §6).
    let deliver: ((data: unknown) => void) | undefined;
    vi.mocked(useEventSubscription).mockImplementation((name, handler) => {
      if (name === 'marketplace_dev_link_reloaded') deliver = handler;
    });
    const { invalidate, wrapper } = setup();
    renderHook(() => useDevLinkReloadSync(), { wrapper });

    const event = {
      name: 'flow',
      scope: 'project' as const,
      projectPath: '/work/app',
      at: '2026-10-03T12:00:00.000Z',
      actions: ['projection' as const],
    };
    act(() => deliver!(event));

    expect(useDevLinkReloadStore.getState().latest[devLinkKey(event)]).toEqual(event);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [...marketplaceKeys.all, 'installed'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: extensionQueryKeys.all });
  });

  it('drops a payload that is not a reload', () => {
    let deliver: ((data: unknown) => void) | undefined;
    vi.mocked(useEventSubscription).mockImplementation((_name, handler) => {
      deliver = handler;
    });
    const { invalidate, wrapper } = setup();
    renderHook(() => useDevLinkReloadSync(), { wrapper });

    act(() => deliver!({ name: 'flow' }));

    expect(useDevLinkReloadStore.getState().latest).toEqual({});
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('useLinkFolder', () => {
  it('refreshes the lists only when the folder was actually linked', async () => {
    // Purpose: a pending approval changed nothing, so nothing is refetched.
    vi.mocked(transport.linkDevLink).mockResolvedValue({
      status: 'approval_required',
      approval: {} as never,
    });
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useLinkFolder(), { wrapper });

    await act(() => result.current.mutateAsync({ path: '/work/flow', scope: 'global' }));

    expect(invalidate).not.toHaveBeenCalled();
  });
});
