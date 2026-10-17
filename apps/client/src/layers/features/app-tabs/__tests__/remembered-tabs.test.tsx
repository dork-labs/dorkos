/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TransportProvider, useAppTabsStore, type AppTab } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';

const navigate = vi.fn((_options: { href: string }) => Promise.resolve());
let locationHref = '/';
const router = {
  navigate: (options: { href: string }) => {
    locationHref = options.href;
    return navigate(options);
  },
  get state() {
    return { location: { href: locationHref } };
  },
};

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouter: () => router,
}));

import { findMissingTabs } from '../lib/missing-tabs';
import { useAppTabActions } from '../model/use-app-tab-actions';
import { usePruneMissingTabs } from '../model/use-prune-missing-tabs';
import { useRecentlyClosed, useRecentlyClosedSync } from '../model/recently-closed';

function tab(id: string, href = `/${id}`): AppTab {
  return { id, href, history: [href], cursor: 0 };
}

function setTabs(tabs: AppTab[], activeTabId = tabs[0].id): void {
  useAppTabsStore.setState({ tabs, activeTabId });
}

function hrefs(): string[] {
  return useAppTabsStore.getState().tabs.map((t) => t.href);
}

/** A desktop bridge with a tab session made of spies. */
function installBridge(overrides: Partial<NonNullable<ElectronAPI['tabSession']>> = {}) {
  const tabSession = {
    getInitial: vi.fn(() => null),
    save: vi.fn(),
    recordClosed: vi.fn(),
    reopen: vi.fn(() => Promise.resolve(null)),
    getRecentlyClosed: vi.fn(() => Promise.resolve([])),
    onRecentlyClosedChange: vi.fn(() => () => {}),
    getStartupMode: vi.fn(() => Promise.resolve('reopen' as const)),
    setStartupMode: vi.fn((mode: DesktopStartupMode) => Promise.resolve(mode)),
    ...overrides,
  };
  window.electronAPI = { getServerPort: () => 4242, tabSession } as unknown as ElectronAPI;
  return tabSession;
}

