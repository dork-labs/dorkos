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
  useUnlinkDevLink,
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
    // `errors` that is not a list of sentences would crash the Details list.
    act(() =>
      deliver!({
        name: 'flow',
        scope: 'global',
        at: '2026-10-03T12:00:00.000Z',
        actions: [],
        errors: 'boom',
      })
    );

    expect(useDevLinkReloadStore.getState().latest).toEqual({});
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('a stale reload after unlinking and linking again', () => {
  const FAILED = {
    name: 'flow',
    scope: 'global' as const,
    at: '2026-10-03T12:00:00.000Z',
    actions: ['extension' as const],
    errors: ["x didn't build: y"],
  };

  it('is forgotten when the link is removed, and again when it is made', async () => {
    // Purpose: unlink, then relink, never shows the earlier link's build error.
    vi.mocked(transport.unlinkDevLink).mockResolvedValue({ restored: 'removed' });
    vi.mocked(transport.linkDevLink).mockResolvedValue({
      status: 'linked',
      link: {
        name: 'flow',
        type: 'plugin',
        scope: 'global',
        path: '/work/flow',
        state: 'active',
        parked: null,
        linkedAt: '2026-10-03T12:05:00.000Z',
      },
    });
    const { wrapper } = setup();
    const unlink = renderHook(() => useUnlinkDevLink(), { wrapper });
    const link = renderHook(() => useLinkFolder(), { wrapper });
    const key = devLinkKey(FAILED);

    useDevLinkReloadStore.getState().record(FAILED);
    await act(() => unlink.result.current.mutateAsync({ name: 'flow', scope: 'global' }));
    expect(useDevLinkReloadStore.getState().latest[key]).toBeUndefined();

    useDevLinkReloadStore.getState().record(FAILED);
    await act(() => link.result.current.mutateAsync({ path: '/work/flow', scope: 'global' }));
    expect(useDevLinkReloadStore.getState().latest[key]).toBeUndefined();
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
