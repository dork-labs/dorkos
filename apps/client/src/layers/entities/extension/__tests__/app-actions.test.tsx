// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SidebarPrefs } from '@dorkos/shared/config-schema';

const prefs = vi.hoisted(() => ({ value: {} as Partial<SidebarPrefs> }));
const toast = vi.hoisted(() => vi.fn());
const requestInbox = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const openSettings = vi.hoisted(() => vi.fn());
const remount = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/layers/entities/config', () => ({
  useSidebarPrefs: () => prefs.value,
  useUpdateSidebarPrefs: () => ({
    update: (updater: (prev: SidebarPrefs) => SidebarPrefs) => {
      prefs.value = updater(prefs.value as SidebarPrefs);
    },
  }),
}));
vi.mock('@/layers/entities/notifications', () => ({ requestInbox }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouter: () => ({ navigate }),
}));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ open: openSettings }),
}));
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  requestExtensionRemount: remount,
}));

import { PIN_CAP_TOAST, useAppPins } from '../model/use-app-catalog';
import { useAppActions } from '../model/use-app-actions';
import { extensionQueryKeys } from '../model/use-pending-extension-approvals';

/** A provider whose extension list answers what the test seeds. */
function withClient(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
  prefs.value = {};
});

describe('useAppPins', () => {
  it('pins at the end, and refuses a sixth pin with the toast, storing nothing', () => {
    const { result } = renderHook(() => useAppPins());
    for (const id of ['a', 'b', 'c', 'd', 'e']) act(() => result.current.pin(id));
    expect(prefs.value.pinnedApps).toEqual(['a', 'b', 'c', 'd', 'e']);
    act(() => result.current.pin('f'));
    expect(prefs.value.pinnedApps).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(toast).toHaveBeenCalledWith(PIN_CAP_TOAST);
  });

  it('pins an app once, and unpins it', () => {
    const { result } = renderHook(() => useAppPins());
    act(() => result.current.pin('a'));
    act(() => result.current.pin('a'));
    expect(prefs.value.pinnedApps).toEqual(['a']);
    act(() => result.current.unpin('a'));
    expect(prefs.value.pinnedApps).toEqual([]);
  });
});

describe('useAppActions', () => {
  /** The hook, with the list answering `records` after a retry. */
  function setup(records: unknown[] = []) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(extensionQueryKeys.list(), records);
    vi.spyOn(client, 'refetchQueries').mockResolvedValue(undefined);
    return renderHook(() => useAppActions(), { wrapper: withClient(client) });
  }

  it('opens a running app’s page', () => {
    const { result } = setup();
    result.current.open({ id: 'board', path: 'today', state: 'ok' });
    expect(navigate).toHaveBeenCalledWith({ href: '/x/board/today' });
  });

  it('opens a held app’s approval card, and never its page', () => {
    const { result } = setup();
    result.current.open({ id: 'radar', path: '', state: 'held' });
    expect(requestInbox).toHaveBeenCalledWith(undefined, { focus: 'radar' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens an off app’s Settings row, where its switch is', () => {
    const { result } = setup();
    result.current.open({ id: 'old', path: '', state: 'off' });
    expect(openSettings).toHaveBeenCalledWith('extensions', 'old');
  });

  it('tries a broken app again, and opens Settings only when it still is not working', async () => {
    const broken = { id: 'w', status: 'activate_error', origin: 'user', approvedToRun: true };
    const { result } = setup([broken]);
    await act(() => result.current.tryAgain('w'));
    expect(remount).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledWith('extensions', 'w');

    const fixed = setup([{ ...broken, status: 'active' }]);
    openSettings.mockClear();
    await act(() => fixed.result.current.tryAgain('w'));
    expect(openSettings).not.toHaveBeenCalled();
  });
});