/** A transport error the way `fetchJSON` throws one. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

beforeEach(() => {
  navigate.mockClear();
  locationHref = '/';
});

afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

describe('closing tabs files them under Recently closed', () => {
  it('reports a closed tab with the index it sat at', () => {
    const bridge = installBridge();
    setTabs([tab('a'), tab('b'), tab('c')], 'b');
    const { result } = renderHook(() => useAppTabActions());
    result.current.close('b');
    expect(bridge.recordClosed).toHaveBeenCalledWith([{ tab: tab('b'), index: 1 }]);
  });

  it('reports every tab Close others took, and none it kept', () => {
    const bridge = installBridge();
    setTabs([{ ...tab('p'), pinned: true }, tab('a'), tab('b'), tab('c')], 'b');
    const { result } = renderHook(() => useAppTabActions());
    result.current.closeOthers('b');
    expect(bridge.recordClosed).toHaveBeenCalledWith([
      { tab: tab('a'), index: 1 },
      { tab: tab('c'), index: 3 },
    ]);
  });

  it('reports nothing when the last tab refuses to close', () => {
    const bridge = installBridge();
    setTabs([tab('a')]);
    const { result } = renderHook(() => useAppTabActions());
    expect(result.current.closeActive()).toBe(false);
    expect(bridge.recordClosed).not.toHaveBeenCalled();
  });

  it('reopens entry n of Recently closed into this window', async () => {
    const bridge = installBridge({
      reopen: vi.fn(() => Promise.resolve({ tab: tab('z'), index: 0, closedAt: 1 })),
    });
    setTabs([tab('a')]);
    const { result } = renderHook(() => useAppTabActions());
    result.current.reopenClosed(3);
    await waitFor(() => expect(hrefs()).toEqual(['/z', '/a']));
    expect(bridge.reopen).toHaveBeenCalledWith(3);
    expect(navigate).toHaveBeenCalledWith({ href: '/z' });
  });

  it('does nothing outside the desktop app', async () => {
    setTabs([tab('a')]);
    const { result } = renderHook(() => useAppTabActions());
    result.current.reopenClosed();
    await Promise.resolve();
    expect(hrefs()).toEqual(['/a']);
  });
});

describe('useRecentlyClosedSync', () => {
  it('reads the list once and follows every change from any window', async () => {
    let push: (list: DesktopClosedTab[]) => void = () => {};
    const first = [{ tab: tab('a'), index: 0, closedAt: 1 }];
    installBridge({
      getRecentlyClosed: vi.fn(() => Promise.resolve(first)),
      onRecentlyClosedChange: vi.fn((cb: (list: DesktopClosedTab[]) => void) => {
        push = cb;
        return () => {};
      }),
    });
    renderHook(() => useRecentlyClosedSync());
    const { result } = renderHook(() => useRecentlyClosed());
    await waitFor(() => expect(result.current).toEqual(first));
    push([]);
    await waitFor(() => expect(result.current).toEqual([]));
  });
});

describe('findMissingTabs', () => {
  it('finds a deleted chat and a room you left, and only on a definite 404', async () => {
    const tabs = [
      { id: '1', href: '/session?session=gone' },
      { id: '2', href: '/session?session=here' },
      { id: '3', href: '/channels?id=left' },
      { id: '4', href: '/session?session=flaky' },
      { id: '5', href: '/channels?id=forbidden' },
    ];
    const missing = await findMissingTabs(tabs, {
      getSession: (id) =>
        id === 'gone'
          ? Promise.reject(httpError(404))
          : id === 'flaky'
            ? Promise.reject(new Error('network down'))
            : Promise.resolve({}),
      getRoom: (id) => Promise.reject(httpError(id === 'left' ? 404 : 403)),
    });
    expect([...missing].sort()).toEqual(['1', '3']);
  });

  it('never asks about a draft chat, a community room, or a page with no target', async () => {
    const getSession = vi.fn(() => Promise.reject(httpError(404)));
    const getRoom = vi.fn(() => Promise.reject(httpError(404)));
    const missing = await findMissingTabs(
      [
        { id: '1', href: '/session?session=new&draft=1' },
        { id: '2', href: '/channels?id=r&community=c' },
        { id: '3', href: '/team' },
      ],
      { getSession, getRoom }
    );
    expect(missing.size).toBe(0);
    expect(getSession).not.toHaveBeenCalled();
    expect(getRoom).not.toHaveBeenCalled();
  });

  it('asks about one chat once, however many tabs show it', async () => {
    const getSession = vi.fn(() => Promise.reject(httpError(404)));
    const missing = await findMissingTabs(
      [
        { id: '1', href: '/session?session=s' },
        { id: '2', href: '/session?session=s&settings=open' },
      ],
      { getSession, getRoom: vi.fn() }
    );
    expect(missing).toEqual(new Set(['1', '2']));
    expect(getSession).toHaveBeenCalledTimes(1);
  });
});

describe('usePruneMissingTabs', () => {
  function wrapperWith(transport: ReturnType<typeof createMockTransport>) {
    return ({ children }: { children: ReactNode }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    );
  }

  it('drops restored tabs whose page is gone, quietly, and follows the front tab', async () => {
    const bridge = installBridge();
    setTabs([tab('a', '/session?session=gone'), tab('b', '/team')], 'a');
    const transport = createMockTransport();
    vi.mocked(transport.getSession).mockRejectedValue(httpError(404));
    renderHook(() => usePruneMissingTabs(), { wrapper: wrapperWith(transport) });
    await waitFor(() => expect(hrefs()).toEqual(['/team']));
    expect(navigate).toHaveBeenCalledWith({ href: '/team' });
    // Nothing to reopen, so nothing filed.
    expect(bridge.recordClosed).not.toHaveBeenCalled();
  });

  it('checks nothing outside the desktop app', async () => {
    setTabs([tab('a', '/session?session=gone')]);
    const transport = createMockTransport();
    renderHook(() => usePruneMissingTabs(), { wrapper: wrapperWith(transport) });
    await Promise.resolve();
    expect(transport.getSession).not.toHaveBeenCalled();
  });
});
